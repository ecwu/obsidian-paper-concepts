export const PROVIDERS = ['codex', 'claude', 'opencode'] as const;
export type Provider = typeof PROVIDERS[number];
export const PARSERS = ['local', 'mineru'] as const;
export type ParserKind = typeof PARSERS[number];
export type Phase = 'queued' | 'parsing' | 'context' | 'generating' | 'validating' | 'writing' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface Prompts { workflow: string; paper: string; concept: string; writing: string }
export interface Settings {
  root: string; inbox: string; papers: string; concepts: string; assets: string;
  provider: Provider; parser: ParserKind; executables: Record<Provider, string>;
  models: Record<Provider, string>; timeoutMinutes: number; mineruSecret: string;
  prompts: Prompts;
}
export interface Attachment { path: string; bytes: Uint8Array }
export interface ParsedPaper { markdown: string; assets: Attachment[]; pages: { page: number; start: number }[]; parser: string }
export interface Job {
  id: string; root: string; settings: Settings; filename: string; hash: string;
  source: string; parsed?: string; phase: Phase;
  created: string; updated: string; error?: string; paperPath?: string;
  promptHash: string; conflictRetries: number; logs: { at: string; text: string }[];
}
export interface NoteSnapshot { id: string; path: string; title: string; aliases: string[]; type: 'paper' | 'concept'; content: string; hash: string; properties: Record<string, unknown> }
export interface ContextSnapshot { notes: NoteSnapshot[]; digest: string }
export interface GeneratedPaper {
  title: string; authors: string[]; year: number | null; doi: string | null;
  arxiv: string | null; tags: string[]; body: string;
}
export interface GeneratedConcept { existingId: string | null; title: string; aliases: string[]; tags: string[]; body: string }
export interface GenerationResult { paper: GeneratedPaper; concepts: GeneratedConcept[] }
export interface HarnessEvent { kind: 'message' | 'tool' | 'error' | 'complete'; text: string }
export interface HarnessRequest { cwd: string; prompt: string; model: string; timeoutMs: number }
/** Runs one analysis. Implementations validate the answer, so callers receive a trusted result. */
export interface HarnessAdapter {
  run(request: HarnessRequest, signal: AbortSignal, onEvent: (event: HarnessEvent) => void): Promise<GenerationResult>;
}
export interface PdfParser { parse(bytes: Uint8Array, filename: string, signal: AbortSignal): Promise<ParsedPaper> }
export interface VaultPort {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  createBinary(path: string, bytes: Uint8Array): Promise<void>;
  process(path: string, fn: (current: string) => string): Promise<void>;
}
export interface FileChange { path: string; before: string | null; after: string; done: boolean }
export interface WriteJournal { version: 1; jobId: string; root: string; paperPath: string; changes: FileChange[]; complete: boolean }
export interface RuntimeStore {
  saveJob(job: Job): Promise<void>; loadJobs(): Promise<Job[]>;
  saveJournal(journal: WriteJournal): Promise<void>; loadJournal(id: string): Promise<WriteJournal | null>;
  discardJournal(id: string): Promise<void>;
  saveResult(id: string, result: GenerationResult): Promise<void>;
}
