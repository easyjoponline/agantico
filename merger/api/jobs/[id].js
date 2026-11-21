// ─── GET /api/jobs/{id} (الحالة) و DELETE /api/jobs/{id} (حذف شامل) ───
const db = require("../../lib/db");
const { sendJson, sendError, optionsCORS, baseUrlOf } = require("../../lib/util");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return optionsCORS(res);
  const jobId = req.query.id;

  try {
    const job = await db.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

    if (req.method === "DELETE") {
      await db.deleteJob(jobId);
      return sendJson(res, 200, { ok: true, deleted: jobId });
    }
    if (req.method !== "GET") return sendError(res, 405, "الطريقة غير مدعومة");

    const sources = await db.getSources(jobId);
    const base = baseUrlOf(req);
    const done = String(job.status) === "done";
    const response = {
      jobId,
      status: String(job.status),
      progress: Number(job.progress || 0),
      expiresAt: String(job.expires_at),
      createdAt: String(job.created_at),
      sources: sources.map((s) => ({
        seq: Number(s.seq),
        kind: String(s.kind),
        name: s.name ? String(s.name) : undefined,
        url: s.url ? String(s.url) : undefined,
        uploadedChunks: Number(s.uploaded_chunks || 0),
        totalChunks: s.total_chunks ? Number(s.total_chunks) : undefined,
      })),
    };
    if (done) {
      response.videoUrl = `${base}/api/jobs/${jobId}/video`;
      response.downloadUrl = `${base}/api/jobs/${jobId}/video?download=1`;
      if (job.output_size) response.size = Number(job.output_size);
      if (job.output_duration) response.duration = Number(job.output_duration);
      if (job.output_resolution) response.resolution = String(job.output_resolution);
    }
    if (job.error) response.error = String(job.error);
    return sendJson(res, 200, response);
  } catch (e) {
    return sendError(res, 500, e.message || "خطأ غير متوقع");
  }
};
