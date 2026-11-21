// ─── منسّق التوليد (قسم 6) — التبديل التسلسلي الصارم «لا توقف أبدًا» ───
import { randomUUID } from "node:crypto";
import {
  getTask,
  insertTask,
  updateTask,
  getKey,
  type TaskRow,
} from "./turso";
import { getKeyPool, bumpKeyAfterAttempt, applyErrorClassToKey } from "./keys";
import { getAdapter } from "./adapters";
import { MODELS, resolveModel, type ModelDef } from "./models";
import { ProviderError, isKeyOrBalanceFailure, publicErrorMessage } from "./errors";
import type { GenerateInput } from "./providers/types";
import { mergerClient, processInFlight, MergerHttpError, MergerUnavailableError } from "./merger";

// أخطاء خاصة يتعامل معها MCP layer برسائل عربية محددة
export class NoKeysError extends Error {
  constructor(model: string) {
    super(`لا توجد مفاتيح نشطة لخدمة ${model}`);
    this.name = "NoKeysError";
  }
}
export class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamsError";
  }
}
export class MergeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeInputError";
  }
}
export class TaskNotFoundError extends Error {
  constructor() {
    super("لا توجد مهمة بهذا المعرّف");
    this.name = "TaskNotFoundError";
  }
}

interface Attempt {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nowIso(): string {
  return new Date().toISOString();
}

async function appendAttempt(taskId: string, attempt: Attempt): Promise<void> {
  const t = await getTask(taskId);
  const arr: Attempt[] = JSON.parse(t?.attempts_json || "[]");
  arr.push(attempt);
  await updateTask(taskId, { attempts_json: JSON.stringify(arr) });
}

// تهيئة قفل الاستعلام المتزامن لكل مهمة (best-effort داخل نفس العملية)
const refreshLocks = new Map<string, Promise<TaskRow | null>>();

function ageSeconds(iso: string | null | undefined): number {
  if (!iso) return 999;
  // صيغة datetime('now') في SQLite: "YYYY-MM-DD HH:MM:SS" بالتوقيت العالمي
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  return (Date.now() - new Date(normalized).getTime()) / 1000;
}

// ─── محاولة الإنشاء على المفاتيح بالترتيب الصارم (4.3.1) ───
// كل محاولة تُسجَّل، وعدّادات المفتاح تتحدث دائمًا. params → توقف فورًا.
async function tryCreateOnPool(
  taskId: string,
  modelDef: ModelDef,
  input: GenerateInput,
  type: "image" | "video"
): Promise<{ created: boolean; provider?: string; providerTaskId?: string; keyId?: string }> {
  const pool = await getKeyPool(modelDef.providers);
  for (const key of pool) {
    const adapter = getAdapter(key.provider as ModelDef["providers"][number]);
    const providerModel = modelDef.providerModel[key.provider as keyof typeof modelDef.providerModel];
    try {
      let providerTaskId: string | undefined;
      let syncUrls: string[] | undefined;
      if (type === "image" && adapter.createImageSync) {
        const r = await adapter.createImageSync(key.api_key, providerModel, input);
        syncUrls = r.urls;
      } else {
        providerTaskId = (await adapter.createTask(key.api_key, providerModel, input)).providerTaskId;
      }
      await bumpKeyAfterAttempt(key.id, true);
      await appendAttempt(taskId, {
        provider: key.provider,
        keyId: key.id,
        keyLabel: key.label || key.id.slice(0, 8),
        ok: true,
        at: nowIso(),
      });
      if (syncUrls) {
        // صور متزامنة اكتملت فورًا
        await updateTask(taskId, {
          provider: key.provider,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(syncUrls),
        });
      } else {
        await updateTask(taskId, {
          provider: key.provider,
          provider_task_id: providerTaskId,
          key_id: key.id,
          status: "processing",
          progress: 5,
          error_message: null,
        });
      }
      return { created: true, provider: key.provider, providerTaskId, keyId: key.id };
    } catch (err) {
      const cls = await applyErrorClassToKey(key, err);
      const msg = err instanceof Error ? err.message : String(err);
      await bumpKeyAfterAttempt(key.id, false, msg);
      await appendAttempt(taskId, {
        provider: key.provider,
        keyId: key.id,
        keyLabel: key.label || key.id.slice(0, 8),
        ok: false,
        errorClass: cls,
        error: msg.slice(0, 400),
        at: nowIso(),
      });
      if (cls === "params") {
        // خطأ معطيات: تبديل المفاتيح لن يحله — توقف فورًا (4.2)
        throw new ParamsError(`المعطيات غير مدعومة لدى المزود: ${publicErrorMessage(msg)}`);
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي
    }
  }
  return { created: false };
}

// ─── إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي (4.3.2) ───
async function midTaskFailover(
  taskId: string,
  modelDef: ModelDef,
  input: GenerateInput,
  type: "image" | "video",
  failedKeyId: string,
  failedMsg: string
): Promise<boolean> {
  // علّم المفتاح الفاشل حسب رسالة المزود (نفاد/رفض) — ثم جرّب البقية بالترتيب
  const failedKey = failedKeyId ? await getKey(failedKeyId) : null;
  if (failedKey) {
    await applyErrorClassToKey(failedKey, new ProviderError(0, failedMsg));
  }
  const r = await tryCreateOnPool(taskId, modelDef, input, type);
  if (r.created) return true;
  await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
  return false;
}

function parseParams(t: TaskRow): { input: GenerateInput; urls: string[]; waitSeconds: number } {
  try {
    const p = JSON.parse(t.params_json || "{}");
    return {
      input: p.input ?? { prompt: "" },
      urls: Array.isArray(p.urls) ? p.urls : [],
      waitSeconds: p.waitSeconds ?? 0,
    };
  } catch {
    return { input: { prompt: "" }, urls: [], waitSeconds: 0 };
  }
}

function resultUrls(t: TaskRow): string[] {
  try {
    const arr = JSON.parse(t.result_urls_json || "[]");
    return Array.isArray(arr) ? arr.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

// ─── التدفق الرئيسي للتوليد (قسم 6) ───
export async function runGeneration(opts: {
  type: "image" | "video";
  model?: string;
  input: GenerateInput;
  waitSeconds: number;
  onProgress?: (percent: number, message: string) => void;
}): Promise<TaskRow> {
  const { type, input, onProgress } = opts;
  const modelDef = resolveModel(opts.model);
  if (!modelDef || modelDef.type !== type) {
    throw new ParamsError(
      `موديل غير معروف: ${opts.model ?? "(فارغ)"} — المتاح: ${Object.keys(MODELS).join(", ")}`
    );
  }
  const pool = await getKeyPool(modelDef.providers);
  if (!pool.length) {
    throw new NoKeysError(modelDef.canonical);
  }

  // سجّل المهمة في Turso قبل أي نداء خارجي
  const taskId = randomUUID();
  const task = await insertTask({
    id: taskId,
    model: modelDef.canonical,
    type,
    prompt: input.prompt.slice(0, 2000),
    params_json: JSON.stringify({ input, waitSeconds: opts.waitSeconds }),
    status: "pending",
    progress: 0,
  });

  let r: Awaited<ReturnType<typeof tryCreateOnPool>>;
  try {
    r = await tryCreateOnPool(taskId, modelDef, input, type);
  } catch (e) {
    if (e instanceof ParamsError) {
      await updateTask(taskId, { status: "failed", error_message: e.message });
    }
    throw e;
  }

  if (!r.created) {
    // فشل على كل المفاتيح → تبقى processing وتُعاد المحاولة مع كل get_task (4.3.3)
    await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
    return (await getTask(taskId))!;
  }

  // نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم
  const deadline = Date.now() + opts.waitSeconds * 1000;
  let key = r.keyId ? await getKey(r.keyId) : null;
  let providerTaskId = r.providerTaskId!;
  let currentProgress = 5;

  while (Date.now() < deadline) {
    await sleep(3000);
    if (!key) break;
    const adapter = getAdapter(key.provider as ModelDef["providers"][number]);
    let st;
    try {
      st = await adapter.checkTask(key.api_key, providerTaskId);
    } catch (err) {
      const cls = await applyErrorClassToKey(key, err);
      const msg = err instanceof Error ? err.message : String(err);
      if (cls === "disabled" || cls === "exhausted") {
        const ok = await midTaskFailover(taskId, modelDef, input, type, key.id, msg);
        if (!ok) return (await getTask(taskId))!;
        const fresh = (await getTask(taskId))!;
        key = fresh.key_id ? await getKey(fresh.key_id) : null;
        providerTaskId = fresh.provider_task_id!;
        continue;
      }
      if (cls === "params") {
        await updateTask(taskId, { status: "failed", error_message: publicErrorMessage(msg) });
        return (await getTask(taskId))!;
      }
      continue; // temporary/provider → استمر بالاستعلام
    }

    if (st.status === "completed" && st.urls?.length) {
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify(st.urls),
      });
      onProgress?.(100, "اكتمل التوليد بنجاح");
      return (await getTask(taskId))!;
    }
    if (st.status === "failed") {
      const msg = st.error || "فشل غير معروف";
      if (isKeyOrBalanceFailure(msg)) {
        const ok = await midTaskFailover(taskId, modelDef, input, type, key.id, msg);
        if (!ok) return (await getTask(taskId))!;
        const fresh = (await getTask(taskId))!;
        key = fresh.key_id ? await getKey(fresh.key_id) : null;
        providerTaskId = fresh.provider_task_id!;
        continue;
      }
      // فشل حقيقي (سياسة/معطيات) → failed نهائي
      await updateTask(taskId, { status: "failed", error_message: publicErrorMessage(msg) });
      return (await getTask(taskId))!;
    }
    // قيد المعالجة — تقدم أحادي الاتجاه
    currentProgress = Math.max(currentProgress, st.progress ?? 0, Math.min(95, currentProgress + 3));
    await updateTask(taskId, { progress: currentProgress });
    onProgress?.(currentProgress, `قيد التوليد… ${currentProgress}%`);
  }

  // انتهت النافذة والنتيجة لم تظهر → processing وtask_id (6.7)
  return (await getTask(taskId))!;
}

// ─── تحديث حي عند get_task (قسم 6 — refreshTask) ───
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  const existing = refreshLocks.get(taskId);
  if (existing) return existing;
  const p = doRefreshTask(taskId).finally(() => refreshLocks.delete(taskId));
  refreshLocks.set(taskId, p);
  return p;
}

async function doRefreshTask(taskId: string): Promise<TaskRow | null> {
  let t = await getTask(taskId);
  if (!t) throw new TaskNotFoundError();
  if (t.status === "completed" || t.status === "failed") return t;

  if (t.type === "merge") return refreshMergeTask(t);

  const modelDef = resolveModel(t.model);
  if (!modelDef) return t;
  const { input } = parseParams(t);

  if (t.status === "pending" || !t.provider_task_id) {
    // فشل الإنشاء سابقًا — أعد المحاولة مع تهدئة ~45 ثانية (4.3.3)
    if (ageSeconds(t.updated_at) < 45) return t;
    try {
      const r = await tryCreateOnPool(taskId, modelDef, input, t.type as "image" | "video");
      if (!r.created) {
        await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
      }
    } catch (e) {
      if (e instanceof ParamsError) {
        await updateTask(taskId, { status: "failed", error_message: e.message });
      }
    }
    return (await getTask(taskId))!;
  }

  // مهمة جارية لدى المزود — استعلم مرة واحدة
  const key = t.key_id ? await getKey(t.key_id) : null;
  if (!key) {
    await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
    return (await getTask(taskId))!;
  }
  const adapter = getAdapter(key.provider as ModelDef["providers"][number]);
  try {
    const st = await adapter.checkTask(key.api_key, t.provider_task_id!);
    if (st.status === "completed" && st.urls?.length) {
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify(st.urls),
      });
    } else if (st.status === "failed") {
      const msg = st.error || "فشل غير معروف";
      if (isKeyOrBalanceFailure(msg)) {
        await midTaskFailover(taskId, modelDef, input, t.type as "image" | "video", key.id, msg);
      } else {
        await updateTask(taskId, { status: "failed", error_message: publicErrorMessage(msg) });
      }
    } else {
      const p = Math.max(t.progress, st.progress ?? 0);
      if (p !== t.progress) await updateTask(taskId, { progress: Math.min(95, p) });
    }
  } catch (err) {
    const cls = await applyErrorClassToKey(key, err);
    const msg = err instanceof Error ? err.message : String(err);
    if (cls === "disabled" || cls === "exhausted") {
      await midTaskFailover(taskId, modelDef, input, t.type as "image" | "video", key.id, msg);
    } else if (cls === "params") {
      await updateTask(taskId, { status: "failed", error_message: publicErrorMessage(msg) });
    }
    // temporary → يبقى processing ويُعاد الاستعلام في get_task القادمة
  }
  return (await getTask(taskId))!;
}

