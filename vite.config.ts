import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite 配置：开发模式下把 /ws 与 /avatar 两个 WebSocket 通道
// 反向代理到本地 Node 后端（ws://localhost:3001），避免浏览器跨域/协议头限制。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
        configure: (proxy) => silenceProxyReset(proxy),
      },
      '/avatar': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
        configure: (proxy) => silenceProxyReset(proxy),
      },
    },
  },
  build: {
    outDir: 'dist',
    // 生产构建关闭 sourcemap：显著减小产物体积、缩短构建耗时，且数字人不依赖源码映射调试
    sourcemap: false,
    // 锁定语法目标，启用 esbuild 最小化与 CSS 压缩（更快的首屏解析）
    target: 'es2020',
    minify: 'esbuild',
    cssMinify: true,
    // 提高单包体积告警阈值，避免长尾分包噪声；并关闭压缩体积上报以加速构建统计
    chunkSizeWarningLimit: 1500,
    reportCompressedSize: false,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        // 按vendor拆分：react / mui / hls 各自独立 chunk，利用浏览器并行加载与长效缓存，
        // 首屏只需加载当前路由所需的包，降低 TTI（数字人起播更快）
        manualChunks: {
          react: ['react', 'react-dom'],
          mui: ['@mui/material', '@mui/icons-material', '@emotion/react', '@emotion/styled'],
          hls: ['hls.js'],
        },
      },
    },
  },
  // 预打包高频浏览器依赖，避免开发期重复解析、加快冷启动与 HMR
  optimizeDeps: {
    include: ['react', 'react-dom', '@mui/material', '@mui/icons-material', 'hls.js', 'zustand'],
  },
});

/**
 * 开发期：浏览器重连 / HMR 频繁断开时，目标（后端）会 RST 代理 socket，
 * vite 默认会打印 `[vite] ws proxy socket error`（ECONNRESET/ECONNABORTED）。
 * 这是正常现象，需要静默，避免刷屏。
 *
 * 注意：仅在 `configure` 里 `proxy.on('error')` 加监听器是无效的——
 * vite 在 configure 之后还会注册它自己的 error 监听器，两个都会触发，
 * 于是 vite 的日志照旧打印。必须从事件派发层拦截：覆盖 `proxy.emit`，
 * 对特定错误码直接不派发（return false），vite 注册的监听器也收不到，
 * 从而彻底压住噪声；其余事件/错误码完全透传，不影响代理与日志。
 *
 * 注意2（关键）：`[vite] ws proxy socket error:` 这个日志**不走 proxy.emit('error')**，
 * 而是 vite 在 `proxy.on('proxyReqWs')` 回调里给浏览器连接 socket 注册了
 * `socket.on('error')` 监听器（见 vite 源码 chunks/dep-*.js 的 proxyReqWs 分支）。
 * 因此必须同时拦截 **socket 的 error 事件派发**（覆盖 socket.emit），
 * 否则该路径的 ECONNABORTED 依然会打印刷屏。
 */
function silenceProxyReset(proxy: any): void {
  const origEmit = proxy.emit.bind(proxy);
  proxy.emit = function (event: string, ...args: any[]): boolean {
    if (event === 'error') {
      const err = args[0];
      const code = err && err.code;
      if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE') {
        return false; // 拦截：不派发给任何 listener（含 vite 默认的 ws 错误日志）
      }
    }
    return origEmit(event, ...args);
  };

  // 拦截 vite 在 proxyReqWs 中注册到 socket 上的 error 日志（ws proxy socket error 路径）
  proxy.on('proxyReqWs', (_proxyReq: unknown, _req: unknown, socket: any) => {
    if (!socket || typeof socket.emit !== 'function') return;
    const origSocketEmit = socket.emit.bind(socket);
    socket.emit = function (event: string, ...args: any[]): boolean {
      if (event === 'error') {
        const err = args[0];
        const code = err && err.code;
        if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE') {
          return false; // 浏览器端 socket 断开类错误：静默，不触发 vite 的 logger.error
        }
      }
      return origSocketEmit(event, ...args);
    };
  });
}
