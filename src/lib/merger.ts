// ─── عميل خدمة دمج الفيديو — Video Merger API v2 (قسم 7) ───
// بلا مفاتيح أو توثيق؛ المخرجات MP4 (H.264+AAC) حتى 1080p. الناتج يُحذف بعد ~24 ساعة.
// قاعدة حتمية: أي خطأ HTTP معلن (4xx/5xx بجسم error) = فشل نهائي فوري؛
// أخطاء شبكتنا (timeout/fetch) = مؤقتة وتستمر بالاستعلام.

export const MERGER_BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

export class MergerHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MergerHttpError";
    this.status = status;
  }
}

export class MergerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergerUnavailableError";
  }
}

async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  if (!MERGER_BASE) {
    throw new MergerUnavailableError("لم يُضبط عنوان خدمة الدمج (MERGER_API_BASE)");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${MERGER_BASE}${path}`, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* جسم غير JSON */
    }
    return { status: res.status, json };
  } catch (e) {
    throw new MergerUnavailableError(`network: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

// أسماء حالات الدمج — دفاعية (7.2)
const DONE_SET = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED_SET = new Set(["error", "failed", "failure", "cancelled"]);

export interface MergeStatus {
  status: "queued" | "processing" | "done" | "failed";
  progress: number; // 0..100
  url?: string;
  error?: string;
}

export function parseMergeStatus(
  jobId: string,
  json: Record<string, unknown> | null
): MergeStatus {
  // الجسم قد يحوي error بدون status → فشل فوري
  const rawError = json?.error ? String(json.error) : undefined;
  const rawStatus = String(json?.status ?? "").toLowerCase();
  // progress أحيانًا يأتي كسرًا 0..1 → اضربه في 100
  let progress = Number(json?.progress ?? 0);
  if (!Number.isFinite(progress)) progress = 0;
  if (progress > 0 && progress <= 1) progress = progress * 100;
  progress = Math.max(0, Math.min(100, Math.round(progress)));

  if (rawError && !rawStatus) {
    return { status: "failed", progress: 100, error: rawError };
  }
  const url =
    (typeof json?.videoUrl === "string" && json.videoUrl) ||
    (typeof json?.downloadUrl === "string" && json.downloadUrl) ||
    // إن غاب الرابطان وبقي jobId → رابط الفيديو المباشر المتوقع
    `${MERGER_BASE}/api/jobs/${jobId}/video`;
  const finalUrl = typeof url === "string" ? url : undefined;

  if (DONE_SET.has(rawStatus)) return { status: "done", progress: 100, url: finalUrl };
  if (FAILED_SET.has(rawStatus)) {
    return { status: "failed", progress: 100, error: rawError || "فشلت خدمة الدمج" };
  }
  return {
    status: rawStatus === "queued" || rawStatus === "uploading" ? "queued" : "processing",
    progress,
    error: undefined,
  };
}

export const mergerClient = {
  isConfigured(): boolean {
    return Boolean(MERGER_BASE);
  },

  // فحص الجهوزية: GET /api/config بمهلة 4 ثوانٍ
  async healthy(): Promise<boolean> {
    try {
      const { status } = await mergerFetch("/api/config", {}, 4_000);
      return status === 200;
    } catch {
      return false;
    }
  },

  async createJob(urls: string[]): Promise<{ jobId: string }> {
    const { status, json } = await mergerFetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: urls }),
    });
    if (status >= 400 || !json?.jobId) {
      throw new MergerHttpError(
        status,
        String(json?.error ?? `فشل إنشاء مهمة الدمج (HTTP ${status})`)
      );
    }
    return { jobId: String(json.jobId) };
  },

  // تنفيذ الدمج — blocking (يستغرق عادةً 10–60 ثانية حسب الحجم)
  async processJob(jobId: string): Promise<{ status: string; error?: string }> {
    const { status, json } = await mergerFetch(
      `/api/jobs/${encodeURIComponent(jobId)}/process`,
      { method: "POST" },
      290_000
    );
    if (status === 202) return { status: "processing" };
    if (status >= 400) {
      throw new MergerHttpError(
        status,
        String(json?.error ?? `فشل تنفيذ الدمج (HTTP ${status})`)
      );
    }
    return { status: String(json?.status ?? "processing") };
  },

  async getStatus(jobId: string): Promise<MergeStatus> {
    const { status, json } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (status === 404) {
      // المهمة غير موجودة: حُذفت أو انتهت صلاحيتها بعد 24 ساعة → فشل نهائي
      throw new MergerHttpError(404, "not-found");
    }
    if (status >= 500) {
      // خطأ خدمة معلن بلا تفاصيل حالة — عاملها فشلًا حتميًا فقط إن حمل جسم error، وإلا مؤقتًا
      if (json?.error) throw new MergerHttpError(status, String(json.error));
      throw new MergerUnavailableError(`HTTP ${status}`);
    }
    if (status >= 400) {
      throw new MergerHttpError(status, String(json?.error ?? `HTTP ${status}`));
    }
    return parseMergeStatus(jobId, json);
  },

  // حذف مهمة دمج (تنظيف اختياري بعد الاختبارات)
  async deleteJob(jobId: string): Promise<void> {
    try {
      await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 10_000);
    } catch {
      /* التنظيف ليس حرجًا */
    }
  },
};

// قفل في الذاكرة: تنفيذ process مرة واحدة فقط لكل مهمة (7.3.3)
export const processInFlight = new Set<string>();
