// ─── خادم MCP — الأدوات الخمس (قسم 8) ───
// نستخدم McpServer الرسمي. واجهة استدعاء الأدوات مُعاد توجيهها لضمان رسائل عربية
// للأدوات المجهولة والمعطيات التالفة (وصياغة النتائج عربية كما تشترط المواصفة).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  runGeneration,
  runMerge,
  refreshTask,
  publicView,
  NoKeysError,
  ParamsError,
  MergeInputError,
  TaskNotFoundError,
} from "../orchestrator";
import { listRecentTasks } from "../turso";
import { publicErrorMessage } from "../errors";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

interface ToolDef {
  input: z.ZodTypeAny;
  callback: (args: any, extra: any) => Promise<ToolResult>;
}

// استخراج progressToken من الطلب وبناء مُبثّ تقدم عبر notifications/progress
function progressNotifier(extra: unknown): (percent: number, message: string) => void {
  const token = (extra as { _meta?: { progressToken?: string | number } })?._meta?.progressToken;
  if (!token || typeof (extra as { sendNotification?: unknown })?.sendNotification !== "function") {
    return () => {};
  }
  return (percent, message) => {
    void (extra as { sendNotification: (n: unknown) => Promise<void> }).sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: percent, total: 100, message },
    }).catch(() => {});
  };
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function errorToResult(e: unknown): ToolResult {
  if (e instanceof NoKeysError) {
    return textResult(`❌ ${e.message}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`, true);
  }
  if (e instanceof MergeInputError) {
    return textResult(e.message, true);
  }
  if (e instanceof ParamsError) {
    return textResult(`❌ ${e.message}`, true);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return textResult(`❌ فشل تنفيذ الأداة: ${publicErrorMessage(msg)}`, true);
}

const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "✅ مكتملة",
  failed: "❌ فاشلة",
  processing: "⏳ جارية",
  pending: "⏳ جارية",
};

