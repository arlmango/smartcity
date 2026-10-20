import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecommendResponseSchema, WalkPlanSchema } from "@/lib/contracts";
import { describeRemoval, minutesOf, withoutStop } from "@/lib/plan";
import { mapRouteOfPlan, routeFeatures } from "@/lib/walkingRoute";
import { WalkPlanCard } from "@/components/WalkPlanCard";
import { ResultsPanel } from "@/components/ResultsPanel";
import { okResponse } from "../fixtures/synthetic";
import { walkPlan } from "../fixtures/walkingRoute";

describe("timebox plan contract", () => {
  it("accepts a plan whose totals add up and fit", () => {
    expect(WalkPlanSchema.safeParse(walkPlan).success).toBe(true);
    const leg = walkPlan.stops.map((s) => minutesOf(s.leg_in)).reduce((a, b) => a + b, 0) + minutesOf(walkPlan.return_leg!);
    expect(leg).toBe(walkPlan.walk_min);
    expect(RecommendResponseSchema.parse({ ...okResponse("plan-test-01"), plan: walkPlan }).plan).not.toBeNull();
  });
  it("rejects a plan that does not add up, exceeds the budget, or hides the way back", () => {
    expect(WalkPlanSchema.safeParse({ ...walkPlan, total_min: 50 }).success).toBe(false);
    expect(WalkPlanSchema.safeParse({ ...walkPlan, time_budget_min: 50 }).success).toBe(false);
    expect(WalkPlanSchema.safeParse({ ...walkPlan, return_leg: null }).success).toBe(false);
    expect(WalkPlanSchema.safeParse({ ...walkPlan, stops: [walkPlan.stops[0]] }).success).toBe(false);
    expect(WalkPlanSchema.safeParse({ ...walkPlan, stops: [walkPlan.stops[0], walkPlan.stops[0]] }).success).toBe(false);
  });
  it("an inconsistent plan is dropped with a note, the cards are kept", () => {
    const parsed = RecommendResponseSchema.parse({ ...okResponse("plan-test-05"), plan: { ...walkPlan, total_min: 999 } });
    expect(parsed.plan).toBeNull();
    expect(parsed.recommendations).toHaveLength(3);
    expect(parsed.plan_note).toMatch(/не прошёл проверку/);
  });
  it("an older server without plan fields still parses", () => {
    const { plan: _p, plan_note: _n, ...old } = okResponse("plan-test-02");
    expect(RecommendResponseSchema.parse(old).plan).toBeNull();
  });
});

describe("plan geometry on the map", () => {
  it("draws only router legs in order, return dashed, numbered stop marks at network ends", () => {
    const r = mapRouteOfPlan(walkPlan);
    expect(routeFeatures(r).features.map((f) => f.properties?.leg)).toEqual(["outbound", "outbound", "return"]);
    expect(r.marks.map((m) => m.letter)).toEqual(["1", "2"]);
    expect(r.marks[0]!.point).toEqual([71.4164, 51.0894]);
  });
});

describe("hours on plan stops", () => {
  it("unknown hours of an indoor stop are said; of an outdoor one are not", () => {
    const museum = { ...walkPlan.stops[1]!, category: "culture" as const, category_label: "Культура", name_is_generic: false, name: "SYNTHETIC Музей" };
    render(<WalkPlanCard plan={{ ...walkPlan, stops: [walkPlan.stops[0]!, museum] }} shown busy={false} onShow={() => {}} onRemove={() => {}} />);
    expect(within(screen.getAllByTestId("plan-stop")[1]!).getByText(/Часы не указаны/)).toBeTruthy();
    expect(within(screen.getAllByTestId("plan-stop")[0]!).queryByText(/Часы/)).toBeNull();
  });
});

describe("remove a stop", () => {
  it("keeps every other condition and adds only that place to the exclusions", () => {
    const c = { required_features: ["wifi" as const], preferred_features: [], include_categories: [], exclude_categories: ["mall" as const],
      must_be_open: true, max_distance_m: 900, exclude_place_ids: ["x"], dropped_text_constraints: [] };
    expect(withoutStop(c, "synthetic-cafe-1")).toEqual({ ...c, exclude_place_ids: ["x", "synthetic-cafe-1"] });
  });
  it("card shows stops, totals, return, honest estimate wording and buttons", () => {
    const onRemove = vi.fn();
    const onShow = vi.fn();
    render(<WalkPlanCard plan={walkPlan} shown={false} busy={false} onShow={onShow} onRemove={onRemove} />);
    const card = screen.getByTestId("walk-plan");
    expect(card.textContent).toContain("2 остановки · ≈ 57 мин");
    expect(screen.getAllByTestId("plan-stop")).toHaveLength(2);
    expect(card.textContent).toContain("Обратно к старту ≈ 3 мин");
    expect(card.textContent).toContain("Время примерное");
    expect(card.textContent).not.toMatch(/Valhalla|RAG|embedding/i);
    // unknown hours of a playground are not worth a line; open is not repeated
    expect(card.textContent).not.toMatch(/часы/i);
    fireEvent.click(screen.getByRole("button", { name: "Подобрать план без остановки: SYNTHETIC Кафе «Тест»" }));
    expect(onRemove).toHaveBeenCalledWith("synthetic-cafe-1");
    fireEvent.click(screen.getByRole("button", { name: "Показать план на карте" }));
    expect(onShow).toHaveBeenCalled();
  });
});

