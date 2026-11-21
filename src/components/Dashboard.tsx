"use client";

// ─── لوحة الإدارة العربية (قسم 9): مدير المفاتيح + لوحة المهام + بطاقة الربط ───
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── أنواع البيانات ───
interface PublicKey {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_error: string | null;
  created_at: string;
}
interface PublicTask {
  id: string;
  type: string;
  model: string;
  provider: string | null;
  status: string;
  progress: number;
  prompt: string;
  urls: string[];
  error: string | null;
  attempts: number;
  created_at: string;
}
interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

const TOOLS_INFO = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي (gpt-image-2-6/flare-text-to-image) مع تبديل مفاتيح تلقائي." },
  { name: "generate_video", desc: "توليد فيديو مع صوت متزامن (grok-imagine-video-1-5-preview)، image-to-video اختياري." },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب (حتى 10 مقاطع)." },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وعرض روابط النتائج." },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها دون إعادة توليد." },
];

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  exhausted: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  disabled: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};
const STATUS_LABEL_AR: Record<string, string> = {
  active: "نشط",
  exhausted: "مستنزف",
  disabled: "معطّل",
};
const TASK_BADGE: Record<string, string> = {
  completed: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/15 text-red-400 border-red-500/30",
  processing: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30 animate-pulse-soft",
  pending: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
};
const TASK_LABEL_AR: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "بانتظار",
};
const TYPE_LABEL_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };

