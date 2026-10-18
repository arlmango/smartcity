/**
 * Planned start time. The user enters wall-clock time in Astana (Asia/Almaty). Kazakhstan has
 * used a single UTC+05:00 zone without DST since 2024-03-01, so the offset is fixed here instead
 * of relying on possibly outdated browser tzdata. The API re-interprets the instant in Asia/Almaty.
 */
export const ALMATY_OFFSET = "+05:00";
const OFFSET_MS = 5 * 60 * 60 * 1000;
export const MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");

/** Date → "YYYY-MM-DDTHH:mm" in Astana wall-clock time (value for <input type="datetime-local">). */
export function toAlmatyInput(d: Date): string {
  const s = new Date(d.getTime() + OFFSET_MS);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}T${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`;
}

/** "YYYY-MM-DDTHH:mm" (Astana) → ISO 8601 with explicit +05:00, or null if malformed. */
export function almatyInputToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const iso = `${local}:00${ALMATY_OFFSET}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export type StartProblem = "invalid" | "past" | "too_far";

/** Allowed: [now − 1 min grace, now + 7 days] (the API accepts now − 10 min .. now + 7 days). */
export function checkStart(local: string, now: Date = new Date()): StartProblem | null {
  const iso = almatyInputToIso(local);
  if (!iso) return "invalid";
  const t = Date.parse(iso);
  if (t < now.getTime() - 60_000) return "past";
  if (t > now.getTime() + MAX_AHEAD_MS) return "too_far";
  return null;
}

/** Default suggestion: one hour from now, rounded up to 15 minutes. */
export function defaultStartInput(now: Date = new Date()): string {
  const q = 15 * 60 * 1000;
  return toAlmatyInput(new Date(Math.ceil((now.getTime() + 60 * 60 * 1000) / q) * q));
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** Human Astana time for an ISO instant: "18 октября, 19:30". */
export function formatAlmaty(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "неизвестно";
  const s = new Date(t + OFFSET_MS);
  return `${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]}, ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`;
}
