// ─── GET /api/cron — حذف المهام المنتهية (Cron يومي في vercel.json) ───
const db = require("../lib/db");
const { sendJson, sendError, optionsCORS } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return optionsCORS(res);
  if (req.method !== "GET") return sendError(res, 405, "الطريقة غير مدعومة");
  try {
    const deleted = await db.purgeExpired();
    return sendJson(res, 200, { ok: true, deleted });
  } catch (e) {
    return sendError(res, 500, e.message || "فشل التنظيف");
  }
};
