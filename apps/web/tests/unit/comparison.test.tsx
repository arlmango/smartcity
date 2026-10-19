import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AlternativeComparison } from "@/components/AlternativeComparison";
import { recA, recB } from "../fixtures/synthetic";

it("distinguishes zero return from an omitted return and selects the actual place ID", async () => {
  const onSelect = vi.fn();
  render(<AlternativeComparison recs={[
    { ...recA, timing: { ...recA.timing, return_min: 0 } },
    { ...recB, timing: { ...recB.timing, return_min: null } },
  ]} budget={60} selectedId={recB.place_id} onSelect={onSelect} />);
  expect(screen.getByText("≈ 0 мин")).toBeInTheDocument();
  expect(screen.getByText("не учтено")).toBeInTheDocument();
  const buttons = screen.getAllByRole("button");
  expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(buttons[0]!);
  expect(onSelect).toHaveBeenCalledWith(recA.place_id);
});

it("does not add comparison for a single alternative", () => {
  render(<AlternativeComparison recs={[recA]} budget={60} selectedId={null} onSelect={() => {}} />);
  expect(screen.queryByRole("region", { name: "Сравнить варианты" })).toBeNull();
});
