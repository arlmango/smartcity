/**
 * Who processes the user's text: derived from the API (/api/ready component details and the
 * `providers` block of the last /api/recommend response). No secrets, no guessing: if the API
 * does not say, the UI says it is unknown.
 */
import type { ReadyResponse, RecommendResponse } from "./contracts";

export type ProviderKind = "ollama" | "openai_compatible" | "none" | "unknown";

export interface ProviderLine {
  role: "llm" | "embeddings";
  kind: ProviderKind;
  model: string | null;
  external: boolean;
  text: string;
}

const ROLE_LABEL = { llm: "Языковая модель", embeddings: "Поиск по смыслу (embeddings)" } as const;

export function parseDetail(detail: string | undefined): { kind: ProviderKind; model: string | null } {
  const m = /^(ollama|openai_compatible):([^,\s@]+)/.exec(detail ?? "");
  if (m) return { kind: m[1] as ProviderKind, model: m[2] ?? null };
  if (/=none\b/.test(detail ?? "")) return { kind: "none", model: null };
  return { kind: "unknown", model: null };
}

function normalizeKind(p: string | null | undefined): ProviderKind {
  if (p === "ollama" || p === "openai_compatible") return p;
  if (p === null) return "none";
  return "unknown";
}

function lineFor(role: ProviderLine["role"], kind: ProviderKind, model: string | null, status?: string): ProviderLine {
  const label = ROLE_LABEL[role];
  const m = model ? ` (${model})` : "";
  switch (kind) {
    case "ollama":
      return {
        role,
        kind,
        model,
        external: false,
        text: `${label}: локальная модель (Ollama)${m} — текст не покидает сервер${status && status !== "ok" ? "; сейчас недоступна" : ""}.`,
      };
    case "openai_compatible":
      return {
        role,
        kind,
        model,
        external: true,
        text: `${label}: текст запроса отправляется внешнему провайдеру (OpenAI-совместимый API)${m}. Адрес провайдера задан администратором сервера.`,
      };
    case "none":
      return { role, kind, model: null, external: false, text: `${label}: не подключена — ${role === "llm" ? "объяснения ИИ не генерируются" : "поиск только по словам и расстоянию"}.` };
    default:
      return { role, kind, model: null, external: false, text: `${label}: провайдер неизвестен (API не сообщил).` };
  }
}

export function describeProviders(
  ready: ReadyResponse | undefined,
  providers: RecommendResponse["providers"] | undefined,
): ProviderLine[] {
  const out: ProviderLine[] = [];
  for (const role of ["llm", "embeddings"] as const) {
    const comp = ready?.components[role];
    const fromReady = parseDetail(comp?.detail);
    const fromResp = providers
      ? {
          kind: normalizeKind(role === "llm" ? providers.llm_provider : providers.embedding_provider),
          model: (role === "llm" ? providers.llm_model : providers.embedding_model) ?? null,
        }
      : null;
    const pick = fromResp && fromResp.kind !== "unknown" ? fromResp : fromReady;
    if (!comp && !fromResp) continue;
    out.push(lineFor(role, pick.kind, pick.model, comp?.status));
  }
  return out;
}

export const hasExternalProvider = (lines: ProviderLine[]): boolean => lines.some((l) => l.external);
