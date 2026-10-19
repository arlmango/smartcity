import { describe, expect, it } from "vitest";
import { buildRequest, initialForm, validateForm } from "@/lib/form";
import { describeProviders, hasExternalProvider, parseDetail } from "@/lib/providers";
import { almatyInputToIso, checkStart, defaultStartInput, formatAlmaty, toAlmatyInput } from "@/lib/time";
import { readyOk } from "../fixtures/synthetic";

const NOW = new Date("2026-10-18T13:00:00Z"); // 18:00 in Astana (UTC+5)

describe("start time (Asia/Almaty, +05:00)", () => {
  it("converts between instants and Astana wall-clock input", () => {
    expect(toAlmatyInput(NOW)).toBe("2026-10-18T18:00");
    expect(almatyInputToIso("2026-10-18T20:30")).toBe("2026-10-18T20:30:00+05:00");
    expect(Date.parse(almatyInputToIso("2026-10-18T20:30")!)).toBe(Date.parse("2026-10-18T15:30:00Z"));
    expect(almatyInputToIso("garbage")).toBeNull();
    expect(formatAlmaty("2026-10-18T20:30:00+05:00")).toBe("18 октября, 20:30");
  });

  it("allows only [now, now + 7 days]", () => {
    expect(checkStart("2026-10-18T19:00", NOW)).toBeNull();
    expect(checkStart("2026-10-18T17:00", NOW)).toBe("past");
    expect(checkStart("2026-10-25T17:59", NOW)).toBeNull();
    expect(checkStart("2026-10-25T18:30", NOW)).toBe("too_far");
    expect(checkStart("", NOW)).toBe("invalid");
  });

  it("default suggestion is ~1h ahead, rounded to 15 min", () => {
    expect(defaultStartInput(new Date("2026-10-18T13:07:00Z"))).toBe("2026-10-18T19:15");
  });

  it("start_time is omitted (null) by default and sent with +05:00 when set", () => {
    const origin = { lat: 51.089, lon: 71.414, kind: "demo" as const, label: "d" };
    expect(buildRequest({ ...initialForm, origin }, "abcdefgh-1", []).start_time).toBeNull();
    const local = toAlmatyInput(new Date(Date.now() + 2 * 3600_000));
    const r = buildRequest({ ...initialForm, origin, startTime: local }, "abcdefgh-1", []);
    expect(r.start_time).toBe(`${local}:00+05:00`);
    expect(validateForm({ ...initialForm, origin, startTime: "2000-01-01T10:00" })).toContain("bad_start");
  });
});

describe("provider disclosure", () => {
  it("parses /api/ready details", () => {
    expect(parseDetail("ollama:qwen2.5:3b@abc")).toEqual({ kind: "ollama", model: "qwen2.5:3b" });
    expect(parseDetail("openai_compatible:gpt-x")).toEqual({ kind: "openai_compatible", model: "gpt-x" });
    expect(parseDetail("AI_PROVIDER=none")).toEqual({ kind: "none", model: null });
    expect(parseDetail("Probe не прошёл: timeout")).toEqual({ kind: "unknown", model: null });
  });

  it("local Ollama: text stays on the server", () => {
    const ready = {
      ...readyOk,
      components: { ...readyOk.components, llm: { status: "ok" as const, detail: "ollama:qwen2.5:3b" }, embeddings: { status: "ok" as const, detail: "ollama:bge-m3, dim 1024" } },
    };
    const lines = describeProviders(ready, undefined);
    expect(lines.map((l) => l.text).join(" ")).toContain("локальная модель (Ollama)");
    expect(lines.map((l) => l.text).join(" ")).toContain("текст не покидает сервер");
    expect(hasExternalProvider(lines)).toBe(false);
  });

  it("openai_compatible from the response providers is flagged as external", () => {
    const lines = describeProviders(readyOk, {
      llm_provider: "openai_compatible",
      llm_model: "some-model",
      embedding_provider: "ollama",
      embedding_model: "bge-m3",
      embedding_dim: 1024,
      routing: "none",
    });
    const llm = lines.find((l) => l.role === "llm")!;
    expect(llm.external).toBe(true);
    expect(llm.text).toContain("отправляется внешнему провайдеру");
    expect(hasExternalProvider(lines)).toBe(true);
  });
});
