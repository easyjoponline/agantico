// ─── اختبار وحدات لمحرك الدمج والتخزين (قسم 14.7) ───
// يولّد فيديوهين مختلفي الدقة (أحدهما بلا صوت)، يدمجهما، ويتحقق من الجودة،
// ثم يختبر تخزين Turso واسترجاعه بتطابق sha256 ومسار رفع الأجزاء والحذف الشامل.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const FFMPEG = require("ffmpeg-static");
const { probeSource, mergeVideos } = require("../lib/merge");
const db = require("../lib/db");
const { LIMITS } = require("../lib/util");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function genClip(out, opts) {
  const args = ["-y", "-v", "error"];
  if (opts.video !== "color") {
    args.push("-f", "lavfi", "-i", `testsrc=size=${opts.w}x${opts.h}:rate=25:duration=${opts.dur}`);
  } else {
    args.push("-f", "lavfi", "-i", `color=black:size=${opts.w}x${opts.h}:rate=25:duration=${opts.dur}`);
  }
  if (opts.audio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=${opts.freq || 440}:duration=${opts.dur}`);
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (opts.audio) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  await new Promise((res, rej) => {
    const p = require("node:child_process").spawn(FFMPEG, args);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`))));
  });
  return out;
}

async function main() {
  console.log("— اختبار الوحدات: محرك الدمج + التخزين —");

  // 1) توليد مقطعين مختلفي الدقة (أ بلا صوت)
  const tmpA = path.join(os.tmpdir(), `unit-a-${Date.now()}.mp4`);
  const tmpB = path.join(os.tmpdir(), `unit-b-${Date.now()}.mp4`);
  await genClip(tmpA, { w: 320, h: 240, dur: 2, audio: true });
  await genClip(tmpB, { w: 640, h: 360, dur: 3, audio: false });
  console.log("  ✓ توليد مقطعين (320×240 بصوت، 640×360 بلا صوت)");

  // 2) الدمج عبر المحرك مباشرة
  const progressSeen = [];
  const merged = await mergeVideos({
    sources: [{ path: tmpA }, { path: tmpB }],
    onProgress: (p) => progressSeen.push(p),
  });
  console.log(`  ✓ اكتمال الدمج — الناتج: ${merged.size} بايت، ${merged.resolution}`);
  check("الدقة = أكبر دقة مدخل (640×360)", merged.resolution === "640x360");
  check("المدة ≈ مجموع المدد (5 ثوانٍ)", Math.abs(merged.duration - 5) < 1.0, `(فعلي: ${merged.duration})`);

  const outMeta = await probeSource(FFMPEG, merged.outPath);
  check("الناتج يحتوي صوتًا (المصدر الصامت أُكمل بمسار صامت)", outMeta.hasAudio === true);
  check("الدقة زوجية ومحدودة بـ 1080p", outMeta.width % 2 === 0 && outMeta.height % 2 === 0 && outMeta.width <= 1920);
  check("بث التقدم يعمل (قيم 40–90 مرصودة)", progressSeen.some((p) => p >= 40 && p <= 90));

  // 3) تخزين Turso والاسترجاع بتطابق sha256
  const jobId = "unit" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  await db.createJob(
    [
      { kind: "url", url: "https://example.com/a.mp4" },
      { kind: "url", url: "https://example.com/b.mp4" },
    ],
    "queued"
  );
  const size = await db.storeOutput(jobId, merged.outPath);
  check("تخزين الناتج في Turso", size === merged.size);
  const cnt = await db.outputChunkCount(jobId);
  check("تقسيم Blob إلى صفوف ≤2MB", cnt > 0 && cnt === Math.ceil(size / LIMITS.storeChunkBytes), `(صفوف: ${cnt})`);

  // استرجاع صفحة بصفحة وتجميع + sha256
  const h1 = crypto.createHash("sha256").update(fs.readFileSync(merged.outPath)).digest("hex");
  let assembled = [];
  let off = 0;
  for (;;) {
    const rows = await db.readOutputChunks(jobId, off, 8);
    if (!rows.length) break;
    for (const r of rows) assembled.push(Buffer.from(r.data));
    off += rows.length;
  }
  const h2 = crypto.createHash("sha256").update(Buffer.concat(assembled)).digest("hex");
  check("الاسترجاع من Turso مطابق (sha256)", h1 === h2);

  // 4) مسار رفع الأجزاء (writeSourceChunks → readSourceChunksToFile)
  const big = crypto.randomBytes(5 * 1024 * 1024 + 123456); // 5MB+ وليس مضاعف 2MB
  await db.writeSourceChunks(jobId, 0, big);
  const restored = path.join(os.tmpdir(), `unit-restored-${Date.now()}.bin`);
  await db.readSourceChunksToFile(jobId, 0, restored);
  const h3 = crypto.createHash("sha256").update(big).digest("hex");
  const h4 = crypto.createHash("sha256").update(fs.readFileSync(restored)).digest("hex");
  check("رفع أجزاء المصدر واستعادتها مطابقة (sha256)", h3 === h4);
  fs.unlinkSync(restored);

  // 5) الحذف الشامل
  await db.deleteJob(jobId);
  await sleep(500);
  const cntAfter = await db.outputChunkCount(jobId);
  const jobAfter = await db.getJob(jobId);
  check("الحذف الشامل (المهمة والأجزاء)", cntAfter === 0 && jobAfter === null);

  fs.unlinkSync(tmpA);
  fs.unlinkSync(tmpB);
  fs.unlinkSync(merged.outPath);

  console.log(`\nالنتيجة: ${passed} نجاح / ${failed} فشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("فشل الاختبار:", e.message);
  process.exit(1);
});
