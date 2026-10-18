import { mkdir, readFile, rename, writeFile, readdir, open, realpath, lstat, unlink, rm } from 'node:fs/promises';
import { join, resolve, sep, dirname, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GenerationResult, Job, RuntimeStore, WriteJournal } from './types';

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
const JOB_ID = /^[a-f0-9-]{36}$/, SOURCE_HASH = /^[a-f0-9]{64}$/;
export class FileRuntimeStore implements RuntimeStore {
  constructor(readonly directory: string) {}
  path(id: string, file: string): string {
    if (!JOB_ID.test(id)) throw new Error('任务标识无效');
    return join(this.directory, 'jobs', id, file);
  }
  saveJob(job: Job): Promise<void> { return atomicJson(this.path(job.id, 'job.json'), job); }
  async loadJobs(): Promise<Job[]> {
    let entries: string[];
    try { entries = await readdir(join(this.directory, 'jobs')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const jobs: Job[] = [];
    for (const id of entries) {
      if (!JOB_ID.test(id)) continue;
      const job = JSON.parse(await readFile(this.path(id, 'job.json'), 'utf8')) as Job;
      if (job.id !== id || !job.root || !job.settings || !Array.isArray(job.logs)) throw new Error(`任务记录损坏：${id}`);
      jobs.push(job);
    }
    return jobs.sort((a, b) => b.created.localeCompare(a.created));
  }
  saveJournal(journal: WriteJournal): Promise<void> { return atomicJson(this.path(journal.jobId, 'journal.json'), journal); }
  async discardJournal(id: string): Promise<void> { await unlink(this.path(id, 'journal.json')); }
  async loadJournal(id: string): Promise<WriteJournal | null> {
    try {
      const journal = JSON.parse(await readFile(this.path(id, 'journal.json'), 'utf8')) as WriteJournal;
      if (journal.version !== 1 || journal.jobId !== id || !Array.isArray(journal.changes)) throw new Error('写入记录损坏');
      return journal;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  saveResult(id: string, result: GenerationResult): Promise<void> { return atomicJson(this.path(id, 'result.json'), result); }
  async saveSource(hash: string, bytes: Uint8Array): Promise<void> {
    const path = this.sourcePath(hash), temporary = path + '.' + randomUUID() + '.tmp';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
  async loadSource(hash: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(await readFile(this.sourcePath(hash))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async discardSource(hash: string): Promise<void> { await rm(this.sourcePath(hash), { force: true }); }
  private sourcePath(hash: string): string {
    if (!SOURCE_HASH.test(hash)) throw new Error('PDF 标识无效');
    return join(this.directory, 'sources', hash + '.pdf');
  }
}

export async function assertDiskBoundary(base: string, target: string): Promise<void> {
  const root = await realpath(base), offset = relative(resolve(base), resolve(target));
  if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) throw new Error('路径超出仓库');
  const absolute = resolve(root, offset);
  let current = absolute;
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('知识写入路径不能经过符号链接');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) throw new Error('无法确定仓库边界');
    current = parent;
  }
}
