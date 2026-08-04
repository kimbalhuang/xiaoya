/** @type {import('tailwindcss').Config} */
module.exports = {
  // 与 MUI 共存：关闭 preflight，避免 Tailwind 的基础样式重置与 MUI 冲突。
  corePlugins: {
    preflight: false,
  },
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
