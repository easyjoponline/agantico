// ─── POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن، قسم 14.3) ───
// ينزّل/يسحب المصادر ← يرمّز ← يحفظ الناتج في Turso، ويُرجع النتيجة مباشرة.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const db = require("../../../lib/db");
const { sendJson, sendError, optionsCORS, LIMITS, baseUrlOf } = require("../../../lib/util");
const { downloadSource, mergeVideos } = require("../../../lib/merge");

// قفل في الذاكرة لمنع تنفيذ مزدوج لنفس المهمة في نفس العملية
const inFlight = new Set();

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return optionsCORS(res);
  if (req.method !== "POST") return sendError(res, 405, "الطريقة غير مدعومة — استخدم POST");

  const jobId = String(req.query.id || "");
  const base = baseUrlOf(req);

  try {
    const job = await db.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    const status = String(job.status);

    if (status === "done") {
      // النتيجة جاهزة — أعدها مرة أخرى
      return sendJson(res, 200, {
        status: "done",
        videoUrl: `${base}/api/jobs/${jobId}/video`,
        downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
        size: job.output_size ? Number(job.output_size) : undefined,
        duration: job.output_duration ? Number(job.output_duration) : undefined,
        resolution: job.output_resolution ? String(job.output_resolution) : undefined,
        expiresAt: String(job.expires_at),
      });
    }
    if (status === "processing") {
      return sendJson(res, 202, { status: "processing", progress: Number(job.progress || 0) });
    }
    if (status === "failed") {
      return sendError(res, 409, `المهمة فشلت سابقًا: ${String(job.error || "سبب غير معروف")}`);
    }
    if (inFlight.has(jobId)) {
      return sendJson(res, 202, { status: "processing", progress: Number(job.progress || 0) });
    }
    inFlight.add(jobId);

    // ─── جمع المصادر ───
    const sources = await db.getSources(jobId);
    // كل الملفات مرفوعة بالكامل؟
    for (const s of sources) {
      if (s.kind === "file") {
        const total = Number(s.total_chunks || 0);
        const got = Number(s.uploaded_chunks || 0);
        if (total > 0 && got < total) {
          inFlight.delete(jobId);
          return sendError(res, 409, `الملف "${String(s.name)}" لم يكتمل رفعه (${got}/${total} أجزاء)`);
        }
      }
    }

    await db.updateJob(jobId, { status: "processing", progress: 1, error: null });
    const tmpFiles = [];
    try {
      // ─── سحب المصادر (0–40 من التقدم) ───
      const localPaths = [];
      const totalBytes = sources.reduce((a, s) => a + Number(s.size || 0), 0);
      let downloaded = 0;
      for (const s of sources) {
        const p = path.join(os.tmpdir(), `src-${jobId}-${Number(s.seq)}.bin`);
        tmpFiles.push(p);
        if (s.kind === "url") {
          await downloadSource(String(s.url), p, (bytes) => {
            downloaded = downloaded; // التقدم يُحدَّث عند كل استدعاء
            const pct = Math.min(38, 2 + Math.round((bytes / Math.max(totalBytes, 1)) * 36));
            db.updateJob(jobId, { progress: pct }).catch(() => {});
          });
        } else {
          await db.readSourceChunksToFile(jobId, Number(s.seq), p);
          db.updateJob(jobId, { progress: 30 }).catch(() => {});
        }
        localPaths.push(p);
      }

      // ─── الدمج والترميز (40–90) ───
      const merged = await mergeVideos({
        sources: localPaths.map((p) => ({ path: p })),
        onProgress: (pct, _m) => {
          db.updateJob(jobId, { progress: Math.max(1, Math.min(95, pct)) }).catch(() => {});
        },
      });
      tmpFiles.push(merged.outPath);

      // ─── حفظ الناتج في Turso ثم تنظيف الأجزاء ───
      const size = await db.storeOutput(jobId, merged.outPath);
      await db.getDb().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
      await db.updateJob(jobId, {
        status: "done",
        progress: 100,
        error: null,
        output_size: size,
        output_duration: Math.round(merged.duration * 100) / 100,
        output_resolution: merged.resolution,
      });

      return sendJson(res, 200, {
        status: "done",
        videoUrl: `${base}/api/jobs/${jobId}/video`,
        downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
        size,
        duration: Math.round(merged.duration * 100) / 100,
        resolution: merged.resolution,
        expiresAt: String(job.expires_at),
      });
    } catch (e) {
      // فشل حتمي واضح برسالة عربية — لا انهيار
      const msg = e instanceof Error ? e.message : String(e);
      await db.updateJob(jobId, { status: "failed", error: msg }).catch(() => {});
      return sendError(res, 500, msg || "فشل الدمج لسبب غير معروف");
    } finally {
      // تنظيف /tmp
      inFlight.delete(jobId);
      for (const f of tmpFiles) {
        await fs.promises.unlink(f).catch(() => {});
      }
    }
  } catch (e) {
    inFlight.delete(jobId);
    return sendError(res, 500, e.message || "خطأ غير متوقع");
  }
};
