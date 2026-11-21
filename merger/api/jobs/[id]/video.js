// ─── GET /api/jobs/{id}/video — بث الناتج بدعم Range (206) و ?download=1 ───
const db = require("../../../lib/db");
const { optionsCORS, LIMITS } = require("../../../lib/util");

const STORE = LIMITS.storeChunkBytes;

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] === "" ? NaN : Number(m[1]);
  let end = m[2] === "" ? NaN : Number(m[2]);
  if (Number.isNaN(start)) {
    // لاحقة: bytes=-N → آخر N بايت
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start >= size) return null; // مدى غير صالح → 416
  end = Math.min(end, size - 1);
  return { start, end };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.end();
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "الطريقة غير مدعومة" }));
  }

  const jobId = String(req.query.id || "");
  try {
    const job = await db.getJob(jobId);
    if (!job || String(job.status) !== "done") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "الناتج غير متوفر — المهمة غير مكتملة أو غير موجودة" }));
    }

    const size = Number(job.output_size || 0);
    const range = parseRange(req.headers.range, size);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="merged-${jobId}.mp4"`);
    }

    if (range) {
      // 416 لمدى غير صالح
      if (!range) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
    } else {
      res.statusCode = 200;
      res.setHeader("Content-Length", String(size));
    }

    // تحديد الأجزاء المطلوبة وتقليم أول/آخر جزء حسب المدى
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const firstIdx = Math.floor(start / STORE);
    const lastIdx = Math.floor(end / STORE);
    let skipInFirst = range ? start % STORE : 0;
    let toWrite = end - start + 1;

    let offset = firstIdx;
    for (;;) {
      const rows = await db.readOutputChunks(jobId, offset, 4); // 4 صفوف × 2MB = 8MB دفعة
      if (!rows.length) break;
      for (const row of rows) {
        if (toWrite <= 0) break;
        let buf = Buffer.from(row.data);
        if (skipInFirst > 0) {
          buf = buf.subarray(skipInFirst);
          skipInFirst = 0;
        }
        if (buf.length > toWrite) buf = buf.subarray(0, toWrite);
        toWrite -= buf.length;
        const ok = res.write(buf);
        if (!ok) await new Promise((r) => res.once("drain", r));
      }
      offset += rows.length;
      if (toWrite <= 0 || offset > lastIdx) break;
    }
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: e.message || "فشل بث الفيديو" }));
  }
};
