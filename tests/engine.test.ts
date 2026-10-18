import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { TaskEngine } from '../src/engine';
import { StabilityTracker } from '../src/inbox';
import type { GenerationResult, HarnessAdapter, ParsedPaper } from '../src/types';
import { MemoryStore, MemoryVault, result, samplePdf, settings, until } from './helpers';

function fixture(run?: (signal: AbortSignal) => Promise<GenerationResult>) {
  const vault = new MemoryVault(), store = new MemoryStore(), s = settings(); let parses = 0, runs = 0;
  const harness: HarnessAdapter = { run: async (_request, signal) => { runs++; return run ? run(signal) : result(); } };
  const deps = { vault, store, settings: () => s, parser: async () => ({ parse: async (): Promise<ParsedPaper> => { parses++; return { markdown: 'Full paper text', assets: [], pages: [], parser: 'fake' }; } }), harness: () => harness };
  const engine = new TaskEngine(deps);
  return { engine, deps, vault, store, settings: s, get parses() { return parses; }, get runs() { return runs; } };
}
describe('serial resumable pipeline', () => {
  it('publishes restored completed tasks to an already open view', async () => {
    const f = fixture(); f.engine.setPaused(true); await f.engine.start(); const j = await f.engine.importPdf(samplePdf(), 'study.pdf'); j.phase = 'succeeded'; await f.store.saveJob(j); await f.engine.stop();
    let changes = 0; const restored = new TaskEngine({ ...f.deps, onChange: () => { changes++; } }); await restored.start(); expect(restored.jobs).toHaveLength(1); expect(changes).toBeGreaterThan(0); await restored.stop();
  });
  it('saves source, parses, generates and writes notes', async () => {
    const f = fixture(); await f.engine.start(); const job = await f.engine.importPdf(samplePdf(), 'study.pdf');
    await until(() => job.phase === 'succeeded' || job.phase === 'failed');
    expect(job.error).toBeUndefined(); expect(job.phase).toBe('succeeded');
    expect([...f.vault.files.keys()].some(path => path.endsWith('.pdf'))).toBe(false); expect(await f.store.loadSource(job.hash)).toBeNull();
    expect(await f.vault.read(job.paperPath!)).toContain('Attention'); await f.engine.stop();
  });
  it('deduplicates simultaneous imports by file content', async () => {
    const f = fixture(); f.engine.setPaused(true); await f.engine.start();
    const [a, b] = await Promise.all([f.engine.importPdf(samplePdf(), 'a.pdf'), f.engine.importPdf(samplePdf(), 'b.pdf')]);
    expect(a.id).toBe(b.id); expect(f.engine.jobs.length).toBe(1); await f.engine.stop();
  });
  it('continues a batch after one invalid PDF', async () => {
    const f = fixture(); f.engine.setPaused(true); await f.engine.start();
    const batch = await f.engine.importBatch([{ name: 'bad.pdf', read: async () => new Uint8Array([1, 2]) }, { name: 'study.pdf', read: async () => samplePdf() }]);
    expect(batch.errors).toHaveLength(1); expect(batch.errors[0]).toContain('bad.pdf'); expect(batch.jobs).toHaveLength(1); await f.engine.stop();
  });
  it('uses MinerU after switching parsers even when a local job and cache already exist', async () => {
    const f = fixture(); const selected: string[] = [];
    const engine = new TaskEngine({ ...f.deps, parser: async kind => { selected.push(kind); return { parse: async () => ({ markdown: 'Parsed with ' + kind, assets: [], pages: [], parser: kind }) }; } });
    await engine.start(); const first = await engine.importPdf(samplePdf(), 'study.pdf'); await until(() => first.phase === 'succeeded');
    f.settings.parser = 'mineru';
    const second = await engine.importPdf(samplePdf(), 'study.pdf'); await until(() => ['succeeded', 'failed'].includes(second.phase));
    expect(second.error).toBeUndefined(); expect(second.id).not.toBe(first.id); expect(selected).toEqual(['local', 'mineru']);
    expect(second.parsed).toContain('/mineru-v1/'); expect(first.parsed).toContain('/local-v1/');
    expect((await engine.importPdf(samplePdf(), 'study.pdf')).id).toBe(second.id); await engine.stop();
  });
  it('retries keep their original parser and switch to MinerU while the PDF is still stored', async () => {
    const f = fixture(); const selected: string[] = [];
    const engine = new TaskEngine({ ...f.deps, parser: async kind => { selected.push(kind); return { parse: async () => { if (kind === 'local') throw new Error('scan'); return { markdown: 'Parsed', assets: [], pages: [], parser: kind }; } }; } });
    await engine.start(); const original = await engine.importPdf(samplePdf(), 'study.pdf'); await until(() => original.phase === 'failed');
    f.settings.parser = 'mineru'; await engine.retry(original.id); await until(() => original.phase === 'failed');
    expect(original.settings.parser).toBe('local'); expect(await f.store.loadSource(original.hash)).not.toBeNull();
    const switched = await engine.reanalyze(original.id, 'mineru'); await until(() => ['succeeded', 'failed'].includes(switched.phase));
    expect(switched.error).toBeUndefined(); expect(selected).toEqual(['local', 'local', 'mineru']); await engine.stop();
  });
  it('asks for the PDF again when a new parser needs it after the PDF was released', async () => {
    const f = fixture(); await f.engine.start(); const first = await f.engine.importPdf(samplePdf(), 'study.pdf'); await until(() => first.phase === 'succeeded');
    const switched = await f.engine.reanalyze(first.id, 'mineru'); await until(() => switched.phase === 'failed');
    expect(switched.error).toContain('重新导入'); expect(f.runs).toBe(1); await f.engine.stop();
  });
  it('keeps the PDF while another job of the same PDF still needs it', async () => {
    const f = fixture(); f.engine.setPaused(true); await f.engine.start();
    const local = await f.engine.importPdf(samplePdf(), 'study.pdf'); f.settings.parser = 'mineru';
    const mineru = await f.engine.importPdf(samplePdf(), 'study.pdf'); f.engine.setPaused(false);
    await until(() => [local, mineru].every(j => ['succeeded', 'failed'].includes(j.phase)));
    expect([local.error, mineru.error]).toEqual([undefined, undefined]); expect(f.parses).toBe(2); expect(await f.store.loadSource(local.hash)).toBeNull(); await f.engine.stop();
  });
  it('does not silently run the local parser after a MinerU error', async () => {
    const f = fixture(); f.settings.parser = 'mineru'; const requested: string[] = [];
    const engine = new TaskEngine({ ...f.deps, parser: async kind => { requested.push(kind); return { parse: async () => { throw new Error('MinerU Token expired'); } }; } });
    await engine.start(); const j = await engine.importPdf(samplePdf(), 'study.pdf'); await until(() => j.phase === 'failed');
    expect(requested).toEqual(['mineru']); expect(j.error).toContain('Token expired'); expect(f.runs).toBe(0); await engine.stop();
  });
  it('uses the queued task secret selection rather than changed global settings', async () => {
    const f = fixture(); f.settings.parser = 'mineru'; const selected: string[] = [];
    const engine = new TaskEngine({ ...f.deps, parser: async (_kind, snapshot) => { selected.push(snapshot.mineruSecret); return { parse: async () => ({ markdown: 'Parsed', pages: [], assets: [], parser: 'fake' }) }; } });
    engine.setPaused(true); await engine.start(); const j = await engine.importPdf(samplePdf(), 'study.pdf'); f.settings.mineruSecret = 'different-account'; engine.setPaused(false);
    await until(() => ['succeeded', 'failed'].includes(j.phase)); expect(selected).toEqual(['paper-concepts-mineru']); await engine.stop();
  });
  it('reuses parsing but captures new prompts on reanalysis', async () => {
    const f = fixture(); await f.engine.start(); const first = await f.engine.importPdf(samplePdf(), 'study.pdf'); await until(() => first.phase === 'succeeded');
    f.settings.prompts.workflow += '\nA revised prompt.';
    const second = await f.engine.reanalyze(first.id); await until(() => second.phase === 'succeeded' || second.phase === 'failed');
    expect(second.error).toBeUndefined(); expect(f.parses).toBe(1); expect(f.runs).toBe(2); expect(second.promptHash).not.toBe(first.promptHash); await f.engine.stop();
  });
  it('regenerates once if knowledge changes during analysis', async () => {
    let count = 0; let f: ReturnType<typeof fixture>;
    f = fixture(async () => { if (count++ === 0) f.vault.files.set('Research/200-Concepts/Human.md', '---\ntype: concept\ntitle: Human\n---\nHuman knowledge'); return result(); });
    await f.engine.start(); const j = await f.engine.importPdf(samplePdf(), 'study.pdf'); await until(() => ['succeeded', 'failed'].includes(j.phase));
    expect(j.phase).toBe('succeeded'); expect(f.runs).toBe(2); expect(j.conflictRetries).toBe(1); await f.engine.stop();
  });
  it('stops after a second concurrent edit and preserves human content', async () => {
    let count = 0; let f: ReturnType<typeof fixture>;
    f = fixture(async () => { f.vault.files.set('Research/200-Concepts/Human.md', `---\ntype: concept\ntitle: Human\n---\nHuman ${count++}`); return result(); });
    await f.engine.start(); const j = await f.engine.importPdf(samplePdf(), 'study.pdf'); await until(() => j.phase === 'failed');
    expect(f.runs).toBe(2); expect(await f.vault.read('Research/200-Concepts/Human.md')).toContain('Human 1'); expect(j.paperPath).toBeUndefined(); await f.engine.stop();
  });
  it('keeps the parsed text when a harness fails', async () => {
    const f = fixture(async () => { throw new Error('not authenticated'); }); await f.engine.start(); const j = await f.engine.importPdf(samplePdf(), 'study.pdf'); await until(() => j.phase === 'failed');
    expect(await f.vault.exists(j.parsed)).toBe(true); expect(j.error).toContain('not authenticated'); await f.engine.stop();
  });
  it('removes the harness workspace when analysis fails', async () => {
    let cwd = ''; const f = fixture();
    const engine = new TaskEngine({ ...f.deps, harness: () => ({ run: async request => { cwd = request.cwd; throw new Error('not authenticated'); } }) });
    await engine.start(); const j = await engine.importPdf(samplePdf(), 'study.pdf'); await until(() => j.phase === 'failed');
    expect(cwd).not.toBe(''); expect(existsSync(cwd)).toBe(false); await engine.stop();
  });
  it('does not fall back to MinerU after a local parser failure', async () => {
    const f = fixture(); const requested: string[] = [];
    const engine = new TaskEngine({ ...f.deps, parser: async kind => { requested.push(kind); return { parse: async () => { throw new Error('scan'); } }; } });
    await engine.start(); const j = await engine.importPdf(samplePdf(), 'study.pdf'); await until(() => j.phase === 'failed'); expect(requested).toEqual(['local']); await engine.stop();
  });
  it('recovers partial writes without running the harness again', async () => {
    const f = fixture(); const save = f.store.saveJournal.bind(f.store); let calls = 0;
    f.store.saveJournal = async journal => { if (++calls === 2) throw new Error('simulated crash'); await save(journal); };
    await f.engine.start(); const j = await f.engine.importPdf(samplePdf(), 'study.pdf'); await until(() => j.phase === 'failed'); await f.engine.stop();
    const restarted = new TaskEngine(f.deps); await restarted.start(); await restarted.retry(j.id); const recovered = restarted.jobs.find(n => n.id === j.id)!;
    await until(() => ['succeeded', 'failed'].includes(recovered.phase)); expect(recovered.error).toBeUndefined(); expect(recovered.phase).toBe('succeeded'); expect(f.runs).toBe(1); await restarted.stop();
  });
  it('cancels active work and records shutdown as interrupted', async () => {
    const f = fixture(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })));
    await f.engine.start(); const j = await f.engine.importPdf(samplePdf(), 'study.pdf'); await until(() => j.phase === 'generating'); await f.engine.stop(); expect(j.phase).toBe('interrupted');
  });
  it('does not execute old-root tasks after selecting another root', async () => {
    const f = fixture(); f.engine.setPaused(true); await f.engine.start(); const j = await f.engine.importPdf(samplePdf(), 'study.pdf'); f.settings.root = 'Other'; f.engine.setPaused(false);
    await new Promise(r => setTimeout(r, 20)); expect(j.phase).toBe('queued'); expect(f.runs).toBe(0); await f.engine.stop();
  });
});
describe('stable import detection', () => {
  it('requires three identical observations', () => { const t = new StabilityTracker(); expect(t.observe('x', 10, 1)).toBe('pending'); expect(t.observe('x', 10, 1)).toBe('pending'); expect(t.observe('x', 10, 1)).toBe('stable'); });
  it('resets on changes and times out after five minutes', () => { const t = new StabilityTracker(); t.observe('x', 10, 1, 0); expect(t.observe('x', 20, 2, 300001)).toBe('timeout'); });
});
