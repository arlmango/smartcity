import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecommendationCard } from "@/components/RecommendationCard";
import { ResultsPanel } from "@/components/ResultsPanel";
import { EMPTY_CONSTRAINTS } from "@/lib/contracts";
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
    expect(screen.getByText("факт · OSM")).toBeInTheDocument();
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
