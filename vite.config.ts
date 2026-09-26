import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// DEV_HTTPS=1 serves the dev site over HTTPS (self-signed) so phones can use the camera flag spotter:
// browsers only allow the camera on secure pages. Phones show a one-time certificate warning.
const https = process.env.DEV_HTTPS === '1';

export default defineConfig({
  root: 'web',
  plugins: [react(), ...(https ? [basicSsl()] : [])],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:8787',
      '/socket.io': { target: 'http://localhost:8787', ws: true },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
