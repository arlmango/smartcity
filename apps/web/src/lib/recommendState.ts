/**
 * Recommendation request state. Pure reducer so the race protection (T24) is unit-testable:
 * a response or error is applied only if it belongs to the currently active client_request_id.
 */
import type { ConversationTurn, RecommendRequest, RecommendResponse } from "./contracts";

export type RequestStatus = "idle" | "loading" | "success" | "error";

export interface RequestErrorInfo {
  kind: string;
  message: string;
  retryable: boolean;
  status?: number;
}

export interface RecommendState {
  status: RequestStatus;
  /** client_request_id of the request whose answer we are waiting for. */
  activeId: string | null;
  /** The request currently in flight, or the one that produced `response` / `error`. */
  request: RecommendRequest | null;
  /** Request that produced the displayed response (refinements are derived from it). */
  responseRequest: RecommendRequest | null;
  response: RecommendResponse | null;
  error: RequestErrorInfo | null;
  startedAt: number | null;
  cancelled: boolean;
  /** Tab-memory only conversation (never persisted), at most 6 turns. */
  context: ConversationTurn[];
  pendingUserTurn: string | null;
}

export type RecommendAction =
  | { type: "start"; request: RecommendRequest; at: number; userTurn: string }
  | { type: "success"; id: string; response: RecommendResponse }
  | { type: "failure"; id: string; error: RequestErrorInfo }
  | { type: "cancel"; id: string }
  | { type: "reset" };

export const MAX_CONTEXT_TURNS = 6;
const TURN_MAX_CHARS = 500;

export const initialRecommendState: RecommendState = {
  status: "idle",
  activeId: null,
  request: null,
  responseRequest: null,
  response: null,
  error: null,
  startedAt: null,
  cancelled: false,
  context: [],
  pendingUserTurn: null,
};

const clip = (s: string): string => (s.length > TURN_MAX_CHARS ? `${s.slice(0, TURN_MAX_CHARS - 1)}…` : s);

export function appendContext(context: ConversationTurn[], user: string, assistant: string): ConversationTurn[] {
  const next: ConversationTurn[] = [...context];
  if (user.trim()) next.push({ role: "user", text: clip(user.trim()) });
  if (assistant.trim()) next.push({ role: "assistant", text: clip(assistant.trim()) });
  return next.slice(-MAX_CONTEXT_TURNS);
}

export function recommendReducer(state: RecommendState, action: RecommendAction): RecommendState {
  switch (action.type) {
    case "start":
      return {
        ...state,
        status: "loading",
        activeId: action.request.client_request_id,
        request: action.request,
        error: null,
        startedAt: action.at,
        cancelled: false,
        pendingUserTurn: action.userTurn,
      };
    case "success": {
      // Stale or foreign answers never overwrite the current state (T24).
      if (state.status !== "loading" || action.id !== state.activeId) return state;
      if (action.response.client_request_id !== action.id) return state;
      return {
        ...state,
        status: "success",
        activeId: null,
        response: action.response,
        responseRequest: state.request,
        error: null,
        startedAt: null,
        context: appendContext(state.context, state.pendingUserTurn ?? "", action.response.message),
        pendingUserTurn: null,
      };
    }
    case "failure":
      if (state.status !== "loading" || action.id !== state.activeId) return state;
      return { ...state, status: "error", activeId: null, error: action.error, startedAt: null };
    case "cancel":
      if (state.status !== "loading" || action.id !== state.activeId) return state;
      return {
        ...state,
        status: state.response ? "success" : "idle",
        activeId: null,
        request: state.responseRequest,
        startedAt: null,
        cancelled: true,
        pendingUserTurn: null,
      };
    case "reset":
      return initialRecommendState;
    default:
      return state;
  }
}

export function newClientRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
