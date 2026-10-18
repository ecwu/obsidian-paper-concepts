import type { VaultPort } from './types';
import { inside, within } from './util';

/** A view of the vault confined to one knowledge folder. Every path is checked here, so callers do not repeat boundary checks. */
export function scopedVault(vault: VaultPort, root: string): VaultPort {
  const check = (path: string) => inside(root, path);
  return {
    list: async () => (await vault.list()).filter(path => within(path, root)),
    read: path => vault.read(check(path)),
    readBinary: path => vault.readBinary(check(path)),
    exists: path => vault.exists(check(path)),
    mkdir: path => vault.mkdir(check(path)),
    create: (path, content) => vault.create(check(path), content),
    createBinary: (path, bytes) => vault.createBinary(check(path), bytes),
    process: (path, fn) => vault.process(check(path), fn)
  };
}
