// ─── تعطيل/تنشيط/حذف مفتاح بالمعرّف (قسم 4.4) ───
import { getKey, updateKey, deleteKey } from "@/lib/turso";
import { publicKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON تالف" }, { status: 400 });
  }
  const status = body.status ?? "";
  if (!["active", "disabled"].includes(status)) {
    return Response.json({ error: "status يجب أن يكون active أو disabled" }, { status: 400 });
  }
  const key = await getKey(id);
  if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await updateKey(id, { status });
  const fresh = await getKey(id);
  return Response.json({ key: fresh ? publicKey(fresh) : null });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = await getKey(id);
  if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return Response.json({ ok: true });
}
