import { describe, it, expect } from 'vitest';
import { KnowledgeRepository, KnowledgeWriter, renderNote, mergeBodies } from '../src/knowledge';
import { validateResult } from '../src/result';
import { ConflictError, relativePath, within, hash } from '../src/util';
import { layoutOf, validateSettings } from '../src/settings';
import { MemoryStore, MemoryVault, job, result, settings } from './helpers';

describe('knowledge boundaries', () => {
  it.each(['../Other', '/absolute', 'Research/../Other', '.obsidian', 'C:\\Users\\x', 'Research//papers'])('rejects unsafe path %s', path => { expect(() => relativePath(path)).toThrow(); });
  it('uses a directory boundary rather than a text prefix', () => { expect(within('ResearchOther/a.md', 'Research')).toBe(false); });
  it('rejects overlapping output directories', () => { const s = settings(); s.concepts = '100-Papers/concepts'; expect(() => validateSettings(s)).toThrow(); });
  it('preserves unknown YAML properties, comments and quoted values', () => {
    const original = '---\ntitle: Old\ncustom: "a:b" # keep\ncreated: 2020-01-01\n---\n\nOld body';
    const rendered = renderNote(original, { title: 'New', updated: '2026-10-18' }, 'New body');
    expect(rendered).toContain('custom: "a:b" # keep'); expect(rendered).toContain('created: 2020-01-01'); expect(rendered).toContain('New body');
  });
  it('rejects malformed generation data', () => { const r = result(); (r.paper as any).authors = 'unknown'; expect(() => validateResult(r)).toThrow(); });
  it('preserves old evidence and personal annotations when a model omits them', () => {
    const merged = mergeBodies('## 概述\n\nExisting evidence.\n\n## 个人批注\n\nKeep my note.\n\n## Unrelated section\n\nKeep this too.', '## 概述\n\nNew synthesis.');
    for (const text of ['Existing evidence.', 'Keep my note.', 'Keep this too.', 'New synthesis.']) expect(merged).toContain(text);
  });
  it('does not index drawings, parsed materials or outside notes', async () => {
    const v = new MemoryVault(); for (const path of ['Research/200-Concepts/a.md', 'Research/Assets/parsed.md', 'Research/a.excalidraw.md', 'ResearchOther/a.md']) v.files.set(path, '---\ntype: concept\ntitle: A\n---\ntext');
    expect((await new KnowledgeRepository(v, layoutOf(settings())).snapshot()).notes.map(n => n.path)).toEqual(['Research/200-Concepts/a.md']);
  });
});

