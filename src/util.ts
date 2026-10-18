import { createHash } from 'node:crypto';

export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function relativePath(value: string): string {
  const path = value.replace(/\\/g, '/').replace(/\/$/, '');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\x00-\x1f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) {
    throw new Error('请使用仓库内的相对目录，不能包含隐藏目录或 ..');
  }
  return path;
}
export function within(path: string, root: string): boolean { return path === root || path.startsWith(root + '/'); }
export function inside(root: string, path: string): string {
  const normalized = relativePath(path);
  if (!within(normalized, relativePath(root))) throw new Error('目标路径超出指定知识目录');
  return normalized;
}
export function safeFilename(value: string): string {
  const cleaned = value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\[\]#^]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  if (!cleaned) throw new Error('无法生成有效的文件名');
  return [...cleaned].slice(0, 100).join('');
}
export const link = (path: string, label?: string): string => `[[${path.replace(/\.md$/i, '')}${label ? '|' + label.replace(/[\[\]|\r\n]/g, ' ') : ''}]]`;
export function redact(value: string): string {
  return value.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[REDACTED]@');
}
export const cancellation = (): DOMException => new DOMException('任务已取消', 'AbortError');
export function aborted(signal: AbortSignal): void { if (signal.aborted) throw cancellation(); }
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  aborted(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(finish, ms);
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(cancellation()); };
    signal.addEventListener('abort', stop, { once: true });
  });
}
export class ConflictError extends Error { constructor(message = '笔记在分析期间发生变化，任务需要重新生成') { super(message); this.name = 'ConflictError'; } }
