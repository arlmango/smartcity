"use client";

import type { ReadyResponse } from "@/lib/contracts";

interface Props {
  online: boolean;
  ready: ReadyResponse | undefined;
  readyError: boolean;
  onRetryReady: () => void;
}

export function providerNotice(ready: ReadyResponse | undefined): { tone: "warn" | "danger"; text: string } | null {
  if (!ready) return null;
  if (!ready.ready) {
    const broken = Object.entries(ready.components)
      .filter(([k, v]) => ["db", "data", "map"].includes(k) && v.status !== "ok")
      .map(([k]) => ({ db: "база данных", data: "данные мест", map: "слои карты" })[k] ?? k);
    return {
      tone: "danger",
      text: `Сервис не готов${broken.length ? `: ${broken.join(", ")}` : ""}. Подбор может не работать.`,
    };
  }
  const llm = ready.components.llm;
  if (llm && llm.status !== "ok") {
    return { tone: "warn", text: "ИИ сейчас недоступен — подбор покажет найденные места без объяснений ИИ." };
  }
  const emb = ready.components.embeddings;
  if (emb && emb.status !== "ok") {
    return { tone: "warn", text: "Поиск по смыслу недоступен — подбор работает по словам и расстоянию." };
  }
  return null;
}

export function StatusBanners({ online, ready, readyError, onRetryReady }: Props) {
  const notice = providerNotice(ready);
  return (
    <div aria-live="polite" className="relative z-20">
      {!online && (
        <p role="alert" className="bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-fg" data-testid="offline-banner">
          Нет подключения к интернету. Подбор недоступен, пока связь не восстановится.
        </p>
      )}
      {online && readyError && (
        <p role="alert" className="flex flex-wrap items-center gap-2 bg-danger-bg px-4 py-2 text-sm text-danger-fg" data-testid="api-banner">
          <span className="font-semibold">API недоступен — подбор мест сейчас не работает.</span>
          <button type="button" className="min-h-[44px] font-semibold underline" onClick={onRetryReady}>
            Проверить снова
          </button>
        </p>
      )}
      {online && notice && (
        <p
          role="status"
          data-testid="provider-banner"
          className={`px-4 py-2 text-sm font-semibold ${notice.tone === "danger" ? "bg-danger-bg text-danger-fg" : "bg-warn-bg text-warn-fg"}`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
