// ─── خادم تطوير محلي يحاكي بيئة Vercel ───
// يحمّل .env يدويًا، يحلّل المسارات الديناميكية ويضعها في req.query، ويخدم public/
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");

// تحميل .env يدويًا
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PORT = Number(process.env.PORT || 3001);
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// المسارات الديناميكية — نفس بنية مجلد api/
const ROUTES = [
  { method: "POST", re: /^\/api\/jobs$/, file: "jobs.js" },
  { method: "GET", re: /^\/api\/jobs\/([^/]+)$/, file: "jobs/[id].js", params: ["id"] },
  { method: "DELETE", re: /^\/api\/jobs\/([^/]+)$/, file: "jobs/[id].js", params: ["id"] },
  { method: "POST", re: /^\/api\/jobs\/([^/]+)\/process$/, file: "jobs/[id]/process.js", params: ["id"] },
  { method: "GET", re: /^\/api\/jobs\/([^/]+)\/video$/, file: "jobs/[id]/video.js", params: ["id"] },
  { method: "POST", re: /^\/api\/upload$/, file: "upload.js" },
  { method: "GET", re: /^\/api\/config$/, file: "config.js" },
  { method: "GET", re: /^\/api\/cron$/, file: "cron.js" },
];

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  // API
  for (const route of ROUTES) {
    const m = route.re.exec(pathname);
    if (m && route.method === req.method) {
      req.query = { ...parsed.query };
      if (route.params) {
        route.params.forEach((name, i) => {
          req.query[name] = m[i + 1];
        });
      }
      // يحاكي سلوك Vercel: body يُقرأ بواسطة الدالة نفسها
      try {
        const handler = require(path.join(__dirname, "..", "api", route.file));
        await handler(req, res);
      } catch (e) {
        console.error("handler error:", e);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: e.message || "خطأ غير متوقع" }));
        }
      }
      return;
    }
  }

  // الواجهة الثابتة
  if (req.method === "GET") {
    const file = pathname === "/" || pathname === "/index.html" ? "index.html" : null;
    if (file) {
      const full = path.join(PUBLIC_DIR, file);
      if (fs.existsSync(full)) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        fs.createReadStream(full).pipe(res);
        return;
      }
    }
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "المسار غير موجود" }));
});

server.listen(PORT, () => {
  console.log(`✓ خادم تطوير الدمج يعمل على http://localhost:${PORT}`);
});
