import type { Detail } from "./mapStyle";

interface Env {
  search?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  saveData?: boolean;
  coarsePointer?: boolean;
}

/**
 * Map detail for this device. "low": no procedural facades or contact shadows, coarser landmark models
 * and a capped pixel ratio. A heuristic (browsers expose little), overridable with ?detail=low|high.
 */
export function detailTier(env: Env): Detail {
  const forced = new URLSearchParams(env.search ?? "").get("detail");
  if (forced === "low" || forced === "high") return forced;
  if (env.saveData) return "low";
  if (env.deviceMemory !== undefined && env.deviceMemory <= 3) return "low";
  // Phones and tablets with few cores struggle most with many extruded walls at 3× density.
  if (env.coarsePointer && env.hardwareConcurrency !== undefined && env.hardwareConcurrency <= 4) return "low";
  return "high";
}

export function browserDetailTier(): Detail {
  if (typeof window === "undefined") return "high";
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return detailTier({
    search: window.location.search,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    saveData: nav.connection?.saveData,
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches,
  });
}
