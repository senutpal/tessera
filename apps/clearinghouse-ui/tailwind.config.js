/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "'DM Sans'",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["'Geist Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "monospace"],
      },
      colors: {
        // High-end desaturated editorial palette (overriding AI-slop saturated neons)
        emerald: {
          50: "#f4f9f6",
          100: "#e5f2eb",
          200: "#c7e3d4",
          300: "#9ecdb7", // Refined sage/mineral green
          400: "#4ea884", // Quiet, elegant desaturated emerald
          500: "#368a68",
          600: "#276e52",
          700: "#215843",
          800: "#1d4737",
          900: "#193b2f",
          950: "#0b201a",
        },
        amber: {
          50: "#fdfbf7",
          100: "#f9f4ea",
          200: "#f1e5ce",
          300: "#e5d0a6",
          400: "#c99538", // Warm antique gold / bronze ochre (no canary neon)
          500: "#a87724",
          600: "#895d1b",
          700: "#6d4718",
          800: "#593a19",
          900: "#4b3117",
          950: "#2c1a0a",
        },
        rose: {
          50: "#fdf8f8",
          100: "#f9eeef",
          200: "#f3dadc",
          300: "#e7b5ba",
          400: "#c75463", // Refined brick crimson / terracotta (no hot pink)
          500: "#a93b4a",
          600: "#8c2a37",
          700: "#70202b",
          800: "#5d1d25",
          900: "#4f1c22",
          950: "#2b0a0e",
        },
        cyan: {
          50: "#f4f9fb",
          100: "#e4f1f6",
          200: "#c8e2ed",
          300: "#98c6db",
          400: "#4f98ba", // Desaturated steel blue / Nordic ice
          500: "#387c9c",
          600: "#2e6480",
          700: "#285168",
          800: "#254456",
          900: "#223a49",
          950: "#12232e",
        },
        institutional: {
          bg: "#09090B",
          panel: "#121215",
          border: "#27272A",
          muted: "#71717A",
        },
      },
    },
  },
  plugins: [],
};
