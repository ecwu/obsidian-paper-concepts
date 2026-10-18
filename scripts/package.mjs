import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const files = {};
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await collect(directory + '/' + entry.name, relative + '/');
    else files['paper-concepts/' + relative] = new Uint8Array(await readFile(directory + '/' + entry.name));
  }
}
await collect('dist');
files['paper-concepts/INSTALL.txt'] = strToU8('Copy this folder to <vault>/.obsidian/plugins/.\nIn Settings > Community plugins, select the switch for Paper Concepts.\nSet a knowledge folder before you import PDFs.\n');
await mkdir('artifacts', { recursive: true });
await writeFile(`artifacts/paper-concepts-${manifest.version}.zip`, zipSync(files));
console.log(`artifacts/paper-concepts-${manifest.version}.zip`);
