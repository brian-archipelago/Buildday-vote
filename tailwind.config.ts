import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "var(--font-inter)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        display: [
          "var(--font-display)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
      },
      colors: {
        brand: {
          blue: "#2E68FF",
          mint: "#38F5A3",
          navy: "#1B2D50",
          "deep-navy": "#103468",
          teal: "#00BDA5",
          "subtle-blue": "#5B8AFF",
          slate: "#475569",
          "slate-light": "#64748B",
          danger: "#F43F5E",
        },
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4,0,0.6,1) infinite",
        "bar-grow": "bar-grow 0.8s cubic-bezier(0.16,1,0.3,1) forwards",
        "float": "float 8s ease-in-out infinite",
        "gradient": "gradient 18s ease infinite",
      },
      keyframes: {
        "bar-grow": { from: { width: "0%" }, to: { width: "var(--tw-bar)" } },
        "float": {
          "0%,100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-14px)" },
        },
        "gradient": {
          "0%,100%": { "background-position": "0% 50%" },
          "50%": { "background-position": "100% 50%" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
