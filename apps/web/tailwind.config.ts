import type { Config } from "tailwindcss";

// Palette from docs/DESIGN.md, checked for WCAG AA (see docs/FRONTEND.md):
// graphite on warm-white 15.5:1, muted on warm-white 5.7:1, graphite on lime 13.8:1.
// Lime is only used as a fill behind graphite text (CTA, selected markers), never as text.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        graphite: { DEFAULT: "#17201C", soft: "#2A3530" },
        paper: "#F6F7F2",
        lime: { DEFAULT: "#D9F66F", deep: "#C6E852" },
        muted: "#59645D",
        stroke: "#DDE4DC",
        olive: "#5E6B12",
        warn: { fg: "#9A4A00", bg: "#FFF4E5" },
        danger: { fg: "#8F2D1F", bg: "#FDEDEA" },
        ok: { fg: "#1F5E3B", bg: "#E8F3EC" },
      },
      fontFamily: {
        sans: ["Manrope", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"],
      },
      borderRadius: {
        panel: "20px",
        control: "12px",
      },
      boxShadow: {
        panel: "0 1px 2px rgba(23,32,28,0.06), 0 8px 24px rgba(23,32,28,0.08)",
        control: "0 1px 2px rgba(23,32,28,0.10), 0 2px 8px rgba(23,32,28,0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
