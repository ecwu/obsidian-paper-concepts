import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextSnapshot, HarnessAdapter, Job, ParserKind, PdfParser, RuntimeStore, Settings, VaultPort, WriteJournal } from './types';
import { hash, aborted, ConflictError, redact, SerialQueue } from './util';
import { layoutOf, validateSettings, type Layout } from './settings';
import { makePrompt } from './prompts';
import { ParseCache } from './parse-cache';
import { KnowledgeRepository, KnowledgeWriter } from './knowledge';
import { canRetry, isPending, wasInFlight } from './jobs';
import { activityDescriber, describeContext, describePlan, onceEach } from './activity';

export interface EngineDependencies {
  vault: VaultPort; store: RuntimeStore; settings: () => Settings;
  parser: (kind: ParserKind, settings: Settings) => Promise<PdfParser>;
  harness: (job: Job) => HarnessAdapter;
  onChange?: () => void;
}
export class TaskEngine {
  jobs: Job[] = [];
  paused = false;
  private stopped = false;
  private active?: { job: Job; controller: AbortController; promise: Promise<void> };
  /** Serializes job creation so concurrent imports of one PDF cannot both pass the duplicate check. */
  private imports = new SerialQueue();
  private writer: KnowledgeWriter;
  constructor(readonly deps: EngineDependencies) { this.writer = new KnowledgeWriter(deps.vault, deps.store); }
  get busy(): boolean { return !!this.active; }
  get activeJob(): Job | undefined { return this.active?.job; }
  async start(): Promise<void> {
    this.jobs = await this.deps.store.loadJobs();
    // Records from 0.1.0 have no `parsed` path; it is a pure function of the job's settings and PDF hash.
    for (const job of this.jobs) job.parsed ??= layoutOf(job.settings).parsedMarkdown(job.hash, job.settings.parser);
    for (const job of this.jobs.filter(wasInFlight)) {
      job.phase = 'interrupted'; this.log(job, '上次任务中断，将复用已保存的阶段'); await this.persist(job);
    }
    this.refresh();
  }
  setPaused(value: boolean): void { this.paused = value; this.refresh(); }
  /** Notifies listeners and starts the next job if the queue can run, e.g. after settings change. */
  refresh(): void { this.changed(); this.kick(); }
  async stop(): Promise<void> { this.stopped = true; this.active?.controller.abort(); await this.active?.promise; }
  /** Imports a PDF with the current settings. The same PDF with the same parser returns the existing job. */
  importPdf(bytes: Uint8Array, filename: string): Promise<Job> {
    return this.imports.run(() => this.importOne(bytes, filename));
  }
  async importBatch(files: { name: string; read: () => Promise<Uint8Array> }[]): Promise<{ jobs: Job[]; errors: string[] }> {
    const jobs: Job[] = [], errors: string[] = [];
    for (const file of files) {
      try { jobs.push(await this.importPdf(await file.read(), file.name)); }
      catch (error) { errors.push(`${file.name}：${redact((error as Error).message)}`); }
    }
    return { jobs, errors };
  }
  private async importOne(bytes: Uint8Array, filename: string): Promise<Job> {
    if (this.stopped) throw new Error('插件正在停止，请重新打开后导入');
    const settings = structuredClone(this.deps.settings());
    validateSettings(settings);
    if (!/\.pdf$/i.test(filename) || !new TextDecoder().decode(bytes.slice(0, 1024)).includes('%PDF-')) throw new Error('请选择有效的 PDF 文件');
    const sourceHash = hash(bytes);
    const duplicate = this.jobs.find(j => j.root === settings.root && j.hash === sourceHash && j.settings.parser === settings.parser);
    if (duplicate) return duplicate;
    await this.deps.store.saveSource(sourceHash, bytes);
    return this.createJob(settings, filename, sourceHash, 'PDF 已接收，等待处理');
  }
  /** Queues a job. Its PDF must be in the runtime store, or its parse must already exist. */
  private async createJob(settings: Settings, filename: string, sourceHash: string, message: string): Promise<Job> {
    const layout = layoutOf(settings);
    await this.createFolders(layout);
    const now = new Date().toISOString();
    const job: Job = { id: randomUUID(), root: settings.root, settings, filename, hash: sourceHash, parsed: layout.parsedMarkdown(sourceHash, settings.parser),
      phase: 'queued', created: now, updated: now, promptHash: hash(makePrompt(settings.prompts)), conflictRetries: 0, logs: [] };
    this.log(job, message); this.jobs.unshift(job); await this.persist(job); this.kick(); return job;
  }
  async initializeFolders(): Promise<void> {
    const settings = this.deps.settings();
    validateSettings(settings);
    await this.createFolders(layoutOf(settings));
  }
  private async createFolders(layout: Layout): Promise<void> {
    for (const dir of [layout.root, layout.inbox, layout.papers, layout.concepts, layout.assets]) await this.deps.vault.mkdir(dir);
  }
  async cancel(id: string): Promise<void> {
    const job = this.jobs.find(j => j.id === id); if (!job) return;
    if (job.id === this.active?.job.id) { this.active.controller.abort(); await this.active.promise; }
    else if (isPending(job)) { job.phase = 'cancelled'; await this.persist(job); }
  }
  async retry(id: string): Promise<void> {
    const job = this.jobs.find(j => j.id === id);
    if (!job || !canRetry(job)) return;
    if (job.root !== this.deps.settings().root) throw new Error('请先选择此任务所属的知识目录');
    job.error = undefined; job.phase = 'queued'; job.conflictRetries = 0; await this.persist(job); this.kick();
  }
  /** Queues a new job for the same PDF with the current settings, or with `parser` if given. */
  async reanalyze(id: string, parser?: ParserKind): Promise<Job> {
    const job = this.jobs.find(j => j.id === id); if (!job) throw new Error('任务不存在');
    const settings = structuredClone(this.deps.settings()); if (parser) settings.parser = parser;
    if (job.root !== settings.root) throw new Error('请先选择此任务所属的知识目录');
    validateSettings(settings);
    return this.imports.run(() => this.createJob(settings, job.filename, job.hash, '按当前设置重新分析'));
  }
  private kick(): void {
    if (this.active || this.paused || this.stopped) return;
    const root = this.deps.settings().root;
    const job = [...this.jobs].reverse().find(j => j.root === root && isPending(j));
    if (!job) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.process(job, controller.signal));
    this.active = { job, controller, promise };
    void promise.finally(() => { this.active = undefined; this.changed(); this.kick(); });
  }
  private changed(): void { this.deps.onChange?.(); }
  private log(job: Job, text: string): void { job.logs.push({ at: new Date().toISOString(), text: redact(text).slice(0, 2000) }); job.logs = job.logs.slice(-200); this.changed(); }
  private async persist(job: Job): Promise<void> { job.updated = new Date().toISOString(); await this.deps.store.saveJob(job); this.changed(); }
  private async phase(job: Job, phase: Job['phase'], message: string): Promise<void> { job.phase = phase; this.log(job, message); await this.persist(job); }

  /**
   * Runs a job to completion: resume a saved journal, or parse → generate → prepare a journal, then apply it.
   * If knowledge changes under the job before any file is written, the job regenerates once from fresh knowledge.
   */
  private async process(job: Job, signal: AbortSignal): Promise<void> {
    try {
      let journal = await this.resumableJournal(job);
      for (;;) {
        try {
          if (!journal) {
            journal = await this.generate(job, signal);
            await this.phase(job, 'writing', '保存论文与概念笔记');
          }
          await this.writer.apply(journal, signal);
          break;
        } catch (e) {
          if (!canRegenerate(e, job, journal, signal)) throw e;
          if (journal) await this.deps.store.discardJournal(job.id);
          journal = null; job.conflictRetries++;
          this.log(job, '笔记发生变化，基于最新版本重新生成一次'); await this.persist(job);
        }
      }
      job.paperPath = journal.paperPath; job.error = undefined;
      await this.phase(job, 'succeeded', '论文与概念已保存');
    } catch (e) {
      job.error = redact((e as Error).message ?? String(e));
      const phase = signal.aborted ? this.stopped ? 'interrupted' : 'cancelled' : 'failed';
      try { await this.phase(job, phase, job.error); } catch (persistError) { console.error('Paper Concepts could not save task state', redact(String(persistError))); }
    }
  }
  private async resumableJournal(job: Job): Promise<WriteJournal | null> {
    const journal = await this.deps.store.loadJournal(job.id);
    if (!journal) return null;
    if (journal.root !== job.root) throw new Error('写入记录与任务目录不一致');
    await this.phase(job, 'writing', '恢复尚未完成的笔记保存');
    return journal;
  }
  /** Parses (or reuses the parse), snapshots knowledge, runs the harness and plans the writes. */
  private async generate(job: Job, signal: AbortSignal): Promise<WriteJournal> {
    const layout = layoutOf(job.settings);
    await this.phase(job, 'parsing', job.settings.parser === 'local' ? '在本机提取 PDF 文字' : '使用 MinerU 解析 PDF');
    const log = (text: string) => this.log(job, text);
    const readSource = async () => {
      const bytes = await this.deps.store.loadSource(job.hash);
      if (!bytes) throw new Error('原始 PDF 已在解析成功后删除，且没有此解析器的解析正文。请重新导入该 PDF');
      return bytes;
    };
    const parse = async (bytes: Uint8Array) => (await this.deps.parser(job.settings.parser, job.settings)).parse(bytes, job.filename, signal, log);
    await new ParseCache(this.deps.vault, layout).ensure(job.hash, job.settings.parser, readSource, parse, signal, log);
    await this.releaseSource(job);
    aborted(signal);
    const repository = new KnowledgeRepository(this.deps.vault, layout);
    await this.phase(job, 'context', '准备论文与已有概念');
    const context = await repository.snapshot();
    this.log(job, describeContext(context));
    await this.phase(job, 'generating', `使用 ${job.settings.provider} 分析论文`);
    const prompt = makePrompt(job.settings.prompts);
    const describe = activityDescriber(context), report = onceEach(text => this.log(job, text));
    const model = job.settings.models[job.settings.provider], timeoutMs = job.settings.timeoutMinutes * 60_000;
    const result = await this.inWorkspace(job, context, prompt,
      cwd => this.deps.harness(job).run({ cwd, prompt, model, timeoutMs }, signal, e => report(e.kind === 'tool' ? describe(e.activity) : e.text)));
    await this.deps.store.saveResult(job.id, result); aborted(signal);
    await this.phase(job, 'validating', '检查结果、链接和知识版本');
    await repository.assertUnchanged(context);
    const journal = await this.writer.prepare(job, result, context);
    this.log(job, describePlan(journal));
    return journal;
  }
  /** Deletes the stored PDF once no other job of the same PDF may still need to parse it. */
  private async releaseSource(job: Job): Promise<void> {
    if (this.jobs.every(other => other === job || other.hash !== job.hash || other.phase === 'succeeded')) await this.deps.store.discardSource(job.hash);
  }
  /** Gives the harness a private temporary directory with the paper and knowledge copies; it is removed when `run` settles. */
  private async inWorkspace<T>(job: Job, context: ContextSnapshot, prompt: string, run: (cwd: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'paper-concepts-'));
    try {
      await mkdir(join(directory, 'knowledge'), { mode: 0o700 });
      await writeFile(join(directory, 'source.md'), await this.deps.vault.read(job.parsed), { mode: 0o600 });
      const catalog = [];
      for (const note of context.notes) {
        const path = 'knowledge/' + hash(note.id) + '.md';
        await writeFile(join(directory, path), note.content, { mode: 0o600 });
        catalog.push({ id: note.id, title: note.title, aliases: note.aliases, type: note.type, file: path,
          linkTarget: note.path.replace(/\.md$/, ''), isCurrentPaper: note.type === 'paper' && note.properties['pc-source'] === job.hash });
      }
      await writeFile(join(directory, 'catalog.json'), JSON.stringify(catalog, null, 2), { mode: 0o600 });
      await writeFile(join(directory, 'prompt.md'), prompt, { mode: 0o600 });
      return await run(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

/** A knowledge conflict triggers one regeneration, but only while no file of the journal has been written. */
function canRegenerate(error: unknown, job: Job, journal: WriteJournal | null, signal: AbortSignal): boolean {
  return error instanceof ConflictError && !signal.aborted && job.conflictRetries < 1 && !journal?.changes.some(change => change.done);
}
