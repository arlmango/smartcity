import { describe, expect, it } from "vitest";
import {
  formatDistance,
  formatDistanceWithMethod,
  openingLabel,
  pluralRu,
  safeHttpUrl,
  timingRows,
  timingTotalLabel,
} from "@/lib/format";
import { recA } from "../fixtures/synthetic";

describe("timing", () => {
  it("lists outbound, visit, return, buffer and the total of the budget", () => {
    const rows = timingRows(recA.timing);
    expect(rows.map((r) => r.label)).toEqual(["Дорога туда", "На месте", "Обратно", "Запас"]);
    expect(rows.every((r) => r.estimate)).toBe(true);
    expect(timingTotalLabel(recA.timing, 60)).toBe("Итого ≈ 38 из 60 мин");
  });
  it("omits the return row when return_to_start is false", () => {
    const rows = timingRows({ ...recA.timing, return_min: null });
    expect(rows.find((r) => r.key === "return")).toBeUndefined();
  });
});

describe("distance", () => {
  it("formats meters and kilometres", () => {
    expect(formatDistance(423)).toBe("420 м");
    expect(formatDistance(1530)).toBe("1,5 км");
    expect(formatDistanceWithMethod(420, "geodesic")).toBe("По прямой 420 м");
  });
});

describe("opening status", () => {
  it("unknown is never shown as open", () => {
    expect(openingLabel("unknown", null)).toBe("Часы не указаны");
    expect(openingLabel("unknown", "Mo-Fr 09:00-18:00; PH off")).toBe("Часы не удалось проверить");
    expect(openingLabel("open", "24/7")).toMatch(/Открыто/);
    expect(openingLabel("closed", "Mo 10:00-11:00")).toMatch(/Закрыто/);
  });
});

describe("safeHttpUrl (only http/https links)", () => {
  it.each([
    ["https://www.openstreetmap.org/node/1", "https://www.openstreetmap.org/node/1"],
    ["http://example.org/a?b=1", "http://example.org/a?b=1"],
  ])("accepts %s", (input, out) => expect(safeHttpUrl(input)).toBe(out));

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "ftp://example.org",
    "//evil.example",
    "/relative",
    "https://user:pass@example.org",
    "",
    null,
    undefined,
  ])("rejects %s", (input) => expect(safeHttpUrl(input as string | null)).toBeNull());
});

describe("pluralRu", () => {
  it("handles russian plural forms", () => {
    expect(pluralRu(1, "место", "места", "мест")).toBe("место");
    expect(pluralRu(3, "место", "места", "мест")).toBe("места");
    expect(pluralRu(11, "место", "места", "мест")).toBe("мест");
  });
});
