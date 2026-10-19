/**
 * Browser API client. Always same-origin /api/* (proxied server-side), never a
 * secret, never an arbitrary host. Every JSON body is validated with Zod.
 */
import type { z } from "zod";
import {
  CoverageResponseSchema,
  ErrorResponseSchema,
  ReadyResponseSchema,
  RecommendRequestSchema,
  RecommendResponseSchema,
  RecommendStreamEventSchema,
  SearchResponseSchema,
  type RecommendRequest,
  type RecommendResponse,
} from "./contracts";
import { parseLayer, type LayerResult, type MapLayer } from "./mapData";

export type ApiErrorKind = "offline" | "network" | "http" | "invalid_response" | "aborted" | "timeout";

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly requestId?: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Network failures, timeouts, 429 and 5xx are worth retrying with the same request. */
  get retryable(): boolean {
    if (this.kind === "network" || this.kind === "offline" || this.kind === "timeout") return true;
    if (this.kind === "http" && this.status !== undefined) return this.status === 429 || this.status >= 500;
    return false;
  }
}

const isOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false;

export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof ApiError && e.kind === "aborted") ||
    (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError")
  );
}

const HTTP_MESSAGES: Record<number, string> = {
  400: "Сервер не принял запрос.",
  404: "Не найдено.",
  413: "Запрос слишком большой.",
  422: "Сервер отклонил параметры запроса.",
  429: "Слишком много запросов. Подождите немного и повторите.",
  502: "Сервис подбора недоступен.",
  503: "Сервис временно недоступен.",
  504: "Сервер не ответил вовремя.",
};

async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("API path must be same-origin /api/*");
  if (isOffline()) throw new ApiError("offline", "Нет подключения к интернету.");
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: "application/json", ...init.headers }, cache: "no-store" });
  } catch (e) {
    if (isAbortError(e)) throw new ApiError("aborted", "Запрос отменён.");
    if (isOffline()) throw new ApiError("offline", "Нет подключения к интернету.");
    throw new ApiError("network", "Не удалось связаться с сервером.");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (e) {
    if (isAbortError(e)) throw new ApiError("aborted", "Запрос отменён.");
    body = null;
  }
  if (!res.ok) {
    const err = ErrorResponseSchema.safeParse(body);
    const fallback = HTTP_MESSAGES[res.status] ?? `Ошибка сервера (${res.status}).`;
    // The server message is shown as plain text (React escapes it), never as HTML.
    const message = err.success ? err.data.message || fallback : fallback;
    throw new ApiError("http", message, res.status, err.success ? err.data.error : undefined, err.success ? err.data.request_id : null);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    if (process.env.NODE_ENV !== "production") console.warn("Invalid API response", path, parsed.error.issues.slice(0, 5));
    throw new ApiError("invalid_response", "Сервер вернул ответ в неожиданном формате.", res.status);
  }
  return parsed.data;
}

export const getReady = (signal?: AbortSignal) => request("/api/ready", ReadyResponseSchema, { signal });
export const getCoverage = (signal?: AbortSignal) => request("/api/coverage", CoverageResponseSchema, { signal });
export const searchPlaces = (q: string, signal?: AbortSignal) =>
  request(`/api/search?${new URLSearchParams({ q }).toString()}`, SearchResponseSchema, { signal });

export async function getMapLayer(layer: MapLayer, signal?: AbortSignal): Promise<LayerResult> {
  if (isOffline()) throw new ApiError("offline", "Нет подключения к интернету.");
  let res: Response;
  try {
    res = await fetch(`/api/map/${layer}`, { signal, headers: { Accept: "application/geo+json, application/json" } });
  } catch (e) {
    if (isAbortError(e)) throw new ApiError("aborted", "Запрос отменён.");
    throw new ApiError("network", "Не удалось загрузить слой карты.");
  }
  if (!res.ok) throw new ApiError("http", `Слой карты «${layer}» недоступен (${res.status}).`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError("invalid_response", `Слой карты «${layer}» пришёл в неверном формате.`);
  }
  try {
    return parseLayer(layer, body);
  } catch {
    throw new ApiError("invalid_response", `Слой карты «${layer}» пришёл в неверном формате.`);
  }
}

