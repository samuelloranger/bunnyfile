import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Proxy target — Node-side only. The VITE_ prefix is avoided intentionally
// so Vite won't try to expose it to the client bundle.
const API_PROXY_TARGET = process.env.SERVER_URL ?? 'http://localhost:3901';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 3900),
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
});
