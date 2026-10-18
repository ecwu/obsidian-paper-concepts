import { within } from './util';

export class StabilityTracker {
  private observed = new Map<string, { signature: string; count: number; first: number }>();
  observe(path: string, size: number, mtime: number, now = Date.now()): 'pending' | 'stable' | 'timeout' {
    const signature = `${size}:${mtime}`, old = this.observed.get(path);
    const entry = old ? { ...old, signature, count: old.signature === signature ? old.count + 1 : 1 } : { signature, count: 1, first: now };
    this.observed.set(path, entry);
    if (entry.count >= 3) return 'stable';
    return now - entry.first >= 300_000 ? 'timeout' : 'pending';
  }
  forget(path: string): void { this.observed.delete(path); }
}

export interface InboxFile { path: string; size: number; mtime: number }

/** Decides which inbox files have finished being written. Each file version is reported once. */
export class InboxWatcher {
  private tracker = new StabilityTracker();
  /** Signature of the last reported version of each file. */
  private reported = new Map<string, string>();
  private folder = '';

  poll(folder: string, files: InboxFile[]): { ready: string[]; timedOut: string[] } {
    if (folder !== this.folder) { this.reset(); this.folder = folder; }
    const inbox = files.filter(file => within(file.path, folder));
    const present = new Set(inbox.map(file => file.path));
    for (const path of this.reported.keys()) if (!present.has(path)) { this.reported.delete(path); this.tracker.forget(path); }
    const ready: string[] = [], timedOut: string[] = [];
    for (const file of inbox) {
      const signature = `${file.size}:${file.mtime}`;
      if (this.reported.get(file.path) === signature) continue;
      const state = this.tracker.observe(file.path, file.size, file.mtime);
      if (state === 'pending') continue;
      this.reported.set(file.path, signature); this.tracker.forget(file.path);
      (state === 'stable' ? ready : timedOut).push(file.path);
    }
    return { ready, timedOut };
  }
  /** Forgets reported files, e.g. after a rename, so they are considered again. */
  forgetReported(): void { this.reported.clear(); }
  private reset(): void { this.reported.clear(); this.tracker = new StabilityTracker(); }
}
