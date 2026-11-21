// ─── واجهة المزودين (قسم 5.2) ───
import { ProviderError } from "../errors";
import type { ProviderId } from "../models";

export interface GenerateInput {
  prompt: string;
  model?: string; // اسم الموديل كما يُرسل للمزود (للصور المتزامنة)
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو + صور kie): تعيد providerTaskId
  createTask(key: string, model: string, input: GenerateInput): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: string, model: string, input: GenerateInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}

export const ADAPTER_TIMEOUT_MS = 60_000;

// fetch موحّد يرمي ProviderError بحالة HTTP ورسالة المزود (للتصنيف في errors.ts)
export async function providerFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<{ status: number; json: unknown; text: string }> {
  const { timeoutMs = ADAPTER_TIMEOUT_MS, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* جسم غير JSON — نمرر النص */
    }
    return { status: res.status, json, text };
  } catch (e) {
    // انقطاع شبكة/timeout/abort → خطأ مؤقت (status 0)
    throw new ProviderError(0, `network: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export function buildProviderInput(model: string, input: GenerateInput): GenerateInput {
  return { ...input, model };
}
