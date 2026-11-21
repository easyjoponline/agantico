// اختيار المحوّل المناسب لكل مزود (ملف منفصل لتفادي الاستيراد الدائري)
import type { ProviderId } from "./models";
import type { ProviderAdapter } from "./providers/types";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";

export function getAdapter(provider: ProviderId): ProviderAdapter {
  if (provider === "kie") return kieAdapter;
  return cometapiAdapter;
}
