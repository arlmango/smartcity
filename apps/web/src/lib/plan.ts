import type { Constraints, RouteLeg } from "./contracts";

/** Same rule as the server (providers/routing.minutes): router time rounded up + access estimate. */
export function minutesOf(leg: RouteLeg): number {
  return Math.ceil(leg.duration_s / 60) + leg.access_estimate_min;
}

/** "Remove this stop": keep every other condition and hide only that place. */
export function withoutStop(c: Constraints, placeId: string): Constraints {
  const ids = Array.from(new Set([...c.exclude_place_ids, placeId]));
  return { ...c, exclude_place_ids: ids.slice(-20) };
}
