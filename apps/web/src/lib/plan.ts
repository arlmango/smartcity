import type { Constraints, RouteLeg, WalkPlan } from "./contracts";

/** Same rule as the server (providers/routing.minutes): router time rounded up + access estimate. */
export function minutesOf(leg: RouteLeg): number {
  return Math.ceil(leg.duration_s / 60) + leg.access_estimate_min;
}

/** A pending "Убрать": the request it started and what the plan looked like before. */
export interface PlanRemoval {
  requestId: string;
  removedName: string;
  previousIds: string[];
}

/** What a person must be told after "Убрать": it is a new selection, so other places may join. */
export function describeRemoval(r: PlanRemoval, plan: WalkPlan | null): string {
  if (!plan) return `Без «${r.removedName}» план не собрался.`;
  const added = plan.stops.filter((s) => !r.previousIds.includes(s.place_id)).map((s) => `«${s.name}»`);
  return `Подобран новый план без «${r.removedName}». ` + (added.length
    ? `В него вошли другие места: ${added.join(", ")}. Время и обратный путь пересчитаны.`
    : "Новых мест в нём нет. Время и обратный путь пересчитаны.");
}

/** "Remove this stop": keep every other condition and hide only that place. */
export function withoutStop(c: Constraints, placeId: string): Constraints {
  const ids = Array.from(new Set([...c.exclude_place_ids, placeId]));
  return { ...c, exclude_place_ids: ids.slice(-20) };
}
