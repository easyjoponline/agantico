// ─── تصنيف أخطاء المزودين (جدول 4.2 في المواصفة) ───
// الفئات تحدد سلوك التبديل: disabled → تعطيل المفتاح والانتقال، exhausted → وضع علامة
// والانتقال، provider → موديل غير مدعوم والانتقال، params → توقف فورًا، temporary → انتقال.

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

// أنماط نفاد الرصيد — تُفحص قبل 400 لأن بعض المزودين يرسلون النفاد بحالة 400
const EXHAUSTED_RE =
  /insufficient|quota|balance|credit|out of credits|exhausted|充值|payment|arrears/i;
// أنماط رفض المفتاح
const AUTH_RE = /invalid api key|unauthorized|forbidden|authentication|invalid key|api key invalid|token invalid|incorrect api key/i;
// أنماط موديل غير مدعوم
const MODEL_RE = /model not found|unsupported model|unknown model|invalid model|no such model|does not exist/i;

export function classifyProviderError(err: unknown): ErrorClass {
  const status = err instanceof ProviderError ? err.status : 0;
  const msg = err instanceof Error ? err.message : String(err);

  // 1) النفاد أولًا (قبل فحص 400/401)
  if (status === 402 || EXHAUSTED_RE.test(msg)) return "exhausted";
  // 2) رفض المفتاح
  if (status === 401 || status === 403 || AUTH_RE.test(msg)) return "disabled";
  // 3) موديل غير مدعوم لدى هذا المزود
  if (MODEL_RE.test(msg) && [400, 404, 422].includes(status)) return "provider";
  // 4) خطأ معطيات — توقف فورًا (تبديل المفاتيح لن يحله)
  if (status === 400 || status === 422) return "params";
  // 5) مؤقت: 429، 5xx، شبكة/timeout/abort (status 0)
  return "temporary";
}

// هل رسالة فشل منتصف المهمة تشير لمشكلة مفتاح/رصيد (قسم 4.3.2)؟
const KEYFAIL_RE = /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key|exhausted|充值|payment/i;

export function isKeyOrBalanceFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return KEYFAIL_RE.test(message);
}

// أخطاء لا تُعرض أبدًا للعميل: أي ذكر لمفاتيح/رصيد يُستبدل برسالة عامة (قاعدة ذهبية 4)
const SANITIZE_RE = /key|balance|credit|quota|402|401|unauthorized|token|api|مفتاح|رصيد/i;

export function publicErrorMessage(message: string | null | undefined): string {
  if (!message) return "سبب غير معروف";
  if (SANITIZE_RE.test(message)) {
    return "تعذّر إكمال العمل حاليًا بسبب ضغط مؤقت على المزود — سيُعاد المحاولة تلقائيًا";
  }
  return message;
}
