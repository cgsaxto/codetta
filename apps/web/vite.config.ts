import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The fixtures live at the workspace root, outside apps/web, because the API will
// eventually write them too. Vite refuses to serve outside its root without this.
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = fileURLToPath(new URL('../../fixtures', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@fixtures': fixtures },
  },
  server: {
    fs: { allow: [workspaceRoot] },
    // So the app can call a same-origin /api in development and in production alike, and
    // needs no build-time configuration to know where the service is. The API also sets
    // permissive CORS, which is what VITE_API_URL is for when the two are hosted apart.
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
