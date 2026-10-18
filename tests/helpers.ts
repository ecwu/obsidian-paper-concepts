import { randomUUID } from 'node:crypto';
import type { GenerationResult, Job, RuntimeStore, VaultPort, WriteJournal, Settings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/settings';
import { hash } from '../src/util';
import { syntheticPdf } from '../src/sample-pdf';

export class MemoryVault implements VaultPort {
  files = new Map<string, string | Uint8Array>();
  beforeProcess?: (path: string) => void;
  async list(): Promise<string[]> { return [...this.files.keys()].filter(p => p.endsWith('.md')); }
  async read(path: string): Promise<string> { const value = this.files.get(path); if (value === undefined) throw new Error('Missing ' + path); return typeof value === 'string' ? value : new TextDecoder().decode(value); }
  async readBinary(path: string): Promise<Uint8Array> { const value = this.files.get(path); if (value === undefined) throw new Error('Missing ' + path); return typeof value === 'string' ? new TextEncoder().encode(value) : value; }
  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async mkdir(_path: string): Promise<void> {}
  async create(path: string, text: string): Promise<void> { if (this.files.has(path)) throw new Error('Exists'); this.files.set(path, text); }
  async createBinary(path: string, bytes: Uint8Array): Promise<void> { if (this.files.has(path)) throw new Error('Exists'); this.files.set(path, bytes); }
  async process(path: string, fn: (v: string) => string): Promise<void> { this.beforeProcess?.(path); this.files.set(path, fn(await this.read(path))); }
}
export class MemoryStore implements RuntimeStore {
  jobs = new Map<string, Job>(); journals = new Map<string, WriteJournal>(); results = new Map<string, GenerationResult>();
  async saveJob(job: Job): Promise<void> { this.jobs.set(job.id, structuredClone(job)); }
  async loadJobs(): Promise<Job[]> { return structuredClone([...this.jobs.values()]); }
  async saveJournal(journal: WriteJournal): Promise<void> { this.journals.set(journal.jobId, structuredClone(journal)); }
  async loadJournal(id: string): Promise<WriteJournal | null> { return structuredClone(this.journals.get(id) ?? null); }
  async discardJournal(id: string): Promise<void> { this.journals.delete(id); }
  async saveResult(id: string, result: GenerationResult): Promise<void> { this.results.set(id, structuredClone(result)); }
  sources = new Map<string, Uint8Array>();
  async saveSource(hash: string, bytes: Uint8Array): Promise<void> { this.sources.set(hash, bytes.slice()); }
  async loadSource(hash: string): Promise<Uint8Array | null> { return this.sources.get(hash)?.slice() ?? null; }
  async discardSource(hash: string): Promise<void> { this.sources.delete(hash); }
}
export function settings(): Settings { return structuredClone({ ...DEFAULT_SETTINGS, root: 'Research' }); }
export function job(): Job { return { id: randomUUID(), root: 'Research', settings: settings(), filename: 'study.pdf', hash: hash('paper'), parsed: `Research/Assets/${hash('paper')}/parsed/local-v1/full.md`, phase: 'queued', created: new Date().toISOString(), updated: new Date().toISOString(), promptHash: 'prompt-v1', conflictRetries: 0, logs: [] }; }
export function result(): GenerationResult { return { paper: { title: 'Study', authors: ['A Researcher'], year: 2026, doi: null, arxiv: null, tags: ['test'], body: '## 摘要\n\nA paper about [[Attention]].\n\n## 方法\n\nA controlled experiment.' }, concepts: [{ existingId: null, title: 'Attention', aliases: ['Attn'], tags: [], body: '## 概述\n\nAttention weights information.\n\n## 重要论文\n\n[[Study]]' }] }; }
export function samplePdf(text = 'A controlled study of attention mechanisms. We compare two methods on a small benchmark and report limitations.'): Uint8Array {
  return syntheticPdf((text.match(/.{1,70}(?:\s|$)/g) ?? [text]).map(line => line.trim()));
}
export async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)); }
}
