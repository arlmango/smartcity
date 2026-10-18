import type { OpeningStatus, Timing } from "./contracts";

const TZ = "Asia/Almaty";

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export const formatMinutes = (n: number): string => `${n} мин`;

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} м`;
  return `${(meters / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`;
}

/** "по прямой 450 м" for geodesic distances; route distances are labelled separately. */
export function formatDistanceWithMethod(meters: number, method: "geodesic" | "pedestrian_route"): string {
  return method === "geodesic" ? `По прямой ${formatDistance(meters)}` : `Пешеходный маршрут ${formatDistance(meters)}`;
}

export interface TimingRow {
  key: "outbound" | "visit" | "return" | "buffer";
  label: string;
  minutes: number;
  estimate: boolean;
}

export function timingRows(t: Timing): TimingRow[] {
  const rows: TimingRow[] = [
    { key: "outbound", label: "Дорога туда", minutes: t.outbound_min, estimate: true },
    { key: "visit", label: "На месте", minutes: t.visit_min, estimate: true },
  ];
  if (t.return_min !== null) rows.push({ key: "return", label: "Обратно", minutes: t.return_min, estimate: true });
  rows.push({ key: "buffer", label: "Запас", minutes: t.buffer_min, estimate: true });
  return rows;
}

export function timingTotalLabel(t: Timing, budget: number | null): string {
  return budget ? `Итого ≈ ${t.total_min} из ${budget} мин` : `Итого ≈ ${t.total_min} мин`;
}

export const OPENING_LABEL: Record<OpeningStatus, string> = {
  open: "Открыто на время визита",
  closed: "Закрыто во время визита",
  unknown: "Часы не указаны",
};

export function openingLabel(status: OpeningStatus, raw: string | null): string {
  if (status === "unknown") return raw ? "Часы не удалось проверить" : "Часы не указаны";
  return OPENING_LABEL[status];
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "неизвестно";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "неизвестно";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" }).format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "неизвестно";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "неизвестно";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Only absolute http(s) URLs are ever rendered as links. Everything else → null (shown as text or hidden). */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return u.toString();
}

export function formatCoord(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
