import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Ensures assets are linked relatively for GitHub Pages
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 3000,
    open: false,
  },
});
