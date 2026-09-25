import { defineConfig } from 'vite';
import path from 'node:path';
export default defineConfig({ root: 'src/renderer', base: './', build: { outDir: path.resolve('dist/renderer'), emptyOutDir: true } });