// ─── الدمج: runMerge (قسم 7.3) ───
export async function runMerge(opts: {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  onProgress?: (percent: number, message: string) => void;
}): Promise<TaskRow> {
  const details: string[] = [];
  const resolved: string[] = [];

  // حل روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها
  for (const tid of opts.taskIds ?? []) {
    const t = await getTask(tid.trim());
    if (!t) {
      details.push(`المعرّف ${tid} غير موجود في قاعدة البيانات`);
      continue;
    }
    if (t.status !== "completed") {
      details.push(`المهمة ${tid} ليست مكتملة (حالتها: ${t.status})`);
      continue;
    }
    const urls = resultUrls(t);
    if (!urls.length) {
      details.push(`المهمة ${tid} لا تحمل روابط نتائج`);
      continue;
    }
    resolved.push(urls[0]);
  }
  for (const u of opts.urls ?? []) {
    resolved.push(u.trim());
  }

  // تحقق صارم (7.3.1)
  if (resolved.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (details.length) msg += "\n\nتفاصيل المعرّفات غير الصالحة:\n- " + details.join("\n- ");
    throw new MergeInputError(msg);
  }
  if (resolved.length > 10) {
    throw new MergeInputError("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
  }
  const badUrl = resolved.find((u) => !/^https?:\/\//i.test(u));
  if (badUrl) {
    throw new MergeInputError(`❌ الرابط غير صالح — يجب أن يكون رابطًا مباشرًا عامًا http/https: ${badUrl}`);
  }
  if (!mergerClient.isConfigured()) {
    throw new MergeInputError("❌ خدمة الدمج غير مضبوطة على السيرفر (MERGER_API_BASE) — أبلغ مدير النظام.");
  }

  // سجّل مهمة الدمج أولًا (7.3.2)
  const taskId = randomUUID();
  const task = await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    provider: "merger",
    prompt: `دمج ${resolved.length} مقاطع`,
    params_json: JSON.stringify({ urls: resolved, waitSeconds: opts.waitSeconds }),
    status: "pending",
    progress: 0,
  });

  try {
    const { jobId } = await mergerClient.createJob(resolved);
    await updateTask(taskId, { provider_task_id: jobId, status: "processing", progress: 5 });
    // أطلق process خلفيًا وبمرة واحدة فقط (7.3.3)
    void fireProcessOnce(jobId);
  } catch (e) {
    if (e instanceof MergerHttpError) {
      // خطأ معلن من الخدمة = فشل نهائي فوري (7.3.5)
      await updateTask(taskId, { status: "failed", error_message: publicErrorMessage(e.message) });
      return (await getTask(taskId))!;
    }
    // خطأ شبكتنا = مؤقت — تبقى processing وتُعاد مع get_task
    await updateTask(taskId, { status: "processing", error_message: "بانتظار خدمة الدمج…" });
    return (await getTask(taskId))!;
  }

  // نافذة الانتظار مع بث تقدم (7.3.4)
  const deadline = Date.now() + opts.waitSeconds * 1000;
  const t0 = (await getTask(taskId))!;
  const jobId = t0.provider_task_id!;
  let currentProgress = 5;
  while (Date.now() < deadline) {
    await sleep(3000);
    let st;
    try {
      st = await mergerClient.getStatus(jobId);
    } catch (e) {
      if (e instanceof MergerHttpError) {
        await updateTask(taskId, { status: "failed", error_message: publicErrorMessage(e.message) });
        return (await getTask(taskId))!;
      }
      continue; // شبكة → مؤقت
    }
    if (st.status === "done" && st.url) {
      await updateTask(taskId, {
        status: "completed",
        result_urls_json: JSON.stringify([st.url]),
      });
      opts.onProgress?.(100, "اكتمل الدمج بنجاح");
      return (await getTask(taskId))!;
    }
    if (st.status === "failed") {
      await updateTask(taskId, { status: "failed", error_message: publicErrorMessage(st.error) });
      return (await getTask(taskId))!;
    }
    currentProgress = Math.max(currentProgress, Math.min(95, Math.max(10, st.progress)));
    await updateTask(taskId, { progress: currentProgress });
    opts.onProgress?.(currentProgress, `قيد الدمج… ${currentProgress}%`);
  }
  return (await getTask(taskId))!;
}

