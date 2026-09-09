import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // Mirrors the Static Web Apps routing so local dev matches production.
      '/api': 'http://localhost:7071',
    },
  },
});
