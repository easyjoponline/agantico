// ─── لوحة المهام: أحدث المهام + الإحصائيات (قسم 9 ب) ───
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicTask(t: Awaited<ReturnType<typeof listRecentTasks>>[number]) {
  let urls: string[] = [];
  let attempts: unknown[] = [];
  try {
    urls = JSON.parse(t.result_urls_json || "[]");
  } catch {
    /* لا روابط */
  }
  try {
    attempts = JSON.parse(t.attempts_json || "[]");
  } catch {
    /* لا محاولات */
  }
  return {
    id: t.id,
    type: t.type,
    model: t.model,
    provider: t.provider,
    status: t.status,
    progress: t.progress,
    prompt: t.prompt.slice(0, 120),
    urls,
    error: t.error_message,
    attempts: attempts.length,
    created_at: t.created_at,
    completed_at: t.completed_at,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 20)));
  const type = url.searchParams.get("type") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type: type || undefined, status: status || undefined }),
    taskStats(),
  ]);
  return Response.json({ stats, tasks: tasks.map(publicTask) });
}
