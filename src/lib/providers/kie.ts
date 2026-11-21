// ─── مزود kie.ai — Jobs API الموحد (قسم 5.2) ───
// الشكل الحقيقي المقاس (2025-11):
//   POST /api/v1/jobs/createTask  {"model","input"} → {"code":200,"data":{"taskId":"..."}}
//   GET  /api/v1/jobs/recordInfo?taskId=  → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//          "resultJson":"{\"resultUrls\":[...]}",   // نص JSON داخل JSON — يحتاج JSON.parse ثانيًا
//          "failMsg":null|"..."}}
import { ProviderError } from "../errors";
import {
  providerFetch,
  type CheckResult,
  type GenerateInput,
  type ProviderAdapter,
} from "./types";

const KIE_BASE = "https://api.kie.ai/api/v1/jobs";

interface KieEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

async function kieRequest<T>(
  key: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const { status, json } = await providerFetch(`${KIE_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const env = (json ?? {}) as KieEnvelope<T>;
  if (status >= 400) {
    throw new ProviderError(status, env.msg || `HTTP ${status}`);
  }
  if (typeof env.code === "number" && env.code !== 200) {
    throw new ProviderError(status || env.code, env.msg || `kie code ${env.code}`);
  }
  return (env.data ?? {}) as T;
}

// تحويل مدخلات الأداة إلى input الخاص بـ kie
function buildInput(input: GenerateInput): Record<string, unknown> {
  const inp: Record<string, unknown> = { prompt: input.prompt };
  if (input.image_url) inp.image_url = input.image_url;
  if (input.aspect_ratio && input.aspect_ratio !== "auto") inp.aspect_ratio = input.aspect_ratio;
  else if (input.aspect_ratio === "auto") inp.aspect_ratio = "auto";
  if (input.resolution) inp.resolution = input.resolution;
  if (input.background && input.background !== "auto") inp.background = input.background;
  if (input.output_format) inp.output_format = input.output_format;
  if (input.enable_audio !== undefined) inp.enable_audio = input.enable_audio;
  if (input.duration) inp.duration = input.duration;
  return inp;
}

// خريطة حالة kie → تقدم تقريبي 0..100
function stateToProgress(state: string): number {
  switch (state) {
    case "waiting":
      return 5;
    case "queuing":
      return 12;
    case "generating":
      return 55;
    case "success":
      return 100;
    default:
      return 20;
  }
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, model, input) {
    const data = await kieRequest<{ taskId?: string }>(key, "/createTask", {
      method: "POST",
      body: JSON.stringify({ model, input: buildInput(input) }),
    });
    if (!data.taskId) {
      throw new ProviderError(500, "لم يُعد المزود معرّف مهمة");
    }
    return { providerTaskId: data.taskId };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const data = await kieRequest<{
      state?: string;
      resultJson?: string;
      failMsg?: string;
    }>(key, `/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`);

    const state = data.state ?? "waiting";
    if (state === "success") {
      let urls: string[] = [];
      // resultJson نص JSON داخل JSON — parse ثانوي مع دفاعي
      try {
        const parsed = JSON.parse(data.resultJson || "{}");
        const raw = parsed.resultUrls ?? parsed.resultUrl ?? [];
        urls = (Array.isArray(raw) ? raw : [raw]).filter(
          (u: unknown) => typeof u === "string" && /^https?:\/\//.test(u)
        );
      } catch {
        /* النص غير صالح — نعامله كلا روابط */
      }
      if (!urls.length) {
        return { status: "failed", error: "اكتملت المهمة لكن المزود لم يُعد روابط نتائج" };
      }
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      return { status: "failed", error: data.failMsg || "فشل المزود دون تفاصيل" };
    }
    return { status: "processing", progress: stateToProgress(state) };
  },
};
