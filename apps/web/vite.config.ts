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
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
