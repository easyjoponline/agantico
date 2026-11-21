// ─── مسار /mcp — خادم MCP عبر Streamable HTTP (قسم 8) ───
// نستخدم النقل الرسمي WebStandardStreamableHTTPServerTransport من SDK (يعمل مباشرة
// مع Web Request/Response في Next.js App Router وبثّ SSE حقيقي لإشعارات التقدم).
// وضع عديم الحالة (stateless): كل طلب مستقل — مناسب تمامًا لبيئة Vercel serverless.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

function checkAuth(request: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true; // لا حماية مضبوطة — مفتوح
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${token}`;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "مطلوب ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>" }),
    { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}

async function handle(request: Request): Promise<Response> {
  if (!checkAuth(request)) return unauthorized();
  // نسخة مستقلة من الخادم والنقل لكل طلب (stateless) — لا حالة مشتركة
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createMcpServer();
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  // أضف ترويسات CORS إلى الاستجابة الرسمية
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function POST(request: Request) {
  return handle(request);
}

// stateless: GET (قناة SSE منفصلة) غير مدعوم — النقل يعيد 405 بنفسه
export async function GET(request: Request) {
  return handle(request);
}

export async function DELETE(request: Request) {
  return handle(request);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