describe('automatic write and recovery', () => {
  async function fixture() {
    const vault = new MemoryVault(), store = new MemoryStore(), j = job(); vault.files.set(j.parsed, '# Parsed');
    const repository = new KnowledgeRepository(vault, layoutOf(j.settings)), writer = new KnowledgeWriter(vault, store);
    return { vault, store, j, repository, writer };
  }
  it('creates linked notes and repeats a completed journal without extra files', async () => {
    const f = await fixture(), journal = await f.writer.prepare(f.j, result(), await f.repository.snapshot());
    await f.writer.apply(journal); await f.writer.apply(journal);
    const paper = await f.vault.read(journal.paperPath);
    expect(paper).toContain('[[Research/200-Concepts/Attention|Attention]]'); expect(paper).toContain(f.j.parsed.replace(/\.md$/, ''));
    expect((await f.vault.list()).length).toBe(3); expect(journal.complete).toBe(true);
  });
  it('reuses a concept by alias and preserves its file name and personal property', async () => {
    const f = await fixture(); const path = 'Research/200-Concepts/My chosen filename.md';
    f.vault.files.set(path, '---\ntype: concept\ntitle: Attention\naliases: [Attn]\npc-id: stable-id\npersonal: important # keep\nsources: ["[[Earlier Paper]]"]\n---\n\nOld knowledge');
    const r = result(); r.concepts[0]!.title = 'Attn';
    const journal = await f.writer.prepare(f.j, r, await f.repository.snapshot()); await f.writer.apply(journal);
    const content = await f.vault.read(path);
    expect(content).toContain('personal: important # keep'); expect(content).toContain('Earlier Paper'); expect(content).toContain('[[Research/100-Papers/Study|Study]]');
    expect(journal.changes[0]!.path).toBe(path);
  });
  it('does not overwrite two papers with the same title', async () => {
    const f = await fixture(); f.vault.files.set('Research/100-Papers/Study.md', 'An unrelated paper');
    const journal = await f.writer.prepare(f.j, result(), await f.repository.snapshot()); await f.writer.apply(journal);
    expect(journal.paperPath).toBe('Research/100-Papers/Study (2).md'); expect(await f.vault.read('Research/100-Papers/Study.md')).toBe('An unrelated paper');
  });
  it('links a same-title new paper to its distinct allocated path', async () => {
    const f = await fixture(); f.vault.files.set('Research/100-Papers/Study.md', '---\ntitle: Study\ntype: paper\npc-source: different-pdf\n---\nAn earlier study');
    const journal = await f.writer.prepare(f.j, result(), await f.repository.snapshot()); await f.writer.apply(journal);
    expect(journal.paperPath).toBe('Research/100-Papers/Study (2).md'); expect(await f.vault.read('Research/200-Concepts/Attention.md')).toContain('[[Research/100-Papers/Study (2)|Study]]');
  });
  it('updates the same paper on reanalysis and accumulates sources', async () => {
    const f = await fixture(); await f.writer.apply(await f.writer.prepare(f.j, result(), await f.repository.snapshot()));
    const j2 = { ...job(), hash: f.j.hash, parsed: f.j.parsed };
    const second = await f.writer.prepare(j2, result(), await f.repository.snapshot()); await f.writer.apply(second);
    expect(second.paperPath).toBe('Research/100-Papers/Study.md'); expect((await f.vault.list()).length).toBe(3);
  });
  it('preserves manual body additions to both Paper and Concept during reanalysis', async () => {
    const f = await fixture(); const first = await f.writer.prepare(f.j, result(), await f.repository.snapshot()); await f.writer.apply(first);
    for (const path of ['Research/100-Papers/Study.md', 'Research/200-Concepts/Attention.md']) f.vault.files.set(path, await f.vault.read(path) + '\n## 个人批注\n\nHuman-only annotation.\n');
    const r = result(); r.paper.body = '## 摘要\n\nNew paper analysis.'; r.concepts[0]!.body = '## 概述\n\nNew concept analysis.';
    const next = await f.writer.prepare(f.j, r, await f.repository.snapshot()); await f.writer.apply(next);
    expect(await f.vault.read('Research/100-Papers/Study.md')).toContain('Human-only annotation.'); expect(await f.vault.read('Research/200-Concepts/Attention.md')).toContain('Human-only annotation.');
  });
  it('rejects broken links before writing any notes', async () => {
    const f = await fixture(); const r = result(); r.paper.body += '\n[[Missing Concept]]';
    await expect(f.writer.prepare(f.j, r, await f.repository.snapshot())).rejects.toThrow('链接目标'); expect((await f.vault.list()).length).toBe(1);
  });
  it('rewrites encoded Markdown links to saved parsed images', async () => {
    const f = await fixture(); f.j.parsed = 'Research/Assets/paper/parsed/local-v1/full.md'; f.vault.files.set(f.j.parsed, '# Parsed');
    f.vault.files.set('Research/Assets/paper/parsed/local-v1/images/Figure 1.png', new Uint8Array([1]));
    const r = result(); r.paper.body += '\n![Figure](images/Figure%201.png)';
    const journal = await f.writer.prepare(f.j, r, await f.repository.snapshot());
    expect(journal.changes.at(-1)!.after).toContain('../Assets/paper/parsed/local-v1/images/Figure%201.png');
  });
  it('ignores demonstration links in code blocks', async () => {
    const f = await fixture(); const r = result(); r.paper.body += '\n```md\n[[Example]]\n```';
    await expect(f.writer.prepare(f.j, r, await f.repository.snapshot())).resolves.toBeDefined();
  });
  it('detects an edit inside the atomic process callback', async () => {
    const f = await fixture(); f.vault.files.set('Research/200-Concepts/Attention.md', '---\ntitle: Attention\ntype: concept\n---\nOld');
    const journal = await f.writer.prepare(f.j, result(), await f.repository.snapshot());
    f.vault.beforeProcess = path => f.vault.files.set(path, 'Human edit');
    await expect(f.writer.apply(journal)).rejects.toBeInstanceOf(ConflictError);
    expect(await f.vault.read('Research/200-Concepts/Attention.md')).toBe('Human edit');
  });
  it('recognizes a write completed before its completion flag was saved', async () => {
    const f = await fixture(); const journal = await f.writer.prepare(f.j, result(), await f.repository.snapshot());
    f.vault.files.set(journal.changes[0]!.path, journal.changes[0]!.after);
    await f.writer.apply(journal); expect(journal.complete).toBe(true);
  });
  it('does not restore a completed file over a later human edit', async () => {
    const f = await fixture(); const journal = await f.writer.prepare(f.j, result(), await f.repository.snapshot()); await f.writer.apply(journal);
    f.vault.files.set(journal.changes[0]!.path, 'Human edit');
    await expect(f.writer.apply(journal)).rejects.toThrow('未覆盖');
  });
  it('detects renamed notes during analysis', async () => {
    const f = await fixture(); f.vault.files.set('Research/200-Concepts/A.md', '---\ntype: concept\ntitle: A\npc-id: stable\n---\nText');
    const snapshot = await f.repository.snapshot(); const content = await f.vault.read('Research/200-Concepts/A.md'); f.vault.files.delete('Research/200-Concepts/A.md'); f.vault.files.set('Research/200-Concepts/B.md', content);
    await expect(f.repository.assertUnchanged(snapshot)).rejects.toBeInstanceOf(ConflictError);
  });
});
