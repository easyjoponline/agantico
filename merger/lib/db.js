// ─── طبقة قاعدة البيانات (Turso / libSQL عبر HTTP) ───
// كل شيء في Turso: بيانات المهام، أجزاء الملفات (Blobs)، والفيديو الناتج.
const { createClient } = require("@libsql/client");

let _client = null;
let _schema = null;

function getDb() {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

async function ensureSchema() {
  if (!_schema) {
    _schema = (async () => {
      const db = getDb();
      await db.execute(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        error TEXT,
        output_size INTEGER,
        output_duration REAL,
        output_resolution TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS sources (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        url TEXT,
        name TEXT,
        mime TEXT,
        size INTEGER,
        total_chunks INTEGER,
        uploaded_chunks INTEGER DEFAULT 0,
        uploaded_bytes INTEGER DEFAULT 0,
        PRIMARY KEY (job_id, seq)
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS source_chunks (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, seq, chunk_index)
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, chunk_index)
      )`);
    })().catch((e) => {
      _schema = null;
      throw e;
    });
  }
  return _schema;
}

function nowIso() {
  return new Date().toISOString();
}

function newJobId() {
  return require("node:crypto").randomUUID().replace(/-/g, "").slice(0, 12);
}

// ─── عمليات المهام ───
async function createJob(sources, status) {
  await ensureSchema();
  const id = newJobId();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + LIMITS_HOURS() * 3600 * 1000).toISOString();
  await getDb().batch(
    [
      {
        sql: `INSERT INTO jobs (id, status, progress, expires_at, created_at, updated_at)
              VALUES (?, ?, 0, ?, ?, ?)`,
        args: [id, status, expiresAt, now, now],
      },
      ...sources.map((s, i) => ({
        sql: `INSERT INTO sources (job_id, seq, kind, url, name, mime, size, total_chunks, uploaded_chunks)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        args: [id, i, s.kind, s.url || null, s.name || null, s.mime || null, s.size ?? null, s.totalChunks ?? null],
      })),
    ],
    "write"
  );
  return { id, expiresAt };
}

function LIMITS_HOURS() {
  const { LIMITS } = require("./util");
  return LIMITS.expiresHours;
}

async function getJob(id) {
  await ensureSchema();
  const r = await getDb().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
  return r.rows[0] || null;
}

async function getSources(jobId) {
  const r = await getDb().execute({
    sql: "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [jobId],
  });
  return r.rows;
}

async function updateJob(id, patch) {
  const sets = [];
  const args = [];
  for (const k of ["status", "progress", "error", "output_size", "output_duration", "output_resolution"]) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      args.push(patch[k]);
    }
  }
  sets.push("updated_at = ?");
  args.push(nowIso());
  args.push(id);
  await getDb().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

// ─── أجزاء الملفات المرفوعة (Blobs 2MB) ───
async function writeSourceChunks(jobId, seq, buf) {
  const { LIMITS } = require("./util");
  const stmts = [];
  for (let off = 0, idx = 0; off < buf.length; off += LIMITS.storeChunkBytes, idx++) {
    stmts.push({
      sql: "INSERT INTO source_chunks (job_id, seq, chunk_index, data) VALUES (?, ?, ?, ?)",
      args: [jobId, seq, idx, buf.subarray(off, Math.min(off + LIMITS.storeChunkBytes, buf.length))],
    });
  }
  if (stmts.length) await getDb().batch(stmts, "write");
}

// استعادة ملف مصدر من الأجزاء إلى /tmp — صفحات من 8 صفوف
async function readSourceChunksToFile(jobId, seq, filePath) {
  const fs = require("node:fs");
  const ws = fs.createWriteStream(filePath);
  let offset = 0;
  for (;;) {
    const r = await getDb().execute({
      sql: "SELECT chunk_index, data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk_index ASC LIMIT 8 OFFSET ?",
      args: [jobId, seq, offset],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      await new Promise((res, rej) => {
        ws.write(Buffer.from(row.data), (err) => (err ? rej(err) : res()));
      });
    }
    offset += r.rows.length;
  }
  await new Promise((res) => ws.end(res));
}

async function incrementUploaded(jobId, seq, addBytes) {
  await getDb().execute({
    sql: `UPDATE sources SET uploaded_chunks = uploaded_chunks + 1, uploaded_bytes = uploaded_bytes + ?
          WHERE job_id = ? AND seq = ?`,
    args: [addBytes, jobId, seq],
  });
}

// ─── تخزين الناتج (Blobs 2MB) ───
async function storeOutput(jobId, filePath) {
  const { LIMITS } = require("./util");
  const fs = require("node:fs");
  const data = await fs.promises.readFile(filePath);
  const stmts = [];
  for (let off = 0, idx = 0; off < data.length; off += LIMITS.storeChunkBytes, idx++) {
    stmts.push({
      sql: "INSERT INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)",
      args: [jobId, idx, data.subarray(off, Math.min(off + LIMITS.storeChunkBytes, data.length))],
    });
    // دفعات 10 صفوف لتفادي طلبات ضخمة جدًا
    if (stmts.length === 10) {
      await getDb().batch(stmts, "write");
      stmts.length = 0;
    }
  }
  if (stmts.length) await getDb().batch(stmts, "write");
  return data.length;
}

// قراءة صفحات من الناتج (للبث مع Range)
async function readOutputChunks(jobId, offset, limit) {
  const r = await getDb().execute({
    sql: "SELECT chunk_index, data FROM output_chunks WHERE job_id = ? ORDER BY chunk_index ASC LIMIT ? OFFSET ?",
    args: [jobId, limit, offset],
  });
  return r.rows;
}

async function outputChunkCount(jobId) {
  const r = await getDb().execute({
    sql: "SELECT COUNT(*) AS c FROM output_chunks WHERE job_id = ?",
    args: [jobId],
  });
  return Number(r.rows[0]?.c ?? 0);
}

// ─── الحذف الشامل (jobs + sources + source_chunks + output_chunks) ───
async function deleteJob(id) {
  await ensureSchema();
  await getDb().batch(
    [
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
    ],
    "write"
  );
}

// ─── التنظيف الكسول: حذف المهام المنتهية (+24 ساعة) ───
async function purgeExpired() {
  await ensureSchema();
  const now = nowIso();
  const r = await getDb().execute({
    sql: "SELECT id FROM jobs WHERE expires_at < ?",
    args: [now],
  });
  const ids = r.rows.map((row) => String(row.id));
  for (const id of ids) {
    await deleteJob(id);
  }
  return ids.length;
}

module.exports = {
  getDb,
  ensureSchema,
  createJob,
  getJob,
  getSources,
  updateJob,
  writeSourceChunks,
  readSourceChunksToFile,
  incrementUploaded,
  storeOutput,
  readOutputChunks,
  outputChunkCount,
  deleteJob,
  purgeExpired,
};
