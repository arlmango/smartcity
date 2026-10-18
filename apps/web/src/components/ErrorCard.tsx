"use client";

import type { RequestErrorInfo } from "@/lib/recommendState";

const TITLE: Record<string, string> = {
  offline: "Нет подключения",
  network: "Сервер недоступен",
  timeout: "Сервер не ответил вовремя",
  invalid_response: "Некорректный ответ сервера",
  http: "Запрос не выполнен",
};

export function ErrorCard({
  error,
  online,
  onRetry,
  onEdit,
}: {
  error: RequestErrorInfo;
  online: boolean;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const title = error.status === 503 || error.status === 502 ? "Сервис подбора недоступен" : (TITLE[error.kind] ?? "Ошибка");
  return (
    <section role="alert" className="sc-card space-y-3 border-danger-fg/30 p-4" data-testid="error-card">
      <h2 className="text-lg font-bold text-danger-fg">{title}</h2>
      <p className="text-sm">{error.message}</p>
      {error.kind === "invalid_response" && (
        <p className="text-xs text-muted">Мы не показываем ответ, который не прошёл проверку формата.</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {error.retryable && (
          <button type="button" className="sc-btn-dark" onClick={onRetry} disabled={!online}>
            Повторить
          </button>
        )}
        <button type="button" className="sc-btn" onClick={onEdit}>
          Изменить запрос
        </button>
      </div>
    </section>
  );
}
