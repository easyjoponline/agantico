// ─── مزود CometAPI (المزود الثاني — قسم 5.2) ───
// صور متزامنة عبر نقطة images المتوافقة مع OpenAI (تعيد الرابط فورًا)،
// وفيديو عبر نقطة مهام غير متزامنة بنمط create/check.
// ملاحظة: لا يوجد مفتاح CometAPI مثبت بعد؛ الأشكال هنا دفاعية ومبنية على التوثيق العام
// (api.cometapi.com متوافق OpenAI). عند إضافة مفتاح حقيقي يُعاد التحقق من الأشكال.
import { ProviderError } from "../errors";
import {
  providerFetch,
  type CheckResult,
  type GenerateInput,
  type ProviderAdapter,
} from "./types";

const COMET_BASE = process.env.COMETAPI_BASE || "https://api.cometapi.com";

interface CometEnvelope {
  code?: number;
  msg?: string;
  message?: string;
  error?: { message?: string } | string;
  data?: unknown;
  id?: string;
  task_id?: string;
  taskId?: string;
}

function extractError(status: number, json: CometEnvelope | null, text: string): ProviderError {
  const msg =
    (typeof json?.error === "string" ? json.error : json?.error?.message) ||
    json?.msg ||
    json?.message ||
    text.slice(0, 300) ||
    `HTTP ${status}`;
  return new ProviderError(status, msg);
}

function extractId(json: CometEnvelope | null): string | null {
  const d = (json?.data ?? {}) as CometEnvelope;
  return json?.id || json?.task_id || json?.taskId || d.id || d.task_id || d.taskId || null;
}

export const cometapiAdapter: ProviderAdapter = {
  // صور متزامنة: OpenAI-compatible POST /v1/images/generations
  async createImageSync(key, model, input) {
    const { status, json, text } = await providerFetch(`${COMET_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: 1,
        size: input.resolution === "2K" ? "2048x2048" : "1024x1024",
      }),
    });
    const env = (json ?? {}) as CometEnvelope & {
      data?: { url?: string; b64_json?: string }[];
    };
    if (status >= 400) throw extractError(status, env, text);
    const first = env.data?.[0];
    if (first?.url && /^https?:\/\//.test(first.url)) return { urls: [first.url] };
    if (first?.b64_json) {
      // روابط فقط تُخزَّن؛ b64 يُحوَّل إلى data URI صالح للاستخدام المباشر
      const uri = `data:image/png;base64,${first.b64_json}`;
      if (uri.length > 1_500_000) {
        throw new ProviderError(500, "الناتج أكبر من المسموح للتخزين");
      }
      return { urls: [uri] };
    }
    throw new ProviderError(500, "لم يُعد المزود رابط صورة");
  },

  async createTask(key, model, input) {
    const { status, json, text } = await providerFetch(`${COMET_BASE}/v1/videos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: {
          prompt: input.prompt,
          ...(input.image_url ? { image_url: input.image_url } : {}),
          ...(input.aspect_ratio && input.aspect_ratio !== "auto"
            ? { aspect_ratio: input.aspect_ratio }
            : {}),
          ...(input.duration ? { duration: input.duration } : {}),
        },
      }),
    });
    const env = (json ?? {}) as CometEnvelope;
    if (status >= 400) throw extractError(status, env, text);
    const id = extractId(env);
    if (!id) throw new ProviderError(500, "لم يُعد المزود معرّف مهمة");
    return { providerTaskId: id };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const { status, json, text } = await providerFetch(
      `${COMET_BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    const env = (json ?? {}) as CometEnvelope & {
      status?: string;
      video_url?: string;
      url?: string;
      progress?: number;
      error?: { message?: string } | string;
    };
    if (status >= 400) throw extractError(status, env, text);
    const st = (env.status ?? "processing").toLowerCase();
    const url = env.video_url || env.url;
    if (["completed", "succeeded", "success", "done"].includes(st)) {
      if (!url) return { status: "failed", error: "اكتملت المهمة دون رابط ناتج" };
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (["failed", "error", "cancelled"].includes(st)) {
      const msg = typeof env.error === "string" ? env.error : env.error?.message || "فشل المزود";
      return { status: "failed", error: msg };
    }
    return { status: "processing", progress: Math.min(90, Math.round(env.progress ?? 50)) };
  },
};
