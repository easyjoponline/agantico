// ─── محرك الدمج (ffmpeg + ffprobe) — جودة عالية إلزامية (قسم 14.4) ───
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { LIMITS } = require("./util");

const FFMPEG_PATH = require("ffmpeg-static");
const FFPROBE_PATH = require("ffprobe-static").path;

// ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة: انسخه إلى /tmp بصلاحية 755
function ensureExecutable(bin, name) {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch {
    const tmp = path.join(os.tmpdir(), `${name}-${path.basename(bin)}`);
    fs.copyFileSync(bin, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

function run(cmd, args, onStdoutLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    p.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      if (onStdoutLine) {
        lineBuf += text;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop();
        for (const line of lines) onStdoutLine(line.trim());
      }
    });
    p.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`انتهى ${path.basename(cmd)} بالرمز ${code}: ${stderr.slice(-800)}`));
    });
  });
}

// ─── فحص المصدر بـ ffprobe ───
async function probeSource(bin, filePath) {
  const { stdout } = await run(bin, [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    filePath,
  ]);
  const meta = JSON.parse(stdout);
  const v = meta.streams.find((s) => s.codec_type === "video");
  const a = meta.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("المصدر لا يحتوي مسار فيديو صالح");
  const duration = Number(v.duration || meta.format?.duration || 0);
  let fps = 30;
  if (v.avg_frame_rate && v.avg_frame_rate !== "0/0") {
    const [n, d] = v.avg_frame_rate.split("/").map(Number);
    if (n && d) fps = n / d;
  }
  return {
    width: v.width,
    height: v.height,
    fps: Math.min(Math.max(fps, 1), 60),
    duration: Number.isFinite(duration) ? duration : 0,
    hasAudio: Boolean(a),
  };
}

// ─── تنزيل مصدر URL مع فرض حد الحجم أثناء التنزيل ───
async function downloadSource(url, filePath, onProgressBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`فشل تنزيل المصدر (HTTP ${res.status}) — قد يرفض المصدر التحميل`);
    }
    const maxBytes = LIMITS.sourceMaxMb * 1024 * 1024;
    let total = 0;
    const ws = fs.createWriteStream(filePath);
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        ws.destroy();
        throw new Error(`حجم المصدر يتجاوز ${LIMITS.sourceMaxMb}MB`);
      }
      if (!ws.write(chunk)) await new Promise((r) => ws.once("drain", r));
      onProgressBytes?.(total);
    }
    await new Promise((r) => ws.end(r));
    return total;
  } finally {
    clearTimeout(timer);
  }
}

function evenUp(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// ─── الدمج الكامل: توحيد كل المصادر ثم concat ثم ترميز نهائي ───
async function mergeVideos({ sources, onProgress }) {
  const ffmpeg = ensureExecutable(FFMPEG_PATH, "ffmpeg-x");
  const ffprobe = ensureExecutable(FFPROBE_PATH, "ffprobe-x");

  // 1) فحص كل مصدر (المصادر على القراءة المحلية في /tmp)
  const metas = [];
  for (const src of sources) {
    onProgress?.(8, "فحص المصادر");
    metas.push(await probeSource(ffprobe, src.path));
  }
  const totalDuration = metas.reduce((a, m) => a + m.duration, 0);
  if (totalDuration > LIMITS.maxTotalDurationSec) {
    throw new Error(
      `مجموع مدد المقاطع ${Math.round(totalDuration)} ثانية يتجاوز الحد ${LIMITS.maxTotalDurationSec} ثانية`
    );
  }

  // 2) الدقة الهدف: أكبر دقة بين المدخلات بحد أقصى 1920×1080 وبأبعاد زوجية
  const maxW = Math.max(...metas.map((m) => m.width));
  const maxH = Math.max(...metas.map((m) => m.height));
  const W = Math.min(evenUp(maxW), 1920);
  const H = Math.min(evenUp(maxH), 1080);

  // 3) بناء المدخلات: ملفات المصادر ثم مدخلات anullsrc للمصادر الصامتة
  const args = ["-y", "-v", "error"];
  const silentInputs = [];
  metas.forEach((m, i) => {
    args.push("-i", sources[i].path);
    if (!m.hasAudio) silentInputs.push(i);
  });
  const silentIdxBySource = new Map();
  for (const i of silentInputs) {
    silentIdxBySource.set(i, metas.length + silentIdxBySource.size);
    args.push("-f", "lavfi", "-t", String(Math.max(metas[i].duration, 0.1)), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }

  // 4) filter_complex: scale+pad إلى (W×H) + fps=30 + setsar=1 + yuv420p ثم concat
  const chains = [];
  const concatIn = [];
  metas.forEach((m, i) => {
    chains.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    concatIn.push(`[v${i}]`);
    if (m.hasAudio) {
      chains.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      const k = silentIdxBySource.get(i);
      chains.push(`[${k}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
    }
    concatIn.push(`[a${i}]`);
  });
  chains.push(`${concatIn.join("")}concat=n=${metas.length}:v=1:a=1[vout][aout]`);

  // 5) الترميز النهائي: libx264 CRF 18 + AAC 192k + faststart + progress
  args.push(
    "-filter_complex", chains.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-crf", "18", "-preset", process.env.FFMPEG_PRESET || "medium",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
  );
  const outPath = path.join(os.tmpdir(), `merge-out-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  args.push(outPath);

  onProgress?.(40, "بدء الترميز");
  await run(ffmpeg, args, (line) => {
    if (line.startsWith("out_time_us=")) {
      const us = Number(line.split("=")[1]);
      if (Number.isFinite(us) && totalDuration > 0) {
        const frac = Math.min(1, Math.max(0, us / 1e6 / totalDuration));
        onProgress?.(40 + Math.round(frac * 50), "ترميز الفيديو"); // 40–90
      }
    }
  });

  const size = fs.statSync(outPath).size;
  if (size > LIMITS.outputMaxMb * 1024 * 1024) {
    fs.unlinkSync(outPath);
    throw new Error(`حجم الناتج ${Math.round(size / 1024 / 1024)}MB يتجاوز الحد ${LIMITS.outputMaxMb}MB`);
  }
  onProgress?.(95, "حفظ الناتج");
  return { outPath, duration: totalDuration, size, resolution: `${W}x${H}` };
}

module.exports = { ensureExecutable, probeSource, downloadSource, mergeVideos };