async function fireProcessOnce(jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  try {
    await mergerClient.processJob(jobId);
  } catch {
    /* النتيجة تُحدَّد من getStatus عند الاستعلام */
  } finally {
    processInFlight.delete(jobId);
  }
}

// ─── تحديث مهمة دمج عند get_task (7.3.6) ───
async function refreshMergeTask(t: TaskRow): Promise<TaskRow> {
  const { urls } = parseParams(t);
  const jobId = t.provider_task_id;

  if (!jobId) {
    // فشل إنشاء سابق — أعد المحاولة بعد تهدئة
    if (ageSeconds(t.updated_at) < 45) return t;
    try {
      const { jobId: newId } = await mergerClient.createJob(urls);
      await updateTask(t.id, { provider_task_id: newId, status: "processing", progress: 5 });
      void fireProcessOnce(newId);
    } catch (e) {
      if (e instanceof MergerHttpError) {
        await updateTask(t.id, { status: "failed", error_message: publicErrorMessage(e.message) });
      }
    }
    return (await getTask(t.id))!;
  }

  let st;
  try {
    st = await mergerClient.getStatus(jobId);
  } catch (e) {
    if (e instanceof MergerHttpError) {
      const msg =
        e.status === 404
          ? "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)"
          : publicErrorMessage(e.message);
      await updateTask(t.id, { status: "failed", error_message: msg });
    }
    // MergerUnavailable → مؤقت: يبقى processing
    return (await getTask(t.id))!;
  }

  if (st.status === "done" && st.url) {
    await updateTask(t.id, { status: "completed", result_urls_json: JSON.stringify([st.url]) });
  } else if (st.status === "failed") {
    await updateTask(t.id, { status: "failed", error_message: publicErrorMessage(st.error) });
  } else {
    // قيد المعالجة: إن لم يُنفَّذ process بعد فنفّذه الآن (7.3.6)
    void fireProcessOnce(jobId);
    const p = Math.max(t.progress, Math.min(95, Math.max(10, st.progress)));
    if (p !== t.progress) await updateTask(t.id, { progress: p });
  }
  return (await getTask(t.id))!;
}

