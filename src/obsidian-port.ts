import { App, TFile, TFolder, FileSystemAdapter, requestUrl } from 'obsidian';
import { join } from 'node:path';
import type { HttpClient, VaultPort } from './types';
import { assertDiskBoundary } from './runtime';
import { aborted, cancellation, relativePath } from './util';

export class ObsidianVaultPort implements VaultPort {
  private base: string;
  constructor(private app: App) {
    if (!(app.vault.adapter instanceof FileSystemAdapter)) throw new Error('Paper Concepts 需要 Obsidian 桌面端的本地仓库');
    this.base = app.vault.adapter.getBasePath();
  }
  private async guard(path: string): Promise<void> { relativePath(path); await assertDiskBoundary(this.base, join(this.base, path)); }
  async list(): Promise<string[]> { return this.app.vault.getMarkdownFiles().map(f => f.path); }
  private file(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`文件不存在或不是普通文件：${path}`);
    return file;
  }
  async read(path: string): Promise<string> { await this.guard(path); return this.app.vault.read(this.file(path)); }
  async readBinary(path: string): Promise<Uint8Array> { await this.guard(path); return new Uint8Array(await this.app.vault.readBinary(this.file(path))); }
  async exists(path: string): Promise<boolean> { await this.guard(path); return this.app.vault.adapter.exists(path); }
  async mkdir(path: string): Promise<void> {
    await this.guard(path);
    let current = '';
    for (const part of path.split('/')) {
      current = current ? current + '/' + part : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing && !(existing instanceof TFolder)) throw new Error(`目录位置存在文件：${current}`);
      if (!existing) {
        try { await this.app.vault.createFolder(current); }
        catch (e) { if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw e; }
      }
    }
  }
  async create(path: string, content: string): Promise<void> { await this.guard(path); await this.app.vault.create(path, content); }
  async createBinary(path: string, bytes: Uint8Array): Promise<void> { await this.guard(path); await this.app.vault.createBinary(path, bytes.slice().buffer as ArrayBuffer); }
  async process(path: string, fn: (current: string) => string): Promise<void> { await this.guard(path); await this.app.vault.process(this.file(path), fn); }
  /** Moves a file to the trash the user selected in Obsidian, so it stays recoverable. Not part of VaultPort: only inbox handling uses it. */
  async trash(path: string): Promise<void> { await this.guard(path); await this.app.fileManager.trashFile(this.file(path)); }
}
export const obsidianHttp: HttpClient = async (url, method, headers, body, signal) => {
  aborted(signal);
  const response = await new Promise<Awaited<ReturnType<typeof requestUrl>>>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    const stop = () => { finish(); reject(cancellation()); };
    const timer = setTimeout(() => { finish(); reject(new Error('网络请求超时，请重试')); }, 120_000);
    signal.addEventListener('abort', stop, { once: true });
    const payload = body instanceof Uint8Array ? body.slice().buffer as ArrayBuffer : body;
    void requestUrl({ url, method, headers, body: payload, throw: false })
      .then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
  });
  aborted(signal);
  return { status: response.status, bytes: new Uint8Array(response.arrayBuffer) };
};
