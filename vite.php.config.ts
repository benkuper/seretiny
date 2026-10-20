import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const base = (process.env.SERETINY_BASE_PATH ?? '/seretiny').replace(/\/$/, '');
export default defineConfig({
  root: 'php/client',
  base: `${base}/`,
  publicDir: '../../static',
  resolve: { alias: {
    '#lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
    '$app/forms': fileURLToPath(new URL('./php/client/forms.ts', import.meta.url)),
    '$app/navigation': fileURLToPath(new URL('./php/client/navigation.ts', import.meta.url))
  } },
  plugins: [{
    name: 'php-subdirectory-paths', enforce: 'pre',
    transform(code, id) {
      if (!/\.svelte$/.test(id) || !id.replaceAll('\\', '/').includes('/src/')) return;
      return code
        .replace(/((?:href|src|action)=["'])\/(?!\/)/g, `$1${base}/`)
        .replace(/(fetch\(['"])\/(?!\/)/g, `$1${base}/`)
        .replace(/(url\(['"]?)\/(?!\/)/g, `$1${base}/`);
    }
  }, svelte({configFile: false})],
  build: { outDir: '../../dist-php', emptyOutDir: true, manifest: true, rollupOptions: {
    input: fileURLToPath(new URL('./php/client/main.ts', import.meta.url))
  } }
});
