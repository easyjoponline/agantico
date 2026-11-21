// ─── سجل الموديلات (قسم 5.1) ───
// الموديلان المدمجان مثبتان كما هما، مع قبول الصيغ البديلة بالنقاط وتوحيدُها.
// أسماء الموديلات لدى كل مزود قابلة للتجاوز بمتغيرات البيئة.

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

export const IMAGE_CANONICAL = "gpt-image-2-6/flare-text-to-image";
export const VIDEO_CANONICAL = "grok-imagine-video-1-5-preview";

export const MODELS: Record<string, ModelDef> = {
  [IMAGE_CANONICAL]: {
    canonical: IMAGE_CANONICAL,
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_IMAGE_MODEL || IMAGE_CANONICAL,
      cometapi: process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image",
    },
  },
  [VIDEO_CANONICAL]: {
    canonical: VIDEO_CANONICAL,
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_VIDEO_MODEL || VIDEO_CANONICAL,
      cometapi: process.env.COMETAPI_VIDEO_MODEL || VIDEO_CANONICAL,
    },
  },
};

export function listModelsForHealth(): { canonical: string; type: MediaType; providers: ProviderId[] }[] {
  return Object.values(MODELS).map((m) => ({
    canonical: m.canonical,
    type: m.type,
    providers: m.providers,
  }));
}

// توحيد الاسم: قبول الشرطات/النقاط البديلة (gpt-image-2.6/... ↔ gpt-image-2-6/...)
export function resolveModel(name: string | undefined): ModelDef | null {
  if (!name) return MODELS[IMAGE_CANONICAL];
  const trimmed = name.trim();
  if (MODELS[trimmed]) return MODELS[trimmed];
  const dotted = trimmed.replace(/(\d)\.(\d)/g, "$1-$2"); // 2.6 → 2-6 ، 1.5 → 1-5
  if (MODELS[dotted]) return MODELS[dotted];
  for (const def of Object.values(MODELS)) {
    if (def.aliases.includes(trimmed)) return def;
    if (def.aliases.includes(dotted)) return def;
  }
  return null;
}
