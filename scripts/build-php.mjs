import { build } from 'vite';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

await build({configFile: 'vite.php.config.ts'});
await cp('php/server', 'dist-php/server', {recursive: true});
for (const file of ['index.php', '.htaccess', 'php.ini']) await cp(`php/${file}`, `dist-php/${file}`);
const base = (process.env.SERETINY_BASE_PATH ?? '/seretiny').replace(/\/$/, '');
const rules = await readFile('dist-php/.htaccess', 'utf8');
await writeFile('dist-php/.htaccess', rules.replace('RewriteBase /seretiny/', `RewriteBase ${base}/`));
const manifest = JSON.parse(await readFile('dist-php/.vite/manifest.json', 'utf8'));
const entry = Object.values(manifest).find(value => value.isEntry);
await mkdir('dist-php/server', {recursive: true});
const fonts = (await readdir('dist-php/assets'))
  .filter(file => file.startsWith('caveat-latin-') && !file.startsWith('caveat-latin-ext-') && file.endsWith('.woff2'))
  .map(file => `assets/${file}`);
await writeFile('dist-php/server/assets.json', JSON.stringify({js: entry.file, css: entry.css ?? [], fonts}));
console.log('PHP package ready in dist-php/');
