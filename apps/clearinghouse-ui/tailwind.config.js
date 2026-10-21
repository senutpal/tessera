/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        institutional: {
          bg: "#0B0F17",
          panel: "#111827",
          border: "#1F2937",
          muted: "#9CA3AF",
        },
      },
    },
  },
  plugins: [],
};
