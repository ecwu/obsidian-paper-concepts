import { Plugin, Notice, FileSystemAdapter } from 'obsidian';
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Settings } from './types';
import { layoutOf, loadSettings, validateSettings, parsingSettings, SettingsPersistence } from './settings';
import { TaskEngine } from './engine';
import { InboxWatcher } from './inbox';
import { isPending } from './jobs';
import { FileRuntimeStore } from './runtime';
import { ObsidianVaultPort, obsidianHttp } from './obsidian-port';
import { LocalPdfParser } from './parsers';
import { MineruParser } from './mineru';
import { localPdfResources } from './pdf-resources';
import { CliHarness } from './harness';
import { PaperView, PaperSettingsTab, VIEW_TYPE } from './ui';
import { redact } from './util';

export default class PaperConceptsPlugin extends Plugin {
  settings: Settings = loadSettings();
  private settingsWrites = new SettingsPersistence(() => this.settings, next => this.saveData(next), next => {
    this.settings = next; this.engine?.refresh();
  });
  engine!: TaskEngine;
  port!: ObsidianVaultPort;
  runtime!: FileRuntimeStore;
  private pdfWorker?: Worker;
  private workerUrl?: string;
  private scanning = false;
  private inbox = new InboxWatcher();
  private loaded = false;
  readonly listeners = new Set<() => void>();
  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData() ?? {});
    this.port = new ObsidianVaultPort(this.app);
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const pluginDir = join(adapter.getBasePath(), this.manifest.dir!);
    this.runtime = new FileRuntimeStore(join(pluginDir, 'runtime'));
    this.engine = new TaskEngine({ vault: this.port, store: this.runtime, settings: () => this.settings,
      parser: async (kind, taskSettings) => {
        if (kind === 'mineru') return new MineruParser(obsidianHttp, this.app.secretStorage.getSecret(taskSettings.mineruSecret) ?? '');
        if (!this.pdfWorker) {
          const code = await readFile(join(pluginDir, 'pdf.worker.mjs'), 'utf8');
          this.workerUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          this.pdfWorker = new Worker(this.workerUrl, { type: 'module' });
          pdfjs.GlobalWorkerOptions.workerPort = this.pdfWorker;
        }
        return new LocalPdfParser(pdfjs, localPdfResources(join(pluginDir, 'pdf-resources')));
      },
      harness: job => new CliHarness(job.settings.provider, job.settings.executables[job.settings.provider]),
      onChange: () => { for (const listener of this.listeners) listener(); }
    });
    this.registerView(VIEW_TYPE, leaf => new PaperView(leaf, this));
    this.addSettingTab(new PaperSettingsTab(this.app, this));
    this.addRibbonIcon('book-open', 'Paper Concepts', () => { void this.openView(); });
    this.addCommand({ id: 'open', name: '打开论文知识库', callback: () => { void this.openView(); } });
    this.addCommand({ id: 'import-pdf', name: '导入 PDF', callback: () => { this.chooseFiles(); } });
    this.addCommand({ id: 'initialize', name: '初始化知识目录', callback: () => { void this.initialize().catch(e => this.report(e)); } });
    this.registerInterval(window.setInterval(() => { void this.scanInbox().catch(e => this.report(e)); }, 2000));
    this.app.workspace.onLayoutReady(() => { void this.engine.start().then(() => { this.loaded = true; }).catch(e => this.report(e)); });
    this.registerEvent(this.app.vault.on('rename', () => { this.inbox.forgetReported(); }));
  }
  onunload(): void {
    void this.engine?.stop().finally(() => {
      this.pdfWorker?.terminate();
      if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    });
    this.listeners.clear();
  }
  async saveSettings(next: Settings): Promise<void> {
    await this.settingsWrites.update(() => {
      validateSettings(next);
      if (this.settings.root !== next.root && (this.engine.busy || this.engine.jobs.some(isPending))) throw new Error('请先等待或取消未完成任务，再更换知识目录');
      return next;
    });
  }
  async saveParsingSettings(preferences: Pick<Settings, 'parser' | 'mineruSecret'>): Promise<void> {
    await this.settingsWrites.update(current => parsingSettings(current, preferences));
  }
  async initialize(): Promise<void> { await this.engine.initializeFolders(); new Notice('Paper Concepts：知识目录已就绪'); }
  async openView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
  chooseFiles(): void {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.pdf,application/pdf'; input.multiple = true;
    input.addEventListener('change', () => { if (input.files) void this.importFiles([...input.files]); }, { once: true }); input.click();
  }
  async importFiles(files: File[]): Promise<void> {
    try {
      if (!this.loaded) throw new Error('正在恢复上次的任务，请稍后再导入');
      await this.settingsWrites.flush();
      await this.openView();
      const batch = await this.engine.importBatch(files.map(file => ({ name: file.name, read: async () => new Uint8Array(await file.arrayBuffer()) })));
      if (batch.errors.length) this.report(new Error(batch.errors.join('\n')));
    } catch (e) { this.report(e); }
  }
  report(error: unknown): void { new Notice('Paper Concepts：' + redact((error as Error).message ?? String(error)), 10_000); }
  private async scanInbox(): Promise<void> {
    if (!this.loaded || !this.settings.root || this.scanning || this.engine.paused) return;
    this.scanning = true;
    try {
      await this.settingsWrites.flush();
      const pdfs = this.app.vault.getFiles().filter(f => f.extension.toLowerCase() === 'pdf');
      const { ready, timedOut } = this.inbox.poll(layoutOf(this.settings).inbox, pdfs.map(f => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })));
      for (const path of timedOut) this.report(new Error(`${basename(path)} 在五分钟内未完成写入，文件保留在收件目录`));
      for (const path of ready) {
        // The PDF moves to the runtime store on import, so the inbox copy goes to the trash. Failed imports stay in the inbox.
        try { await this.engine.importPdf(await this.port.readBinary(path), basename(path)); await this.port.trash(path); } catch (e) { this.report(e); }
      }
    } finally { this.scanning = false; }
  }
}
