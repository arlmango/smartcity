import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecommendationCard } from "@/components/RecommendationCard";
import { ResultsPanel } from "@/components/ResultsPanel";
import { EMPTY_CONSTRAINTS } from "@/lib/contracts";
import { walkingRoute } from "../fixtures/walkingRoute";
import { XSS_NAME, noMatchResponse, recA, recB, retrievalOnlyResponse } from "../fixtures/synthetic";

describe("RecommendationCard", () => {
  it("T25: renders HTML in a place name as plain text", () => {
    const { container } = render(
      <RecommendationCard rec={{ ...recA, name: XSS_NAME, reason: "<script>window.__xss=2</script>" }} index={0} selected={false} budget={60} retrievalOnly={false} onSelect={() => {}} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain('<img src=x onerror="window.__xss=1">');
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("an AI text rejected by fact checks is shown as hidden, not as missing AI", () => {
    render(
      <RecommendationCard rec={{ ...recA, reason: null, reason_source: "llm" }} index={0} selected={false} budget={60} retrievalOnly={false} onSelect={() => {}} />,
    );
    expect(screen.getByText("Объяснение ИИ не прошло проверку фактов и скрыто.")).toBeInTheDocument();
  });

  it("links only http(s) sources, with rel=noopener noreferrer", () => {
    const { container } = render(
      <RecommendationCard
        rec={{ ...recA, website: "javascript:alert(1)", source: { ...recA.source, url: "javascript:alert(2)" } }}
        index={0}
        selected={false}
        budget={60}
        retrievalOnly={false}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(screen.getByText("Источник: OpenStreetMap")).toBeInTheDocument();

    const ok = render(<RecommendationCard rec={recA} index={0} selected={false} budget={60} retrievalOnly={false} onSelect={() => {}} />);
    const links = ok.container.querySelectorAll("a");
    expect(links.length).toBe(2);
    links.forEach((a) => {
      expect(a.getAttribute("href")).toMatch(/^https?:\/\//);
      expect(a.getAttribute("rel")).toContain("noopener");
      expect(a.getAttribute("rel")).toContain("noreferrer");
    });
  });

  it("shows facts, estimates and unknowns distinctly", () => {
    render(<RecommendationCard rec={recA} index={0} selected={false} budget={60} retrievalOnly={false} onSelect={() => {}} />);
    expect(screen.getByText("ИИ")).toBeInTheDocument();
    expect(screen.getByText("оценка")).toBeInTheDocument();
    expect(screen.getByText("по данным места")).toBeInTheDocument();
    expect(screen.getByText("Наличие розеток не подтверждено")).toBeInTheDocument();
    expect(screen.getByText("По прямой 420 м")).toBeInTheDocument();
    expect(screen.getByText("Время приблизительное")).toBeInTheDocument();
    expect(screen.getByTestId("timing-total").textContent).toBe("Итого ≈ 38 из 60 мин");
    expect(screen.getByText(/Mo-Su 08:00-22:00/)).toBeInTheDocument();
  });

  it("labels generic playground names as unnamed in OSM", () => {
    render(<RecommendationCard rec={recB} index={1} selected={false} budget={60} retrievalOnly={false} onSelect={() => {}} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("Детская площадка · без названия в OSM");
  });

  it("keeps technical route details closed while key caveats stay visible", async () => {
    render(<RecommendationCard rec={{ ...recA, route: walkingRoute }} index={0} selected={false} budget={60} retrievalOnly={false} onSelect={() => {}} />);
    expect(screen.getByText(/Доступность уточните перед выходом/)).toBeVisible();
    expect(screen.getByText("Время приблизительное")).toBeVisible();
    expect(screen.getByText("Наличие розеток не подтверждено")).toBeVisible();
    expect(screen.getByTestId("route-details")).not.toBeVisible();
    await userEvent.click(screen.getByText("Подробнее и источники"));
    expect(screen.getByTestId("route-details")).toBeVisible();
    expect(screen.getByRole("link", { name: /Источник: OpenStreetMap/ })).toBeVisible();
  });

  it("selects by place_id from the button", async () => {
    const onSelect = vi.fn();
    render(<RecommendationCard rec={recA} index={0} selected={false} budget={60} retrievalOnly={false} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /Показать на карте/ }));
    expect(onSelect).toHaveBeenCalledWith(recA.place_id);
  });
});

describe("ResultsPanel", () => {
  const common = {
    constraints: EMPTY_CONSTRAINTS,
    budget: 60,
    startTime: null,
    selectedId: null,
    cardRefs: { current: new Map<string, HTMLElement>() },
    busy: false,
    cancelled: false,
    onSelect: () => {},
    onRefine: () => {},
    onEdit: () => {},
    onReset: () => {},
  };

  it("shows the retrieval_only banner", () => {
    render(<ResultsPanel {...common} response={retrievalOnlyResponse("abcdefgh-1")} onRelax={() => {}} />);
    expect(screen.getByTestId("retrieval-only").textContent).toBe(
      "ИИ временно недоступен — показаны найденные места без объяснений ИИ.",
    );
  });

  it("llm_busy is said once (banner), not repeated as message and warning", () => {
    const busyMsg = "ИИ сейчас занят другим запросом — показаны найденные места без объяснений ИИ.";
    const base = retrievalOnlyResponse("abcdefgh-3");
    const resp = { ...base, message: busyMsg, warnings: [...base.warnings, { code: "llm_busy", message: busyMsg }] };
    render(<ResultsPanel {...common} response={resp} onRelax={() => {}} />);
    expect(screen.getByTestId("retrieval-only").textContent).toBe(busyMsg);
    expect(screen.getAllByText(busyMsg)).toHaveLength(1);
  });

  it("server 'AI unavailable' message is not repeated under the banner", () => {
    const base = retrievalOnlyResponse("abcdefgh-4");
    const resp = { ...base, message: "ИИ временно недоступен — показаны найденные места без сгенерированных объяснений." };
    render(<ResultsPanel {...common} response={resp} onRelax={() => {}} />);
    expect(screen.queryByText(resp.message)).toBeNull();
    expect(screen.getByTestId("retrieval-only")).toBeInTheDocument();
  });

  it("no_match in retrieval_only mode (no generation needed) does not claim AI is unavailable", () => {
    const resp = { ...noMatchResponse("abcdefgh-2"), mode: "retrieval_only" as const };
    render(<ResultsPanel {...common} response={resp} onRelax={() => {}} />);
    expect(screen.queryByTestId("retrieval-only")).toBeNull();
  });

  it("no_match shows message and relaxations that send the server patch", async () => {
    const onRelax = vi.fn();
    const resp = noMatchResponse("abcdefgh-1");
    render(<ResultsPanel {...common} response={resp} onRelax={onRelax} />);
    expect(screen.getByText(/нет мест, где розетки подтверждены/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /розеток не подтверждено/ }));
    expect(onRelax).toHaveBeenCalledWith(resp.suggested_relaxations[0]);
  });
});