describe("plan inside the results panel", () => {
  const props = {
    constraints: { required_features: [], preferred_features: [], include_categories: [], exclude_categories: [], must_be_open: false,
      max_distance_m: null, exclude_place_ids: [], dropped_text_constraints: [] },
    budget: 60, startTime: null, selectedId: null, cardRefs: { current: new Map() }, cancelled: false,
    onSelect: () => {}, planShown: true, onShowPlan: () => {}, onRefine: () => {}, onRelax: () => {}, onEdit: () => {}, onReset: () => {},
  };
  it("comes before the summary, and a stop can be removed while explanations are still loading", () => {
    const onRemoveStop = vi.fn();
    render(<ResultsPanel {...props} response={{ ...okResponse("plan-test-03"), plan: walkPlan }} busy pending onRemoveStop={onRemoveStop} />);
    const results = screen.getByTestId("results");
    expect(results.firstElementChild?.getAttribute("data-testid")).toBe("walk-plan");
    const remove = screen.getByRole("button", { name: /^Подобрать план без остановки: SYNTHETIC Кафе/ });
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(remove);
    expect(onRemoveStop).toHaveBeenCalledWith("synthetic-cafe-1");
    // Refinements stay disabled while busy: only the plan's own action is allowed.
    expect((screen.getByRole("button", { name: "Поближе" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("router down: the straight-line caveat is said once", () => {
    const warnings = [
      { code: "routing_unavailable", message: "x" }, { code: "straight_line_estimate", message: "y" },
    ];
    render(<ResultsPanel {...props} response={{ ...okResponse("plan-test-06"), warnings }} busy={false} onRemoveStop={() => {}} />);
    expect(screen.getAllByText(/Пеший путь недоступен\. Оценка по прямой/)).toHaveLength(1);
  });
  it("without a plan the server's note is shown instead", () => {
    render(<ResultsPanel {...props} response={{ ...okResponse("plan-test-04"), plan_note: "SYNTHETIC: среди найденных вариантов не удалось собрать прогулку." }} busy={false} onRemoveStop={() => {}} />);
    expect(screen.getByTestId("plan-note").textContent).toBe("SYNTHETIC: среди найденных вариантов не удалось собрать прогулку.");
    expect(screen.queryByTestId("walk-plan")).toBeNull();
  });
});

describe("stale plan", () => {
  it("after the start changes, the plan says so and its actions are off", () => {
    render(<WalkPlanCard plan={walkPlan} shown={false} busy={false} stale onShow={() => {}} onRemove={() => {}} />);
    expect(screen.getByTestId("plan-stale").textContent).toMatch(/Старт изменён/);
    expect(screen.queryByRole("button", { name: /Показать план/ })).toBeNull();
    for (const b of screen.getAllByRole("button", { name: /^Подобрать план без остановки/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("after «Убрать»", () => {
  const removal = { requestId: "x", removedName: "SYNTHETIC Кафе «Тест»", previousIds: walkPlan.stops.map((s) => s.place_id) };
  it("names places that joined the new plan instead of replacing silently", () => {
    const museum = { ...walkPlan.stops[0]!, place_id: "synthetic-museum-3", name: "SYNTHETIC Музей тестов" };
    const next = { ...walkPlan, stops: [museum, walkPlan.stops[1]!] };
    expect(describeRemoval(removal, next)).toBe(
      "Подобран новый план без «SYNTHETIC Кафе «Тест»». В него вошли другие места: «SYNTHETIC Музей тестов». Время и обратный путь пересчитаны.",
    );
  });
  it("says when no new places joined, and when no plan could be built", () => {
    expect(describeRemoval(removal, { ...walkPlan, stops: [walkPlan.stops[1]!, walkPlan.stops[1]!].map((s, i) => ({ ...s, place_id: i ? "synthetic-cafe-1" : s.place_id })) }))
      .toMatch(/Новых мест в нём нет/);
    expect(describeRemoval(removal, null)).toBe("Без «SYNTHETIC Кафе «Тест»» план не собрался.");
  });
  it("the card explains that «Убрать» selects anew", () => {
    render(<WalkPlanCard plan={walkPlan} shown busy={false} onShow={() => {}} onRemove={() => {}} />);
    expect(screen.getByTestId("plan-remove-hint").textContent).toMatch(/подбирает план заново.*могут войти другие места/);
  });
});
