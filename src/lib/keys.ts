import { listKeys, updateKey, getKey, type KeyRow } from "./turso";
import { classifyProviderError, type ErrorClass } from "./errors";

// ─── نظام المفاتيح المتسلسلة (قلب المشروع — قسم 4) ───
// الترتيب صارم بترتيب الإضافة: أول مفتاح أُضيف يُجرَّب أولًا (created_at ASC, id ASC).
// ليس round-robin وليس «الأقل استخدامًا أولًا». المفتاح المستنزف يبقى في القائمة؛
// الاستثناء الوحيد هو التعطيل اليدوي (disabled).

export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  const all = await listKeys();
  return all.filter((k) => providers.includes(k.provider) && k.status !== "disabled");
}

export async function markKeyDisabled(id: string): Promise<void> {
  await updateKey(id, { status: "disabled", last_error: "رُفض المفتاح من المزود (401/403)" });
}

export async function markKeyExhausted(id: string, reason: string): Promise<void> {
  // يبقى في القاعدة ولا يُستبعد — يظهر بحالة exhausted في الواجهة
  await updateKey(id, { status: "exhausted", last_error: reason.slice(0, 300) });
}

// تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — دائمًا
export async function bumpKeyAfterAttempt(
  keyId: string,
  ok: boolean,
  error?: string
): Promise<void> {
  const key = await getKey(keyId);
  if (!key) return;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  await updateKey(keyId, {
    last_used_at: now,
    last_checked_at: now,
    usage_count: key.usage_count + 1,
    success_count: ok ? key.success_count + 1 : key.success_count,
    fail_count: ok ? key.fail_count : key.fail_count + 1,
    last_error: ok ? null : (error ?? "").slice(0, 300),
  });
}

// تطبيق إجراء الفئة على المفتاح (تعطيل/علامة نفاد) ثم إعادة التصنيف
export async function applyErrorClassToKey(key: KeyRow, err: unknown): Promise<ErrorClass> {
  const cls = classifyProviderError(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (cls === "disabled") await markKeyDisabled(key.id);
  else if (cls === "exhausted") await markKeyExhausted(key.id, msg);
  return cls;
}

// إخفاء المفتاح في كل الاستجابات — إلزامي (قاعدة ذهبية 9)
export function maskKey(key: string): string {
  if (key.length >= 12) {
    return key.slice(0, 7) + "••••••••" + key.slice(-4);
  }
  return key.slice(0, 3) + "••••";
}

export function publicKey(k: KeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}
