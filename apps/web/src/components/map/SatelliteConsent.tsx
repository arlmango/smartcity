"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Asked before the first request to the satellite host. Until the viewer accepts, the map stays on the
 * scheme and the browser makes no request to EOX; declining (button or Escape) changes nothing.
 * Modal for real: rendered over the whole app, everything else is `inert` while it is open.
 */
export function SatelliteConsent({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
  const titleId = useId();
  const descId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const others = Array.from(document.body.children).filter((el) => el !== rootRef.current && !el.hasAttribute("inert"));
    others.forEach((el) => el.setAttribute("inert", ""));
    declineRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDecline();
        return;
      }
      if (e.key !== "Tab") return;
      // Focus trap: Tab / Shift+Tab cycle through the dialog's own buttons.
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])") ?? []);
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next]!.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      others.forEach((el) => el.removeAttribute("inert"));
      previous?.focus?.();
    };
  }, [onDecline]);

  return createPortal(
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-graphite/40 px-4 py-[max(16px,var(--safe-top))]"
      data-testid="satellite-consent"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="max-h-[calc(100dvh-32px)] w-[min(100%,440px)] overflow-y-auto rounded-panel border border-stroke bg-white p-5 text-sm shadow-panel"
      >
        <h2 id={titleId} className="mb-2 text-base font-bold">
          Включить спутниковый гибрид?
        </h2>
        <div id={descId} className="space-y-2 leading-snug">
          <p>
            Снимки загружаются браузером напрямую с сервера EOX IT Services GmbH (tiles.maps.eox.at). EOX получит ваш
            IP-адрес, адрес этого сайта, сведения о браузере и то, какую область карты вы смотрите — пока карта не
            приближена до уровня улиц, в том числе сразу после включения.
          </p>
          <p className="text-muted">
            EOxCloudless 2024: 10 м/пиксель, лицензия CC BY-NC-SA 4.0, только некоммерческое использование. Снимки
            показывают землю; здания остаются схематичными объёмами. Выбор не сохраняется: при следующем открытии снова
            будет схема, которая работает без спутника.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button ref={declineRef} type="button" className="sc-btn min-h-[44px]" onClick={onDecline}>
            Остаться на схеме
          </button>
          <button type="button" className="sc-btn-dark min-h-[44px]" onClick={onAccept}>
            Включить гибрид
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