const TOOL_DEFS: Record<string, ToolDef> = {
  generate_image: {
    input: z.object({
      prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
      model: z
        .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
        .default("gpt-image-2-6/flare-text-to-image"),
      aspect_ratio: z
        .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
        .default("auto"),
      resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
      background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
      output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
      wait_seconds: z.number().int().min(0).max(240).default(90),
    }),
    callback: async (args, extra) => {
      const task = await runGeneration({
        type: "image",
        model: args.model,
        input: {
          prompt: args.prompt,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          background: args.background,
          output_format: args.output_format,
        },
        waitSeconds: args.wait_seconds,
        onProgress: progressNotifier(extra),
      });
      const v = publicView(task);
      return textResult(v.message, v.status === "failed");
    },
  },

  generate_video: {
    input: z.object({
      prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
      image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
      model: z
        .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
        .default("grok-imagine-video-1-5-preview"),
      aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
      resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
      enable_audio: z.boolean().default(true),
      duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
      wait_seconds: z.number().int().min(0).max(240).default(25),
    }),
    callback: async (args, extra) => {
      const task = await runGeneration({
        type: "video",
        model: args.model,
        input: {
          prompt: args.prompt,
          image_url: args.image_url,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          enable_audio: args.enable_audio,
          duration: args.duration,
        },
        waitSeconds: args.wait_seconds,
        onProgress: progressNotifier(extra),
      });
      const v = publicView(task);
      return textResult(v.message, v.status === "failed");
    },
  },

  merge_videos: {
    input: z.object({
      urls: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
      task_ids: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
      wait_seconds: z.number().int().min(0).max(240).default(60),
    }),
    callback: async (args, extra) => {
      const task = await runMerge({
        urls: args.urls,
        taskIds: args.task_ids,
        waitSeconds: args.wait_seconds,
        onProgress: progressNotifier(extra),
      });
      const v = publicView(task);
      return textResult(v.message, v.status === "failed");
    },
  },

  get_task: {
    input: z.object({ task_id: z.string().min(1) }),
    callback: async (args) => {
      let task;
      try {
        task = await refreshTask(args.task_id.trim());
      } catch (e) {
        if (e instanceof TaskNotFoundError) {
          return textResult(`❌ لا توجد مهمة بهذا المعرّف: ${args.task_id}`, true);
        }
        throw e;
      }
      if (!task) {
        return textResult(`❌ لا توجد مهمة بهذا المعرّف: ${args.task_id}`, true);
      }
      const v = publicView(task);
      return textResult(v.message, v.status === "failed");
    },
  },

  list_media: {
    input: z.object({
      type: z.enum(["image", "video", "merge"]).optional(),
      status: z.enum(["completed", "failed", "processing"]).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    callback: async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
      if (!tasks.length) {
        return textResult("لا توجد وسائط مخزنة بعد بهذه الفلاتر.");
      }
      const lines = tasks.map((t) => {
        const status = STATUS_AR[t.status] ?? t.status;
        let line = `- ${status} | ${TYPE_AR[t.type] ?? t.type} | الموديل: ${t.model} | task_id: ${t.id} | أُنشئت: ${t.created_at}`;
        if (t.status === "completed") {
          try {
            const urls = JSON.parse(t.result_urls_json || "[]");
            if (Array.isArray(urls) && urls.length) line += `\n  الروابط: ${urls.join(" , ")}`;
          } catch {
            /* لا روابط */
          }
        }
        return line;
      });
      return textResult(`أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n")}`);
    },
  },
};

export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // سجّل الأدوات الخمس رسميًا (تظهر في tools/list بمخططاتها الدقيقة)
  const descriptions: Record<string, string> = {
    generate_image:
      "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys in strict order). Returns the ready image URL if finished within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
    generate_video:
      "Generate a video with grok-imagine-video-1-5-preview (native synced audio — dialogue/music/SFX, optional image-to-video). Videos take minutes: short wait with live progress, then a task_id — track it with get_task every ~10 seconds.",
    merge_videos:
      "Merge multiple clips into ONE final video in the given order. Pass urls (public direct links — e.g. generate_video results) or task_ids (completed video tasks resolved from the database in this order — ideal after generating several clips). Merging is usually fast: short wait with progress, then a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
    get_task:
      "Track any task by its id — image/video generation AND merging (reads the database and refreshes live from the provider/service while running). Poll every ~10 seconds; when completed you'll find the result URLs — show them to the user and stop polling.",
    list_media:
      "Latest stored images/videos/merges with their URLs from the database (no regeneration) — to recall previous results.",
  };
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    server.registerTool(
      name,
      { description: descriptions[name], inputSchema: (def.input as z.ZodObject<z.ZodRawShape>).shape },
      // الاستدعاء الفعلي يمر عبر المعالج المخصص أدناه
      async () => textResult("unreachable")
    );
  }

  // معالج tools/call مخصص: رسائل عربية للأدوات المجهولة والمعطيات التالفة
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const def = TOOL_DEFS[name];
    if (!def) {
      return textResult(
        `❌ أداة غير معروفة: ${name}. المتاح: ${Object.keys(TOOL_DEFS).join(", ")}`,
        true
      );
    }
    let args: unknown;
    try {
      args = def.input.parse(request.params.arguments ?? {});
    } catch (e) {
      // رسائل عربية محددة لحدود الدمج (معيار القبول 9)
      if (name === "merge_videos" && e instanceof z.ZodError) {
        const raw = e.issues.map((i) => i.message).join("؛ ");
        if (raw.includes("at least 2")) {
          return textResult(
            "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
            true
          );
        }
        if (raw.includes("at most 10")) {
          return textResult("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", true);
        }
      }
      const issues =
        e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join(".") || "(الجذر)"}: ${i.message}`).join("؛ ")
          : String(e);
      return textResult(`❌ معطيات غير صالحة للأداة ${name}: ${issues}`, true);
    }
    try {
      return await def.callback(args, extra);
    } catch (e) {
      return errorToResult(e);
    }
  });

  return server;
}
