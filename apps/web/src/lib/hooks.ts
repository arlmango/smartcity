"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, getCoverage, getMapLayer, getReady, isAbortError, postRecommend } from "./api";
import type { RecommendRequest } from "./contracts";
import { MAP_LAYERS, type LayerResult, type MapLayer } from "./mapData";
import { initialRecommendState, recommendReducer, type RequestErrorInfo } from "./recommendState";

// ------------------------------------------------------------- environment

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  };
}

export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    subscribeMedia(query),
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

export const useReducedMotion = (): boolean => useMediaQuery("(prefers-reduced-motion: reduce)");

// ------------------------------------------------------------- data

export function useReady() {
  return useQuery({
    queryKey: ["ready"],
    queryFn: ({ signal }) => getReady(signal),
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function useCoverage() {
  return useQuery({
    queryKey: ["coverage"],
    queryFn: ({ signal }) => getCoverage(signal),
    staleTime: 10 * 60_000,
    retry: 1,
  });
}

export interface MapLayersState {
  layers: Partial<Record<MapLayer, LayerResult>>;
  loading: boolean;
  failed: MapLayer[];
  dropped: number;
  errors: string[];
  refetch: () => void;
}

export function useMapLayers(): MapLayersState {
  const results = useQueries({
    queries: MAP_LAYERS.map((layer) => ({
      queryKey: ["map", layer],
      queryFn: ({ signal }: { signal: AbortSignal }) => getMapLayer(layer, signal),
      staleTime: Infinity,
      retry: 1,
    })),
  });
  const layers: Partial<Record<MapLayer, LayerResult>> = {};
  const failed: MapLayer[] = [];
  const errors: string[] = [];
  let dropped = 0;
  results.forEach((r, i) => {
    const layer = MAP_LAYERS[i] as MapLayer;
    if (r.data) {
      layers[layer] = r.data;
      dropped += r.data.dropped;
    }
    if (r.isError) {
      failed.push(layer);
      errors.push(r.error instanceof Error ? r.error.message : String(r.error));
    }
  });
  const refetchAll = () => results.forEach((r) => r.isError && void r.refetch());
  return { layers, loading: results.some((r) => r.isPending), failed, dropped, errors, refetch: refetchAll };
}

// ------------------------------------------------------------- recommend

function toErrorInfo(e: unknown): RequestErrorInfo {
  if (e instanceof ApiError) return { kind: e.kind, message: e.message, retryable: e.retryable, status: e.status };
  return { kind: "unknown", message: "Что-то пошло не так.", retryable: true };
}

export function useRecommend() {
  const [state, dispatch] = useReducer(recommendReducer, initialRecommendState);
  const controllerRef = useRef<AbortController | null>(null);

  const submit = useCallback((request: RecommendRequest, userTurn: string) => {
    // A new request makes any in-flight one stale; abort it so the server can stop work too.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = request.client_request_id;
    dispatch({ type: "start", request, at: Date.now(), userTurn });
    postRecommend(request, controller.signal).then(
      (response) => dispatch({ type: "success", id, response }),
      (e: unknown) => {
        if (controller.signal.aborted || isAbortError(e)) return; // cancel handled separately
        dispatch({ type: "failure", id, error: toErrorInfo(e) });
      },
    );
  }, []);

  const cancel = useCallback(() => {
    const id = state.activeId;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (id) dispatch({ type: "cancel", id });
  }, [state.activeId]);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: "reset" });
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { state, submit, cancel, reset, dispatch };
}

/** Seconds since `since` (ms), ticking every second while `active`. */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
