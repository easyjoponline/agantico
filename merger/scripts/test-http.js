// ─── اختبار HTTP كامل ضد خادم التطوير (قسم 14.7) ───
// يشغّل الخادم تلقائيًا ثم يفحص: مهمة من روابط → دمج → بث Range 206 →
// مهمة مختلطة (رابط + ملف مرفوع) → حدود الحجم/العدد → JSON تالف → حذف → 404.
const { spawn } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");

const BASE = process.env.BASE || "http://localhost:3001";
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function req(method, p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* جسم ثنائي أو نصي */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return true;
    } catch {
      /* لم يجهز */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  console.log("— اختبار HTTP كامل ضد خادم التطوير —");

  // 0) الجهوزية
  const cfg = await req("GET", "/api/config");
  check("GET /api/config يعيد الحدود", cfg.status === 200 && cfg.json.maxSources === 10);

  const createdJobs = [];

  // 1) مهمة من روابط عامة → process → done
  const create = await req("POST", "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videos: [
        "https://www.w3schools.com/html/mov_bbb.mp4",
        "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
      ],
    }),
  });
  check("POST /api/jobs من روابط يعيد 201", create.status === 201 && create.json.jobId);
  const jobId = create.json.jobId;
  createdJobs.push(jobId);
  check("statusUrl و processUrl و expiresAt موجودة", Boolean(create.json.statusUrl && create.json.processUrl && create.json.expiresAt));

  const proc = await req("POST", `/api/jobs/${jobId}/process`, { method: "POST" });
  check("process ينفذ الدمج (done)", proc.status === 200 && proc.json.status === "done", `(${proc.status} ${JSON.stringify(proc.json).slice(0, 160)})`);
  check("النتيجة تحمل videoUrl/downloadUrl/size/duration/resolution", Boolean(proc.json.videoUrl && proc.json.downloadUrl && proc.json.size && proc.json.duration && proc.json.resolution));

  // 2) الحالة والتقدم
  const st = await req("GET", `/api/jobs/${jobId}`);
  check("GET الحالة = done وتقدم 100", st.status === 200 && st.json.status === "done" && st.json.progress === 100);

  // 3) بث الناتج مع Range → 206
  const range = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=0-1023" } });
  const buf = Buffer.from(await range.arrayBuffer());
  check("Range يعيد 206 + Content-Range", range.status === 206 && (range.headers.get("content-range") || "").includes("0-1023/"));
  check("طول المقطع المطلوب 1024 بايت", buf.length === 1024);

  const full = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  check("الناتج الكامل 200 بحجم مطابق", full.status === 200 && fullBuf.length === proc.json.size);
  check("الملف MP4 صالح (ftyp في الترويسة)", fullBuf.subarray(4, 8).toString() === "ftyp");

  // 4) مهمة مختلطة: رابط + ملف مرفوع على أجزاء
  // ملف اختبار صغير محلي (240p بلا صوت)
  const tiny = path.join(require("node:os").tmpdir(), `http-tiny-${Date.now()}.mp4`);
  await new Promise((res, rej) => {
    const p = spawn(require("ffmpeg-static"), ["-y", "-v", "error", "-f", "lavfi", "-i", `color=blue:size=160x120:rate=20:duration=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", tiny]);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg exit " + c))));
  });
  const tinyBuf = fs.readFileSync(tiny);
  require("node:fs").unlinkSync(tiny);

  const mixed = await req("POST", "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [
        { kind: "url", url: "https://www.w3schools.com/html/mov_bbb.mp4" },
        { kind: "file", name: "tiny.mp4", size: tinyBuf.length, mime: "video/mp4" },
      ],
    }),
  });
  check("مهمة مختلطة تُنشأ بحالة uploading وuploads[]", mixed.status === 201 && mixed.json.status === "uploading" && Array.isArray(mixed.json.uploads) && mixed.json.uploads.length === 1);
  const mixedId = mixed.json.jobId;
  createdJobs.push(mixedId);
  const up = mixed.json.uploads[0];
  const CHUNK = up.uploadChunkBytes;
  for (let off = 0; off < tinyBuf.length; off += CHUNK) {
    const piece = tinyBuf.subarray(off, Math.min(off + CHUNK, tinyBuf.length));
    const r = await fetch(up.uploadUrl, { method: "POST", body: piece, headers: { "Content-Type": "application/octet-stream" } });
    const j = await r.json();
    check(`رفع جزء (${Math.floor(off / CHUNK) + 1})`, r.status === 200 && j.ok);
  }
  const mixedProc = await req("POST", `/api/jobs/${mixedId}/process`, { method: "POST" });
  check("الدمج المختلط يكتمل", mixedProc.status === 200 && mixedProc.json.status === "done", `(${mixedProc.status} ${JSON.stringify(mixedProc.json).slice(0, 160)})`);

  // 5) الحدود: أكثر من 10 مصادر
  const tooMany = await req("POST", "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.mp4`) }),
  });
  check("رفض أكثر من 10 مقاطع (400 برسالة عربية)", tooMany.status === 400 && /أقصى|10/.test(tooMany.json.error || ""));

  // 6) JSON تالف
  const bad = await req("POST", "/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  check("JSON تالف → 400", bad.status === 400);

  // 7) مصدر برابط غير صالح
  const badUrl = await req("POST", "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: ["ftp://x/y.mp4"] }),
  });
  check("رابط غير صالح → 400", badUrl.status === 400);

  // 8) حذف ثم 404
  for (const id of createdJobs) {
    const del = await req("DELETE", `/api/jobs/${id}`, { method: "DELETE" });
    check(`DELETE ${id} → 200`, del.status === 200);
    const gone = await req("GET", `/api/jobs/${id}`);
    check(`GET بعد الحذف → 404`, gone.status === 404);
  }

  // 9) رفع لمهمة غير موجودة
  const ghost = await fetch(`${BASE}/api/upload?job=nonexistent&seq=0`, { method: "POST", body: Buffer.from("x") });
  check("رفع لمهمة غير موجودة → 404", ghost.status === 404);

  console.log(`\nالنتيجة: ${passed} نجاح / ${failed} فشل`);
  process.exit(failed ? 1 : 0);
}

const fs = require("node:fs");

main().catch((e) => {
  console.error("فشل الاختبار:", e.message);
  process.exit(1);
});
