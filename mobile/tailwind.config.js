/** @type {import('tailwindcss').Config} */
module.exports = {
  // NativeWind v4: quét toàn bộ file tsx/ts/js để generate classes
  content: [
    "./App.{js,jsx,ts,tsx}",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      // Bảng màu tùy chỉnh cho VietMeeting AI (dark theme)
      colors: {
        // Nền chính – xanh đen đậm
        bg: {
          primary:   "#0f0f1a",
          secondary: "#1a1a2e",
          card:      "#16213e",
          elevated:  "#1f2a4a",
        },
        // Màu nhấn – gradient tím-xanh
        accent: {
          purple:  "#7c3aed",
          blue:    "#2563eb",
          indigo:  "#4f46e5",
          light:   "#a78bfa",
          glow:    "#8b5cf6",
        },
        // Màu trạng thái
        state: {
          recording: "#ef4444",
          success:   "#10b981",
          warning:   "#f59e0b",
          info:      "#3b82f6",
        },
        // Text
        text: {
          primary:   "#f1f5f9",
          secondary: "#94a3b8",
          muted:     "#64748b",
        },
        // Border
        border: {
          subtle:  "#1e293b",
          default: "#334155",
          accent:  "#4f46e5",
        },
      },
      fontFamily: {
        sans: ["System"],
      },
      borderRadius: {
        "4xl": "2rem",
        "5xl": "2.5rem",
      },
    },
  },
  plugins: [],
};
