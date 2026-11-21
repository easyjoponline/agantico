import { createClient, type Client } from "@libsql/client";

// عميل Turso واحد (libSQL عبر HTTP — متوافق مع Vercel serverless، لا ملفات محلية).
// الإنشاء كسول: حتى لا يفشل next build عند غياب متغيرات البيئة (تُقرأ وقت التنفيذ فقط).
let _client: Client | null = null;
let _schemaPromise: Promise<void> | null = null;

export function getDb(): Client {
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

// إنشاء الجداول عند أول وصول — بلا أداة migrations
export function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const db = getDb();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    })().catch((e) => {
      _schemaPromise = null; // اسمح بإعادة المحاولة عند الفشل
      throw e;
    });
  }
  return _schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getDb().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// ─── أنواع الصفوف ───
export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string;
  prompt: string;
  params_json: string;
  status: string;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface KeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

function mapTask(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    provider: row.provider == null ? null : String(row.provider),
    provider_task_id: row.provider_task_id == null ? null : String(row.provider_task_id),
    key_id: row.key_id == null ? null : String(row.key_id),
    model: String(row.model),
    type: String(row.type),
    prompt: String(row.prompt ?? ""),
    params_json: String(row.params_json ?? "{}"),
    status: String(row.status),
    progress: Number(row.progress ?? 0),
    result_urls_json: row.result_urls_json == null ? null : String(row.result_urls_json),
    error_message: row.error_message == null ? null : String(row.error_message),
    attempts_json: String(row.attempts_json ?? "[]"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
  };
}

function mapKey(row: Record<string, unknown>): KeyRow {
  return {
    id: String(row.id),
    provider: String(row.provider),
    label: String(row.label ?? ""),
    api_key: String(row.api_key),
    status: String(row.status ?? "active"),
    usage_count: Number(row.usage_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    fail_count: Number(row.fail_count ?? 0),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
    last_checked_at: row.last_checked_at == null ? null : String(row.last_checked_at),
    last_error: row.last_error == null ? null : String(row.last_error),
    created_at: String(row.created_at ?? ""),
  };
}

// ─── عمليات المهام ───
export async function insertTask(t: {
  id: string;
  provider?: string;
  provider_task_id?: string;
  key_id?: string;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status: string;
  progress?: number;
}): Promise<TaskRow> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status,
      t.progress ?? 0,
    ],
  });
  return (await getTask(t.id))!;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return r.rows.length ? mapTask(r.rows[0] as unknown as Record<string, unknown>) : null;
}

// تحديث جزئي (patch) — يضيف المحاولات ويضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(id: string, patch: Partial<TaskRow>): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const fields: [string, string | number | null][] = [];
  if (patch.provider !== undefined) fields.push(["provider", patch.provider]);
  if (patch.provider_task_id !== undefined) fields.push(["provider_task_id", patch.provider_task_id]);
  if (patch.key_id !== undefined) fields.push(["key_id", patch.key_id]);
  if (patch.model !== undefined) fields.push(["model", patch.model]);
  if (patch.prompt !== undefined) fields.push(["prompt", patch.prompt]);
  if (patch.params_json !== undefined) fields.push(["params_json", patch.params_json]);
  if (patch.status !== undefined) fields.push(["status", patch.status]);
  if (patch.progress !== undefined) fields.push(["progress", patch.progress]);
  if (patch.result_urls_json !== undefined) fields.push(["result_urls_json", patch.result_urls_json]);
  if (patch.error_message !== undefined) fields.push(["error_message", patch.error_message]);
  if (patch.attempts_json !== undefined) fields.push(["attempts_json", patch.attempts_json]);
  for (const [k, v] of fields) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (patch.status === "completed") {
    sets.push("completed_at = datetime('now')");
    sets.push("progress = 100");
  }
  sets.push("updated_at = datetime('now')");
  if (!sets.length) return;
  args.push(id);
  await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: string[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(String(limit));
  const r = await getDb().execute({ sql, args });
  return r.rows.map((row) => mapTask(row as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  await ensureSchema();
  const r = await getDb().execute("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status");
  const by: Record<string, number> = {};
  for (const row of r.rows) {
    by[String(row.status)] = Number(row.c);
  }
  return {
    total: Object.values(by).reduce((a, b) => a + b, 0),
    completed: by["completed"] ?? 0,
    failed: by["failed"] ?? 0,
    processing: by["processing"] ?? 0 + (by["pending"] ?? 0),
  };
}

// ─── عمليات المفاتيح ───
export async function insertKey(k: {
  id: string;
  provider: string;
  label?: string;
  api_key: string;
}): Promise<KeyRow> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label ?? "", k.api_key],
  });
  return (await getKey(k.id))!;
}

export async function getKey(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return r.rows.length ? mapKey(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const r = await getDb().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return r.rows.map((row) => mapKey(row as unknown as Record<string, unknown>));
}

export async function updateKey(id: string, patch: Partial<KeyRow>): Promise<void> {
  await ensureSchema();
  const fields: string[] = [];
  const args: (string | number | null)[] = [];
  for (const k of ["label", "status", "last_error", "last_used_at", "last_checked_at"] as const) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      args.push(patch[k] as string | null);
    }
  }
  for (const k of ["usage_count", "success_count", "fail_count"] as const) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      args.push(patch[k] as number);
    }
  }
  if (!fields.length) return;
  args.push(id);
  await getDb().execute({ sql: `UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`, args });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

// حذف المهام (للتنظيف)
export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}
