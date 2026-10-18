import { PARSERS, PROVIDERS, type ParserKind, type Settings } from './types';
import { relativePath, SerialQueue, within } from './util';
import { DEFAULT_PROMPTS } from './prompts';

export const DEFAULT_SETTINGS: Settings = {
  root: '', inbox: '000-Inbox', papers: '100-Papers', concepts: '200-Concepts', assets: 'Assets',
  provider: 'codex', parser: 'local', executables: { codex: 'codex', claude: 'claude', opencode: 'opencode' },
  models: { codex: '', claude: '', opencode: '' }, timeoutMinutes: 30, mineruSecret: 'paper-concepts-mineru', prompts: DEFAULT_PROMPTS
};
export function loadSettings(saved: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS, ...saved,
    executables: { ...DEFAULT_SETTINGS.executables, ...saved.executables },
    models: { ...DEFAULT_SETTINGS.models, ...saved.models },
    prompts: { ...DEFAULT_PROMPTS, ...saved.prompts }
  };
}
export function validateSettings(s: Settings): void {
  relativePath(s.root);
  const dirs = [s.inbox, s.papers, s.concepts, s.assets].map(relativePath);
  if (dirs.some((a, i) => dirs.some((b, j) => i !== j && (within(a, b) || within(b, a))))) throw new Error('收件、论文、概念和附件目录必须互不包含');
  if (!PROVIDERS.includes(s.provider) || !PARSERS.includes(s.parser)) throw new Error('请选择支持的 Harness 和解析器');
  if (!Number.isFinite(s.timeoutMinutes) || s.timeoutMinutes < 1 || s.timeoutMinutes > 180) throw new Error('超时须为 1 到 180 分钟');
  if (!s.executables[s.provider].trim()) throw new Error('请指定 Harness 程序路径');
}

/** Serializes writes so rapid changes cannot restore an older selection. */
export class SettingsPersistence {
  private queue = new SerialQueue();
  constructor(private read: () => Settings, private write: (next: Settings) => Promise<void>, private apply: (next: Settings) => void) {}
  update(change: (current: Settings) => Settings): Promise<void> {
    return this.queue.run(async () => {
      const next = structuredClone(change(this.read()));
      await this.write(next); this.apply(next);
    });
  }
  flush(): Promise<void> { return this.queue.idle(); }
}
export function parsingSettings(current: Settings, preferences: Pick<Settings, 'parser' | 'mineruSecret'>): Settings {
  if (!PARSERS.includes(preferences.parser)) throw new Error('请选择支持的 PDF 解析器');
  return { ...current, parser: preferences.parser, mineruSecret: preferences.mineruSecret.trim() };
}

/** The vault paths a knowledge folder occupies. The only place folder paths are joined. */
export interface Layout {
  root: string; inbox: string; papers: string; concepts: string; assets: string;
  /** Folders whose notes are materials, not knowledge. */
  excluded: string[];
  /** Folder of one parse of one PDF: the Markdown, its images, and metadata. */
  parsedDir(hash: string, parser: ParserKind): string;
  parsedMarkdown(hash: string, parser: ParserKind): string;
}
export function layoutOf(s: Pick<Settings, 'root' | 'inbox' | 'papers' | 'concepts' | 'assets'>): Layout {
  const at = (folder: string) => `${s.root}/${folder}`;
  const assets = at(s.assets), inbox = at(s.inbox);
  return {
    root: s.root, inbox, papers: at(s.papers), concepts: at(s.concepts), assets,
    excluded: [assets, inbox],
    parsedDir: (hash, parser) => `${assets}/${hash}/parsed/${parser}-v1`,
    parsedMarkdown: (hash, parser) => `${assets}/${hash}/parsed/${parser}-v1/full.md`
  };
}
