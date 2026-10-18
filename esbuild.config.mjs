import { context } from 'esbuild';
import { mkdir, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
const watching = process.argv.includes('--watch');
await mkdir('dist', { recursive: true });
for (const file of ['manifest.json', 'styles.css']) await copyFile(file, 'dist/' + file);
await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'dist/pdf.worker.mjs');
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) await cp('node_modules/pdfjs-dist/' + folder, 'dist/pdf-resources/' + folder, { recursive: true });
let notices = 'Paper Concepts bundles the following third-party packages.\n';
for (const name of ['pdfjs-dist', 'yaml', 'fflate']) notices += '\n\n' + name + '\n\n' + await readFile('node_modules/' + name + '/LICENSE', 'utf8');
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices);
const build = await context({ entryPoints: ['src/main.ts'], outfile: 'dist/main.js', bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['obsidian', 'electron', 'node:*'], sourcemap: watching ? 'inline' : false, minify: !watching, logLevel: 'info' });
if (watching) await build.watch(); else { await build.rebuild(); await build.dispose(); }
