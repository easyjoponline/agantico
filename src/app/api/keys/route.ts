// ─── إدارة المفاتيح للواجهة (قسم 4.4) ───
// GET: القائمة كاملة مع إخفاء دائم للمفاتيح (maskKey).
// POST: إضافة مع رفض التكرار لنفس المزود.
import { randomUUID } from "node:crypto";
import { listKeys, insertKey, type KeyRow } from "@/lib/turso";
import { publicKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = ["kie", "cometapi"];

export async function GET() {
  const keys = await listKeys();
  return Response.json({ keys: keys.map(publicKey) });
}

export async function POST(request: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON تالف" }, { status: 400 });
  }
  const provider = (body.provider ?? "").trim();
  const apiKey = (body.api_key ?? "").trim();
  const label = (body.label ?? "").trim().slice(0, 80);
  if (!VALID_PROVIDERS.includes(provider)) {
    return Response.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 8) {
    return Response.json({ error: "المفتاح مطلوب (8 أحرف على الأقل)" }, { status: 400 });
  }
  const existing = await listKeys();
  // رفض التكرار لنفس المزود
  if (existing.some((k: KeyRow) => k.provider === provider && k.api_key === apiKey)) {
    return Response.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
  }
  const key = await insertKey({ id: randomUUID(), provider, label, api_key: apiKey });
  return Response.json({ key: publicKey(key) }, { status: 201 });
}
