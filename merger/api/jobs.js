// ─── POST /api/jobs — إنشاء مهمة دمج (قسم 14.3) ───
// يقبل {"videos":[...]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
const db = require("../lib/db");
const { sendJson, sendError, optionsCORS, readJsonBody, LIMITS, baseUrlOf } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return optionsCORS(res);
  if (req.method !== "POST") return sendError(res, 405, "الطريقة غير مدعومة — استخدم POST");

  try {
    // تنظيف كسول للمهام المنتهية
    await db.purgeExpired().catch(() => {});

    const body = await readJsonBody(req);

    // تطبيع المصادر
    let sources = [];
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((u) => ({ kind: "url", url: String(u).trim() }));
    } else if (Array.isArray(body.sources)) {
      sources = body.sources.map((s) => {
        if (s && s.kind === "file") {
          return {
            kind: "file",
            name: String(s.name || "file.mp4").slice(0, 200),
            mime: s.mime || "video/mp4",
            size: Number(s.size || 0),
          };
        }
        return { kind: "url", url: String(s && (s.url || s)).trim() };
      });
    } else {
      return sendError(res, 400, 'الجسم مطلوب: {"videos":[روابط]} أو {"sources":[...]}');
    }

    if (!sources.length) return sendError(res, 400, "لا توجد مقاطع — مرّر رابطًا أو ملفًا واحدًا على الأقل");
    if (sources.length > LIMITS.maxSources) {
      return sendError(res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.maxSources}`);
    }
    for (const s of sources) {
      if (s.kind === "url") {
        if (!/^https?:\/\//i.test(s.url)) {
          return sendError(res, 400, `الرابط غير صالح — يجب أن يكون رابطًا مباشرًا عامًا http/https: ${s.url}`);
        }
      } else {
        if (!s.size || s.size <= 0) return sendError(res, 400, `حجم الملف "${s.name}" غير معروف`);
        if (s.size > LIMITS.sourceMaxMb * 1024 * 1024) {
          return sendError(res, 413, `حجم الملف "${s.name}" يتجاوز ${LIMITS.sourceMaxMb}MB`);
        }
        s.totalChunks = Math.ceil(s.size / LIMITS.uploadChunkBytes);
      }
    }

    const status = sources.some((s) => s.kind === "file") ? "uploading" : "queued";
    const { id, expiresAt } = await db.createJob(sources, status);
    const base = baseUrlOf(req);

    const response = {
      jobId: id,
      status,
      statusUrl: `${base}/api/jobs/${id}`,
      processUrl: `${base}/api/jobs/${id}/process`,
      expiresAt,
    };
    // رفع أجزاء الملفات إن وُجدت
    const uploads = sources
      .map((s, seq) => ({ s, seq }))
      .filter(({ s }) => s.kind === "file")
      .map(({ s, seq }) => ({
        seq,
        name: s.name,
        size: s.size,
        uploadUrl: `${base}/api/upload?job=${id}&seq=${seq}`,
        uploadChunkBytes: LIMITS.uploadChunkBytes,
        totalChunks: s.totalChunks,
      }));
    if (uploads.length) response.uploads = uploads;

    return sendJson(res, 201, response);
  } catch (e) {
    return sendError(res, e.status || 500, e.message || "خطأ غير متوقع");
  }
};