function CopyButton({ text, label = "نسخ" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* المتصفح منع النسخ */
        }
      }}
      className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-500/20"
    >
      {copied ? "✓ تم النسخ" : label}
    </button>
  );
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<PublicKey[]>([]);
  const [tasks, setTasks] = useState<PublicTask[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [origin, setOrigin] = useState("");
  const pollRef = useRef(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const j = await r.json();
      setTasks(j.tasks ?? []);
      if (j.stats) setStats(j.stats);
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadKeys();
    loadTasks();
    const t = setInterval(() => {
      loadTasks();
      loadHealth();
    }, 5000);
    return () => clearInterval(t);
  }, [loadHealth, loadKeys, loadTasks]);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    pollRef.current = true;
    setKeyMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const j = await r.json();
      if (!r.ok) {
        setKeyMsg({ ok: false, text: j.error ?? "فشل الإضافة" });
      } else {
        setKeyMsg({ ok: true, text: "أُضيف المفتاح — سيُجرَّب أولًا في الترتيب التسلسلي" });
        setApiKey("");
        setLabel("");
        await loadKeys();
      }
    } finally {
      pollRef.current = false;
    }
  }

  async function toggleKey(k: PublicKey) {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    loadKeys();
  }

  async function removeKey(k: PublicKey) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    loadKeys();
  }

  const mcpUrl = origin ? `${origin}/mcp` : "<origin>/mcp";
  const authHeader = health?.authRequired ? `"Authorization": "Bearer <MCP_ACCESS_TOKEN>",` : "";

  const connectJson = useMemo(() => {
    if (tab === "claude") {
      return `{ "mcpServers": { "media-generator": { "type": "http", "url": "${mcpUrl}"${authHeader ? "\n  ," : ""}${authHeader} } } }`;
    }
    if (tab === "cursor") {
      return `{ "mcpServers": { "media-generator": { "url": "${mcpUrl}"${authHeader ? "\n  ," : ""}${authHeader} } } }`;
    }
    return `{ "mcpServers": { "media-generator": { "url": "${mcpUrl}"${authHeader ? "\n  ," : ""}${authHeader} } } }`;
  }, [tab, mcpUrl, authHeader]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* الهيدر */}
      <header className="mb-8 rounded-2xl border border-slate-800 bg-gradient-to-l from-cyan-950/60 via-slate-900 to-purple-950/60 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold sm:text-3xl">
              <span className="bg-gradient-to-l from-cyan-400 to-purple-400 bg-clip-text text-transparent">
                MCP Media Generator
              </span>
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              خادم MCP لتوليد الصور والفيديو ودمج المقاطع — إدارة المفاتيح والمهام والربط
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            {health === null ? (
              <span className="rounded-full border border-slate-600 bg-slate-800 px-3 py-1.5 text-slate-300">
                جارٍ الفحص…
              </span>
            ) : health.ok ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-emerald-400">
                ● Turso متصل
              </span>
            ) : (
              <span className="rounded-full border border-red-500/30 bg-red-500/15 px-3 py-1.5 text-red-400">
                ● غير متصل
              </span>
            )}
            {health && (
              <span
                className={`rounded-full border px-3 py-1.5 ${
                  health.merger.healthy
                    ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
                    : "border-amber-500/30 bg-amber-500/15 text-amber-400"
                }`}
              >
                ● الدمج {health.merger.healthy ? "جاهز" : "غير مضبوط"}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* أ) مدير المفاتيح */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="mb-1 text-lg font-bold text-cyan-300">مدير المفاتيح</h2>
          <p className="mb-4 text-xs leading-6 text-slate-400">
            أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
            تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
          </p>
          <form onSubmit={addKey} className="mb-4 grid gap-2 sm:grid-cols-2">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
            >
              <option value="kie">kie.ai</option>
              <option value="cometapi">CometAPI</option>
            </select>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="تسمية اختيارية"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
            />
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="المفتاح الكامل (يُخفى بعد الحفظ)"
              required
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm sm:col-span-2"
              dir="ltr"
            />
            <button
              type="submit"
              className="rounded-lg bg-gradient-to-l from-cyan-600 to-purple-600 px-4 py-2 text-sm font-bold sm:col-span-2 hover:opacity-90"
            >
              إضافة المفتاح
            </button>
          </form>
          {keyMsg && (
            <p className={`mb-3 text-xs ${keyMsg.ok ? "text-emerald-400" : "text-red-400"}`}>
              {keyMsg.ok ? "✓ " : "✗ "}
              {keyMsg.text}
            </p>
          )}
          <div className="space-y-3">
            {keys.length === 0 && (
              <p className="rounded-lg border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">
                لا توجد مفاتيح بعد — أضف أول مفتاح لبدء التوليد
              </p>
            )}
            {keys.map((k) => (
              <div key={k.id} className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-slate-900 px-2 py-1 text-xs text-cyan-300" dir="ltr">
                    {k.maskedKey}
                  </code>
                  <span className="text-xs text-slate-400">
                    {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                  </span>
                  {k.label && <span className="text-xs text-slate-300">{k.label}</span>}
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                      STATUS_BADGE[k.status] ?? STATUS_BADGE.disabled
                    }`}
                  >
                    {STATUS_LABEL_AR[k.status] ?? k.status}
                  </span>
                  <div className="ms-auto flex gap-1">
                    <button
                      onClick={() => toggleKey(k)}
                      className="rounded border border-slate-600 px-2 py-1 text-[11px] hover:bg-slate-700"
                    >
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </button>
                    <button
                      onClick={() => removeKey(k)}
                      className="rounded border border-red-500/40 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10"
                    >
                      حذف
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                  <span>استخدام: {k.usage_count}</span>
                  <span>نجاح: {k.success_count}</span>
                  <span>فشل: {k.fail_count}</span>
                  <span>أُضيف: {k.created_at}</span>
                </div>
                {k.last_error && (
                  <p className="mt-1 text-[11px] text-red-400/80" dir="ltr">
                    آخر خطأ: {k.last_error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ب) لوحة المهام */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="mb-4 text-lg font-bold text-purple-300">لوحة المهام</h2>
          <div className="mb-4 grid grid-cols-4 gap-2 text-center">
            {[
              { label: "الإجمالي", value: stats.total, cls: "text-slate-200" },
              { label: "مكتملة", value: stats.completed, cls: "text-emerald-400" },
              { label: "فاشلة", value: stats.failed, cls: "text-red-400" },
              { label: "جارية", value: stats.processing, cls: "text-cyan-300" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
                <div className={`text-xl font-extrabold ${s.cls}`}>{s.value}</div>
                <div className="text-[11px] text-slate-400">{s.label}</div>
              </div>
            ))}
          </div>
          <div className="space-y-3">
            {tasks.length === 0 && (
              <p className="rounded-lg border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">
                لا توجد مهام بعد — استدعِ أدوات التوليد من أي عميل MCP
              </p>
            )}
            {tasks.map((t) => (
              <div key={t.id} className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-slate-200">{TYPE_LABEL_AR[t.type] ?? t.type}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                      TASK_BADGE[t.status] ?? TASK_BADGE.pending
                    }`}
                  >
                    {TASK_LABEL_AR[t.status] ?? t.status}
                  </span>
                  <span className="text-slate-400" dir="ltr">
                    {t.model}
                  </span>
                  <span className="text-slate-500">
                    محاولات: {t.attempts}
                  </span>
                  <span className="ms-auto text-slate-500">{t.created_at}</span>
                </div>
                {t.status !== "completed" && t.status !== "failed" && (
                  <div className="progress-track mt-2 h-2">
                    <div className="progress-fill" style={{ width: `${t.progress}%` }} />
                  </div>
                )}
                <p className="mt-2 truncate text-[11px] text-slate-400">{t.prompt || "—"}</p>
                {t.error && <p className="mt-1 text-[11px] text-red-400/80">{t.error}</p>}
                {t.urls.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.urls.map((u, i) => (
                      <a
                        key={i}
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/20"
                      >
                        فتح النتيجة ↗
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ج) ربط السيرفر */}
      <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="mb-4 text-lg font-bold text-cyan-300">ربط السيرفر</h2>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <code className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-cyan-300" dir="ltr">
            {mcpUrl}
          </code>
          <CopyButton text={mcpUrl} label="نسخ الرابط" />
        </div>
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          {[
            { id: "chatgpt", label: "ChatGPT / GPT Agents" },
            { id: "claude", label: "Claude Desktop" },
            { id: "cursor", label: "Cursor / Windsurf / Cline" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as typeof tab)}
              className={`rounded-lg border px-3 py-1.5 font-semibold ${
                tab === t.id
                  ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-300"
                  : "border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <pre
            className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950 pt-12 pr-4 pb-4 pl-4 text-xs leading-6 text-slate-200"
            dir="ltr"
          >
            {connectJson}
          </pre>
          <div className="absolute left-3 top-3">
            <CopyButton text={connectJson} />
          </div>
        </div>
        {tab === "chatgpt" && (
          <p className="mt-2 text-xs text-slate-400">
            في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
          </p>
        )}
        {tab === "claude" && (
          <p className="mt-2 text-xs text-slate-400">
            احفظ الكود في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.
          </p>
        )}
        {tab === "cursor" && (
          <p className="mt-2 text-xs text-slate-400">
            احفظ الكود في ملف mcp.json لـ Cursor / Windsurf / Cline.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {TOOLS_INFO.map((t) => (
            <span
              key={t.name}
              className="rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs text-purple-300"
              title={t.desc}
            >
              {t.name}
            </span>
          ))}
        </div>
        <ul className="mt-3 space-y-1 text-[11px] text-slate-400">
          {TOOLS_INFO.map((t) => (
            <li key={t.name}>
              <span className="font-semibold text-slate-300">{t.name}:</span> {t.desc}
            </li>
          ))}
        </ul>

        <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-6 text-amber-300">
          ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10
          ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي
          (Progress notifications) حتى لا تنقطع العملية.
        </div>
      </section>

      <footer className="mt-8 pb-6 text-center text-[11px] text-slate-500">
        لا تُنزَّل أي وسائط على السيرفر — تُخزَّن روابط النتائج فقط في قاعدة البيانات.
      </footer>
    </main>
  );
}
