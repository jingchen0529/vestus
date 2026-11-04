/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 6px)",
        "2xl": "calc(var(--radius) + 6px)",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "sans-serif",
        ],
        mono: [
          "SF Mono",
          "ui-monospace",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      /* 染色阴影：用墨色而不是纯黑低透明度，浅色底上不发灰 */
      boxShadow: {
        xs: "0 1px 2px 0 rgb(16 20 28 / 0.04)",
        soft: "0 1px 2px rgb(16 20 28 / 0.04), 0 8px 24px -14px rgb(16 20 28 / 0.14)",
        lift: "0 1px 1px rgb(16 20 28 / 0.05), 0 18px 40px -22px rgb(16 20 28 / 0.22), 0 2px 8px -6px rgb(16 20 28 / 0.08)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        pulseSlow: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        shimmer: {
          "100%": {
            transform: "translateX(100%)",
          },
        },
        fadeUp: {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        /* 登录页背景：三团光斑各自漂移，周期互质，看不出循环 */
        driftA: {
          "0%, 100%": { transform: "translate3d(-6%, -4%, 0) scale(1)" },
          "50%": { transform: "translate3d(10%, 8%, 0) scale(1.18)" },
        },
        driftB: {
          "0%, 100%": { transform: "translate3d(7%, 5%, 0) scale(1.08)" },
          "50%": { transform: "translate3d(-9%, -6%, 0) scale(0.92)" },
        },
        driftC: {
          "0%, 100%": { transform: "translate3d(0, 8%, 0) scale(0.94)" },
          "50%": { transform: "translate3d(-8%, -9%, 0) scale(1.12)" },
        },
        /* 极慢的斜向扫光，给静止的网格一点流动感 */
        sweep: {
          "0%": { transform: "translate3d(-60%, -20%, 0) rotate(12deg)" },
          "100%": { transform: "translate3d(60%, 20%, 0) rotate(12deg)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pulse-slow": "pulseSlow 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-up": "fadeUp 0.42s cubic-bezier(0.22, 1, 0.36, 1) both",
        "drift-a": "driftA 21s ease-in-out infinite",
        "drift-b": "driftB 27s ease-in-out infinite",
        "drift-c": "driftC 33s ease-in-out infinite",
        sweep: "sweep 19s linear infinite",
      },
    },
  },
  plugins: [],
};
