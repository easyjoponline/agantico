// ─── GET /api/config — الحدود العامة (تُستخدم لفحص الجهوزية) ───
const { sendJson, optionsCORS, LIMITS } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return optionsCORS(res);
  if (req.method !== "GET") return sendJson(res, 405, { error: "الطريقة غير مدعومة" });
  return sendJson(res, 200, {
    service: "video-merger",
    version: LIMITS.version,
    maxSources: LIMITS.maxSources,
    sourceMaxMb: LIMITS.sourceMaxMb,
    outputMaxMb: LIMITS.outputMaxMb,
    maxTotalDurationSec: LIMITS.maxTotalDurationSec,
    uploadChunkBytes: LIMITS.uploadChunkBytes,
    expiresHours: LIMITS.expiresHours,
    output: "MP4 (H.264 CRF18 + AAC 192k) — الدقة تُوحَّد تلقائيًا حتى 1080p بـ 30fps",
  });
};