/**
 * Long call (local CPU model: 30–190 s). Client timeout 220 s — above the web proxy (210 s) and the
 * API REQUEST_TIMEOUT_SECONDS (200 s), so the server's own timeout/degradation answer arrives first.
 * Cancellable via signal.
 */
export async function postRecommend(req: RecommendRequest, signal: AbortSignal, timeoutMs = 220_000): Promise<RecommendResponse> {
  const body = RecommendRequestSchema.parse(req);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort);
  try {
    const resp = await request("/api/recommend", RecommendResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
    if (resp.client_request_id !== req.client_request_id) {
      throw new ApiError("invalid_response", "Ответ сервера относится к другому запросу.");
    }
    return resp;
  } catch (e) {
    if (e instanceof ApiError && e.kind === "aborted" && !signal.aborted) {
      throw new ApiError("timeout", "Сервер не ответил за 220 секунд.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Streaming variant (POST /api/recommend/stream, NDJSON). `onPreliminary` receives the places found
 * by retrieval as soon as the server has them (before the slow CPU generation finishes); the promise
 * resolves with the final answer. Same timeout/cancellation semantics as postRecommend.
 */
export async function postRecommendStream(
  req: RecommendRequest,
  signal: AbortSignal,
  onPreliminary: (r: RecommendResponse) => void,
  timeoutMs = 220_000,
): Promise<RecommendResponse> {
  const body = RecommendRequestSchema.parse(req);
  if (isOffline()) throw new ApiError("offline", "Нет подключения к интернету.");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort);
  const own = (r: RecommendResponse) => {
    if (r.client_request_id !== req.client_request_id) {
      throw new ApiError("invalid_response", "Ответ сервера относится к другому запросу.");
    }
    return r;
  };
  try {
    let res: Response;
    try {
      res = await fetch("/api/recommend/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(body),
        signal: timeout.signal,
        cache: "no-store",
      });
    } catch (e) {
      if (isAbortError(e)) throw new ApiError("aborted", "Запрос отменён.");
      throw new ApiError("network", "Не удалось связаться с сервером.");
    }
    if (!res.ok || !res.body) {
      let errBody: unknown = null;
      try {
        errBody = await res.json();
      } catch {
        errBody = null;
      }
      const err = ErrorResponseSchema.safeParse(errBody);
      const fallback = HTTP_MESSAGES[res.status] ?? `Ошибка сервера (${res.status}).`;
      throw new ApiError("http", err.success ? err.data.message || fallback : fallback, res.status, err.success ? err.data.error : undefined);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handle = (line: string): RecommendResponse | null => {
      if (!line.trim()) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new ApiError("invalid_response", "Сервер вернул ответ в неожиданном формате.", res.status);
      }
      const ev = RecommendStreamEventSchema.safeParse(raw);
      if (!ev.success) throw new ApiError("invalid_response", "Сервер вернул ответ в неожиданном формате.", res.status);
      if (ev.data.event === "preliminary") {
        onPreliminary(own(ev.data.response));
        return null;
      }
      if (ev.data.event === "error") {
        const status = ev.data.error.error === "timeout" ? 504 : 500;
        throw new ApiError("http", ev.data.error.message, status, ev.data.error.error, ev.data.error.request_id);
      }
      return own(ev.data.response);
    };
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (isAbortError(e) || timeout.signal.aborted) throw new ApiError("aborted", "Запрос отменён.");
        throw new ApiError("network", "Соединение с сервером прервалось.");
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const final = handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (final) return final;
      }
    }
    const final = handle(buf);
    if (final) return final;
    throw new ApiError("network", "Сервер не прислал итоговый ответ.");
  } catch (e) {
    if (e instanceof ApiError && e.kind === "aborted" && !signal.aborted) {
      throw new ApiError("timeout", "Сервер не ответил за 220 секунд.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
