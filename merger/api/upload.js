// ─── POST /api/upload?job=&seq= — رفع أجزاء ثنائية ≤4MB (ترقيم الأجزاء اختياري) ───
const db = require("../lib/db");
const { sendJson, sendError, optionsCORS, readRawBody, LIMITS } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return optionsCORS(res);
  if (req.method !== "POST") return sendError(res, 405, "الطريقة غير مدعومة — استخدم POST");

  const jobId = String(req.query.job || "");
  const seq = Number(req.query.seq);
  try {
    const job = await db.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة");
    const status = String(job.status);
    if (!["uploading", "queued"].includes(status)) {
      return sendError(res, 409, `لا يمكن الرفع في الحالة الحالية (${status})`);
    }

    const sources = await db.getSources(jobId);
    const src = sources.find((s) => Number(s.seq) === seq);
    if (!src) return sendError(res, 404, "المصدر غير موجود في هذه المهمة");
    if (src.kind !== "file") return sendError(res, 400, "المصدر رابط — لا يحتاج رفعًا");

    const body = await readRawBody(req, LIMITS.uploadChunkBytes);
    if (!body.length) return sendError(res, 400, "الجزء فارغ");

    const declared = Number(src.size || 0);
    const already = Number(src.uploaded_bytes || 0);
    if (declared && already + body.length > declared) {
      return sendError(res, 413, "الحجم المُرسل يتجاوز حجم الملف المعلن");
    }

    await db.writeSourceChunks(jobId, seq, body);
    await db.incrementUploaded(jobId, seq, body.length);

    const fresh = (await db.getSources(jobId)).find((s) => Number(s.seq) === seq);
    const uploadedChunks = Number(fresh.uploaded_chunks || 0);
    const uploadedBytes = Number(fresh.uploaded_bytes || 0);
    const totalChunks = Number(src.total_chunks || 0);

    // اكتمال كل المصادر؟ → انتقل من uploading إلى queued (جاهز للمعالجة)
    if (status === "uploading") {
      const all = await db.getSources(jobId);
      const allReady = all.every(
        (s) =>
          s.kind === "url" ||
          (Number(s.total_chunks) > 0 &&
            Number(s.uploaded_chunks) >= Number(s.total_chunks) &&
            (!declared || Number(s.uploaded_bytes) >= declared))
      );
      if (allReady) await db.updateJob(jobId, { status: "queued", progress: 0 });
    }

    return sendJson(res, 200, {
      ok: true,
      received: body.length,
      uploadedChunks,
      uploadedBytes,
      totalChunks: totalChunks || null,
    });
  } catch (e) {
    return sendError(res, e.status || 500, e.message || "فشل الرفع");
  }
};
