// ─── أدوات مشتركة: استجابات JSON، قراءة الجسم، CORS، رسائل عربية ───
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function optionsCORS(res) {
  res.statusCode = 204;
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.end();
}

// قراءة جسم JSON مع حد أقصى
function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("الجسم أكبر من المسموح"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return reject(Object.assign(new Error("الجسم مطلوب"), { status: 400 }));
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("JSON تالف — تعذر تحليل الجسم"), { status: 400 }));
      }
    });
    req.on("error", (e) => reject(e));
  });
}

// قراءة جسم ثنائي خام (رفع الأجزاء) مع حد أقصى
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error(`الجزء أكبر من الحد (${Math.round(maxBytes / 1024 / 1024)}MB)`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (e) => reject(e));
  });
}

const LIMITS = {
  maxSources: Number(process.env.MAX_SOURCES || 10),
  sourceMaxMb: Number(process.env.SOURCE_MAX_MB || 200),
  outputMaxMb: Number(process.env.OUTPUT_MAX_MB || 150),
  maxTotalDurationSec: Number(process.env.MAX_TOTAL_DURATION_SEC || 600),
  uploadChunkBytes: 4 * 1024 * 1024, // حد Vercel ≈4.5MB للطلب
  storeChunkBytes: 2 * 1024 * 1024, // صفوف Turso 2MB
  expiresHours: 24,
  version: "1.0.0",
};

// العنوان الأساسي للروابط المُعادة: Vercel يمرر x-forwarded-proto، محليًا http
function baseUrlOf(req) {
  if (process.env.PUBLIC_BASE) return process.env.PUBLIC_BASE.replace(/\/+$/, "");
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || (req.socket && req.socket.encrypted ? "https" : "http");
  return `${String(proto).split(",")[0].trim()}://${host}`;
}

module.exports = { sendJson, sendError, optionsCORS, readJsonBody, readRawBody, LIMITS, CORS, baseUrlOf };
