// ─── GET /api/health — حالة السيرفر (قسم 9) ───
import { dbHealthy } from "@/lib/turso";
import { listModelsForHealth } from "@/lib/models";
import { mergerClient, MERGER_BASE } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const database = await dbHealthy();
  const mergerHealthy = mergerClient.isConfigured() ? await mergerClient.healthy() : false;
  return Response.json({
    ok: database,
    database: database ? "turso-connected" : "turso-error",
    mcpEndpoint: "/mcp",
    models: listModelsForHealth(),
    merger: {
      base: MERGER_BASE || "(غير مضبوط)",
      healthy: mergerHealthy,
    },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
