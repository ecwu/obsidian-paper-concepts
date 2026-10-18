import { posix } from 'node:path';
import type { ContextSnapshot, NoteSnapshot, ToolActivity, WriteJournal } from './types';
import { hash } from './util';

/** Reduces a path the harness used to a task-directory file: `source.md`, `catalog.json`, `knowledge/<id>.md`, or the bare name. */
export function taskFile(path: string): string {
  const match = /(?:^|\/)(knowledge\/[^/\s'"]+\.md|source\.md|catalog\.json|prompt\.md|schema\.json)$/.exec(path.trim());
  return match ? match[1]! : posix.basename(path.trim());
}
/** A line range from a reader tool's offset and limit, as "a–b". */
export function lineRange(offset: unknown, limit: unknown): string | undefined {
  if (typeof offset !== 'number' && typeof limit !== 'number') return undefined;
  const start = typeof offset === 'number' ? Math.max(offset, 1) : 1;
  return typeof limit === 'number' ? `${start}–${start + limit - 1}` : `${start}–`;
}

const TASK_FILE = /(knowledge\/[\w.-]+\.md|source\.md|catalog\.json)/;
const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'ag']);
const LISTERS = new Set(['ls', 'find', 'tree', 'fd']);
const FLAGS_WITH_VALUE = new Set(['-g', '--glob', '-m', '--max-count', '-A', '-B', '-C', '-t', '--type', '-f']);

/** Splits a shell command into words, honoring single and double quotes. Enough for the read-only commands harnesses run. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  for (const m of command.matchAll(/'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g)) words.push(m[1] ?? m[2]?.replace(/\\(.)/g, '$1') ?? m[3]!);
  return words;
}
/** Interprets a shell command run by Codex. Returns undefined for commands that say nothing useful about progress. */
export function shellActivity(command: string): ToolActivity | undefined {
  const inner = /-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command)?.[2] ?? command;
  const first = shellWords(inner.split(/\||&&|;/)[0] ?? '');
  const program = posix.basename(first[0] ?? '');
  const file = TASK_FILE.exec(inner)?.[1];
  if (SEARCHERS.has(program) && !first.includes('--files')) {
    const explicit = first.indexOf('-e');
    const operands = first.slice(1).filter((word, i, all) => !word.startsWith('-') && !FLAGS_WITH_VALUE.has(all[i - 1] ?? ''));
    const pattern = explicit >= 0 ? first[explicit + 1] : operands[0];
    return pattern ? { action: 'search', target: file ?? operands[1] ?? '', detail: pattern } : undefined;
  }
  if (LISTERS.has(program) || first.includes('--files')) return { action: 'list', target: file ?? '' };
  if (!file) return undefined;
  const range = /(\d+),(\d+)p/.exec(inner);
  return { action: 'read', target: file, detail: range ? `${range[1]}–${range[2]}` : undefined };
}

/** Turns tool activity into a log line. The snapshot names the knowledge files, which are hashed in the task directory. */
export function activityDescriber(context: ContextSnapshot): (activity: ToolActivity) => string | undefined {
  const notes = new Map<string, NoteSnapshot>(context.notes.map(note => [`knowledge/${hash(note.id)}.md`, note]));
  const lines = (detail?: string) => detail ? `（第 ${detail} 行）` : '';
  return ({ action, target, detail }) => {
    const note = notes.get(target);
    if (action === 'read') {
      if (target === 'source.md') return `阅读论文正文${lines(detail)}`;
      if (target === 'catalog.json') return `查看知识目录（${context.notes.length} 个已有页面）`;
      if (note) return `参考已有${note.type === 'paper' ? '论文' : '概念'}：${note.title}`;
      return undefined;
    }
    if (action === 'search') {
      const scope = target === 'source.md' ? '在论文正文中' : target.startsWith('knowledge') || target === '' ? '在已有知识中' : '';
      return `${scope}检索“${detail}”`;
    }
    return '浏览已有知识文件';
  };
}

/** Logs each distinct line once per run, so repeated tool calls do not flood the log. */
export function onceEach(log: (text: string) => void): (text: string | undefined) => void {
  const seen = new Set<string>();
  return text => { if (text && !seen.has(text)) { seen.add(text); log(text); } };
}

export function describeContext(context: ContextSnapshot): string {
  const papers = context.notes.filter(note => note.type === 'paper').length;
  return `已有知识：${papers} 篇论文，${context.notes.length - papers} 个概念`;
}

/** Summarizes what a journal will write: whether the paper is new, and which concepts are created or updated. */
export function describePlan(journal: WriteJournal): string {
  const title = (path: string) => posix.basename(path, '.md');
  const paper = journal.changes.find(change => change.path === journal.paperPath);
  const concepts = journal.changes.filter(change => change !== paper);
  const created = concepts.filter(change => change.before === null).map(change => title(change.path));
  const updated = concepts.filter(change => change.before !== null).map(change => title(change.path));
  const parts = [`${paper?.before === null ? '新建' : '更新'}论文《${title(journal.paperPath)}》`];
  if (created.length) parts.push(`新建概念：${created.join('、')}`);
  if (updated.length) parts.push(`更新概念：${updated.join('、')}`);
  if (!concepts.length) parts.push('没有需要新建或更新的概念');
  return parts.join('；');
}
