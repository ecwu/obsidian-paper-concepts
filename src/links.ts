import { posix } from 'node:path';
import type { VaultPort } from './types';
import { within } from './util';

export const normalized = (s: string): string => s.normalize('NFKC').trim().toLocaleLowerCase();
export interface LinkTarget { path: string; title: string; aliases: string[] }

/** Resolves link targets written by the model to vault paths inside the knowledge folder. */
export class LinkResolver {
  private names = new Map<string, Set<string>>();
  private paths: Set<string>;
  /** `pending` notes are about to be written, so they count as existing. `materials` is the folder relative image links point into. */
  constructor(private vault: VaultPort, private root: string, existing: LinkTarget[], pending: LinkTarget[], private materials: string) {
    for (const note of [...existing, ...pending]) {
      for (const name of [note.title, ...note.aliases, note.path, note.path.replace(/\.md$/, ''), posix.basename(note.path, '.md')]) this.add(name, note.path);
    }
    this.paths = new Set(pending.map(note => note.path));
  }
  /** Makes `name` refer only to `path`, overriding any other note that shares it. */
  pin(name: string, path: string): void { this.names.set(normalized(name), new Set([path])); }

  async resolve(target: string, from: string): Promise<string> {
    let decoded: string;
    try { decoded = decodeURIComponent(target); } catch { throw new Error('链接编码无效'); }
    const matches = this.names.get(normalized(decoded));
    if (matches && matches.size > 1) throw new Error(`链接名称不唯一：${target}`);
    if (matches?.size === 1) return [...matches][0]!;
    const candidates = [decoded, posix.normalize(posix.join(posix.dirname(from), decoded))];
    candidates.push(posix.normalize(posix.join(this.materials, decoded)));
    for (const candidate of candidates.filter(c => within(c, this.root))) {
      for (const path of [candidate, candidate + '.md']) if (this.paths.has(path) || await this.vault.exists(path)) return path;
    }
    throw new Error(`链接目标不存在或超出知识目录：${target}`);
  }

  private add(name: string, path: string): void {
    const key = normalized(name);
    this.names.set(key, (this.names.get(key) ?? new Set<string>()).add(path));
  }
}

type Edit = { start: number; end: number; text: string };

/** Rewrites wiki links to full vault paths and Markdown links to paths relative to `from`. Code spans and fences are left untouched. */
export async function rewriteLinks(body: string, from: string, links: LinkResolver): Promise<string> {
  const parts = body.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
  for (let i = 0; i < parts.length; i += 2) parts[i] = applyEdits(parts[i]!, await linkEdits(parts[i]!, from, links));
  return parts.join('');
}

async function linkEdits(text: string, from: string, links: LinkResolver): Promise<Edit[]> {
  const edits: Edit[] = [];
  for (const m of text.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const [dest = '', label] = m[2]!.split('|');
    const anchorAt = dest.indexOf('#');
    const target = anchorAt < 0 ? dest : dest.slice(0, anchorAt), anchor = anchorAt < 0 ? '' : dest.slice(anchorAt);
    if (!target) continue;
    const path = await links.resolve(target, from);
    edits.push({ start: m.index, end: m.index + m[0].length, text: `${m[1]}[[${path.replace(/\.md$/, '')}${anchor}|${label || target}]]` });
  }
  for (const m of text.matchAll(/(!?\[[^\]\n]*\])\(([^)\n]+)\)/g)) {
    const dest = m[2]!.trim().replace(/^<|>$/g, '');
    if (/^(https?:|mailto:|data:)/i.test(dest) || dest.startsWith('#')) continue;
    const [target = '', anchor] = dest.split('#');
    const path = await links.resolve(target, from);
    const url = posix.relative(posix.dirname(from), path).split('/').map(encodeURIComponent).join('/') + (anchor ? '#' + anchor : '');
    edits.push({ start: m.index, end: m.index + m[0].length, text: `${m[1]}(${url})` });
  }
  return edits;
}

function applyEdits(text: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