// ─── صياغة الردود العربية للعميل (قسم 8) ───
export function publicView(t: TaskRow): {
  status: string;
  progress: number;
  urls: string[];
  message: string;
} {
  const urls = resultUrls(t);
  if (t.status === "completed") {
    let head: string;
    if (t.type === "image") {
      head = `✅ تم توليد الصورة بنجاح\n\n![image](${urls[0]})\n\nالرابط المباشر: ${urls[0]}`;
    } else if (t.type === "merge") {
      head = `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${urls[0]}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
    } else {
      head = `✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n${urls.map((u) => `- ${u}`).join("\n")}`;
    }
    return { status: "completed", progress: 100, urls, message: head };
  }
  if (t.status === "failed") {
    return {
      status: "failed",
      progress: 100,
      urls,
      message: `❌ فشلت المهمة: ${publicErrorMessage(t.error_message)}`,
    };
  }
  // processing / pending
  const waiting = t.error_message?.includes("بانتظار") ? "\n\n(بانتظار توفر مورد صالح — سيُعاد المحاولة تلقائيًا)" : "";
  return {
    status: "processing",
    progress: t.progress,
    urls,
    message: `⏳ المهمة قيد المعالجة — task_id: ${t.id}\nالتقدم: ${t.progress}%${waiting}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
  };
}
