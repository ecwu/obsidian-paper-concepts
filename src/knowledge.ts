import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { parseDocument, isMap } from 'yaml';
import type { ContextSnapshot, FileChange, GeneratedConcept, GenerationResult, Job, NoteSnapshot, RuntimeStore, VaultPort, WriteJournal } from './types';
import { layoutOf, type Layout } from './settings';
import { scopedVault } from './scoped-vault';
import { LinkResolver, normalized, rewriteLinks } from './links';
import { aborted, ConflictError, hash, link, safeFilename, within } from './util';

const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const union = (...lists: string[][]): string[] => [...new Set(lists.flat())];

export function splitNote(content: string): { yaml: string; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  return match ? { yaml: match[1]!, body: content.slice(match[0].length).trimStart() } : { yaml: '', body: content };
}
function yamlDocument(content: string) {
  const { yaml } = splitNote(content);
  const doc = parseDocument(yaml || '{}');
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('笔记的 YAML 属性无效，未修改原文件');
  if (!yaml) doc.contents.flow = false;
  return doc;
}
export function mergeBodies(existing: string, generated: string): string {
  type Section = { heading: string; key: string; body: string };
  const parse = (text: string): Section[] => {
    const sections: Section[] = [{ heading: '', key: '', body: '' }];
    let fence = '';
    for (const line of text.trim().split('\n')) {
      const code = /^\s*(```+|~~~+)/.exec(line);
      if (code) { if (!fence) fence = code[1]![0]!; else if (code[1]![0] === fence) fence = ''; }
      const heading = !fence && /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) sections.push({ heading: line, key: normalized(heading[2]!), body: '' });
      else sections.at(-1)!.body += line + '\n';
    }
    return sections;
  };
  const oldSections = parse(existing), next = parse(generated);
  const comparable = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const old of oldSections) {
    if (!old.body.trim() && !old.heading) continue;
    const target = next.find(section => section.key === old.key);
    if (!target) { next.push(old); continue; }
    if (/个人批注|个人笔记|annotations?|personal notes|my notes/i.test(old.key)) { target.body = old.body; continue; }
    for (const block of old.body.trim().split(/\n\s*\n/)) {
      if (block.trim() && !comparable(target.body).includes(comparable(block))) target.body = target.body.trimEnd() + '\n\n' + block + '\n';
    }
  }
  return next.map(section => (section.heading ? section.heading + '\n\n' : '') + section.body.trim()).filter(Boolean).join('\n\n');
}
export function renderNote(before: string | null, fields: Record<string, unknown>, body: string): string {
  const doc = yamlDocument(before ?? '');
  for (const [key, value] of Object.entries(fields)) if (value !== null && value !== undefined) doc.set(key, value);
  return `---\n${String(doc).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export class KnowledgeRepository {
  private vault: VaultPort;
  constructor(vault: VaultPort, private layout: Layout) { this.vault = scopedVault(vault, layout.root); }
  async snapshot(): Promise<ContextSnapshot> {
    const notes: NoteSnapshot[] = [];
    for (const path of (await this.vault.list()).sort()) {
      if (this.layout.excluded.some(dir => within(path, dir)) || !path.endsWith('.md') || /\.excalidraw\.md$/i.test(path)) continue;
      const note = this.read(path, await this.vault.read(path));
      if (note) notes.push(note);
    }
    const ids = notes.map(n => n.id);
    if (new Set(ids).size !== ids.length) throw new Error('知识目录中存在重复的 pc-id，请先修正复制笔记的标识');
    return { notes, digest: hash(JSON.stringify(notes.map(n => [n.id, n.path, n.hash]))) };
  }
  async assertUnchanged(snapshot: ContextSnapshot): Promise<void> {
    if ((await this.snapshot()).digest !== snapshot.digest) throw new ConflictError();
  }
  /** Returns the note if its properties mark it as a paper or concept. */
  private read(path: string, content: string): NoteSnapshot | undefined {
    const { yaml } = splitNote(content);
    if (!yaml) return undefined;
    const doc = parseDocument(yaml);
    if (doc.errors.length || !isMap(doc.contents)) return undefined;
    const properties = doc.toJS() as Record<string, unknown>;
    if (properties.type !== 'paper' && properties.type !== 'concept') return undefined;
    return {
      id: typeof properties['pc-id'] === 'string' ? properties['pc-id'] : 'legacy-' + hash(path), path,
      title: typeof properties.title === 'string' ? properties.title : posix.basename(path, '.md'),
      aliases: strings(properties.aliases), type: properties.type, content, properties, hash: hash(content)
    };
  }
}

interface PlannedNote { path: string; before?: NoteSnapshot; title: string; aliases: string[]; fields: Record<string, unknown>; body: string }

/** Notes without a stable pc-id get one when they are first written. */
const stableId = (before?: NoteSnapshot): string => !before || before.id.startsWith('legacy-') ? randomUUID() : before.id;
const timestamps = (before: NoteSnapshot | undefined, now: string) => ({ updated: now, ...(!before ? { created: now } : {}) });

/** Hands out unused note paths, including paths reserved earlier in the same plan. */
function pathAllocator(vault: VaultPort): (folder: string, title: string) => Promise<string> {
  const reserved = new Set<string>();
  return async (folder, title) => {
    const base = `${folder}/${safeFilename(title)}`;
    let path = base + '.md', suffix = 2;
    while (reserved.has(normalized(path)) || await vault.exists(path)) path = `${base} (${suffix++}).md`;
    reserved.add(normalized(path));
    return path;
  };
}

/** Finds the existing concept a generated concept updates: by explicit id, otherwise by title or alias. */
function matchConcept(concept: GeneratedConcept, notes: NoteSnapshot[]): NoteSnapshot | undefined {
  const concepts = notes.filter(n => n.type === 'concept');
  if (concept.existingId) {
    const before = concepts.find(n => n.id === concept.existingId);
    if (!before) throw new Error('结果引用未知或重复的 Concept 标识');
    return before;
  }
  const names = [concept.title, ...concept.aliases].map(normalized);
  const matches = concepts.filter(n => [n.title, ...n.aliases].some(a => names.includes(normalized(a))));
  if (matches.length > 1) throw new Error('Concept 名称或别名对应多个现有页面');
  return matches[0];
}

export class KnowledgeWriter {
  constructor(private vault: VaultPort, private store: RuntimeStore) {}

  /** Plans every file change for a result and saves it as a journal. Nothing is written to the vault. */
  async prepare(job: Job, result: GenerationResult, context: ContextSnapshot): Promise<WriteJournal> {
    const layout = layoutOf(job.settings), vault = scopedVault(this.vault, job.root), now = new Date().toISOString();
    const allocate = pathAllocator(vault);
    const existingPaper = context.notes.find(n => n.type === 'paper' && n.properties['pc-source'] === job.hash);
    const paperPath = existingPaper?.path ?? await allocate(layout.papers, result.paper.title);
    const concepts: PlannedNote[] = [];
    const seenIds = new Set<string>(), seenTitles = new Set<string>();
    for (const concept of result.concepts) {
      const before = matchConcept(concept, context.notes);
      if (before && seenIds.has(before.id)) throw new Error('同一个 Concept 被返回多次');
      if (before) seenIds.add(before.id);
      const title = before?.title ?? concept.title;
      if (seenTitles.has(normalized(title))) throw new Error('结果包含重复的新 Concept');
      seenTitles.add(normalized(title));
      const path = before?.path ?? await allocate(layout.concepts, title);
      const aliases = union(before?.aliases ?? [], concept.aliases);
      concepts.push({ path, before, title, aliases, body: concept.body, fields: {
        title, type: 'concept', 'pc-id': stableId(before), aliases,
        tags: union(strings(before?.properties.tags), concept.tags),
        sources: union(strings(before?.properties.sources), [link(paperPath, result.paper.title)]),
        ...timestamps(before, now)
      } });
    }
    const paper: PlannedNote = { path: paperPath, before: existingPaper, title: result.paper.title, aliases: [], body: paperBody(job, result, concepts), fields: {
      title: result.paper.title, type: 'paper', 'pc-id': stableId(existingPaper), 'pc-source': job.hash,
      authors: result.paper.authors, year: result.paper.year, doi: result.paper.doi, arxiv: result.paper.arxiv,
      tags: union(strings(existingPaper?.properties.tags), result.paper.tags), source: link(job.source, job.filename),
      'pc-parser': job.settings.parser, 'pc-prompt': job.promptHash, ...timestamps(existingPaper, now)
    } };
    const planned = [...concepts, paper];
    const links = new LinkResolver(vault, job.root, context.notes, planned, job.parsed ? posix.dirname(job.parsed) : undefined);
    links.pin(result.paper.title, paperPath);
    const changes: FileChange[] = [];
    for (const note of planned) {
      const before = note.before?.content ?? null;
      const body = await rewriteLinks(note.before ? mergeBodies(splitNote(note.before.content).body, note.body) : note.body, note.path, links);
      changes.push({ path: note.path, before, after: renderNote(before, note.fields, body), done: false });
    }
    const journal: WriteJournal = { version: 1, jobId: job.id, root: job.root, paperPath, changes, complete: false };
    await this.store.saveJournal(journal);
    return journal;
  }

  /** Applies a journal file by file. Re-running it is safe; a file edited by someone else stops it with a ConflictError. */
  async apply(journal: WriteJournal, signal = new AbortController().signal): Promise<void> {
    const vault = scopedVault(this.vault, journal.root);
    for (const change of journal.changes) {
      aborted(signal);
      const current = await vault.exists(change.path) ? await vault.read(change.path) : null;
      if (current === change.after) { change.done = true; await this.store.saveJournal(journal); continue; }
      if (change.done || current !== change.before) throw new ConflictError(`文件已被修改或移动，未覆盖：${change.path}`);
      if (change.before === null) {
        await vault.mkdir(posix.dirname(change.path));
        await vault.create(change.path, change.after);
      } else {
        await vault.process(change.path, latest => {
          if (latest !== change.before) throw new ConflictError();
          return change.after;
        });
      }
      if (await vault.read(change.path) !== change.after) throw new ConflictError('保存后的笔记被其他进程修改');
      change.done = true; await this.store.saveJournal(journal);
    }
    journal.complete = true; await this.store.saveJournal(journal);
  }
}

/** The generated paper body plus the sections the plugin owns: concept links and the source PDF. */
function paperBody(job: Job, result: GenerationResult, concepts: PlannedNote[]): string {
  let body = result.paper.body;
  if (concepts.length) body += '\n\n## 本次关联概念\n\n' + concepts.map(c => '- ' + link(c.path, c.title)).join('\n');
  return body + `\n\n## 原始材料\n\n${link(job.source, job.filename)}`;
}
