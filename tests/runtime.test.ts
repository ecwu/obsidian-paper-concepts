import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRuntimeStore, assertDiskBoundary } from '../src/runtime';
import { job } from './helpers';
import { hash } from '../src/util';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
it('persists and reloads versioned job data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-store-')); dirs.push(dir); const store = new FileRuntimeStore(dir), j = job();
  await store.saveJob(j); expect(await store.loadJobs()).toEqual([j]); expect(await store.loadJournal(j.id)).toBeNull();
});
it('rejects symlinks that escape the vault', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-path-')); dirs.push(dir); await mkdir(join(dir, 'vault')); await mkdir(join(dir, 'outside')); await symlink(join(dir, 'outside'), join(dir, 'vault/link'));
  await expect(assertDiskBoundary(join(dir, 'vault'), join(dir, 'vault/link/note.md'))).rejects.toThrow('符号链接');
  await expect(assertDiskBoundary(join(dir, 'vault'), join(dir, 'outside/note.md'))).rejects.toThrow('超出');
});
it('keeps an imported PDF outside the vault until it is discarded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-source-')); dirs.push(dir); const store = new FileRuntimeStore(dir), pdf = new Uint8Array([37, 80, 68, 70]), id = hash(pdf);
  expect(await store.loadSource(id)).toBeNull();
  await store.saveSource(id, pdf); expect(await store.loadSource(id)).toEqual(pdf);
  await store.discardSource(id); expect(await store.loadSource(id)).toBeNull();
  await expect(store.saveSource('../escape', pdf)).rejects.toThrow('PDF 标识无效');
});
