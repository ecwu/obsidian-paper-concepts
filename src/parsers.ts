import { unzipSync } from 'fflate';
import type { ParsedPaper, PdfParser } from './types';
import { aborted, delay } from './util';

export type PdfRuntime = Pick<typeof import('pdfjs-dist/legacy/build/pdf.mjs'), 'getDocument' | 'version'>;
export class LocalPdfParser implements PdfParser {
  constructor(private runtime: PdfRuntime, private resources: Partial<import('pdfjs-dist/types/src/display/api').DocumentInitParameters> = {}) {}
  async parse(bytes: Uint8Array, _filename: string, signal: AbortSignal): Promise<ParsedPaper> {
    aborted(signal);
    const task = this.runtime.getDocument({ ...this.resources, data: bytes.slice() });
    const stop = () => { void task.destroy(); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const doc = await task.promise;
      const sections: string[] = [], pages: ParsedPaper['pages'] = [];
      let offset = 0, characters = 0;
      for (let page = 1; page <= doc.numPages; page++) {
        aborted(signal);
        const pdfPage = await doc.getPage(page), text = await pdfPage.getTextContent();
        let body = '';
        for (const item of text.items) if ('str' in item) body += item.str + (item.hasEOL ? '\n' : ' ');
        characters += body.replace(/\s/g, '').length;
        const section = `## 第 ${page} 页\n\n${body.trim()}\n`;
        pages.push({ page, start: offset }); sections.push(section); offset += section.length + 1;
        pdfPage.cleanup();
      }
      if (characters < Math.max(40, doc.numPages * 10)) throw new Error('PDF 可提取文字不足，可能是扫描件。请选择 MinerU 后重新解析。');
      return { markdown: sections.join('\n'), pages, assets: [], parser: 'pdfjs-' + this.runtime.version };
    } catch (e) { aborted(signal); throw new Error(`本地 PDF 解析失败：${(e as Error).message}`); }
    finally { signal.removeEventListener('abort', stop); await task.destroy(); }
  }
}
export interface HttpResponse { status: number; bytes: Uint8Array }
export type HttpClient = (url: string, method: string, headers: Record<string, string>, body: string | Uint8Array | undefined, signal: AbortSignal) => Promise<HttpResponse>;
export function extractMineru(bytes: Uint8Array): ParsedPaper {
  let declaredSize = 0;
  const files = unzipSync(bytes, { filter: entry => {
    declaredSize += entry.originalSize;
    if (entry.originalSize > 100_000_000) throw new Error('MinerU 结果中的单个文件过大');
    if (declaredSize > 250_000_000) throw new Error('MinerU 解析结果过大');
    return true;
  } });
  let total = 0;
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.')) throw new Error('MinerU 返回了不安全的附件路径');
    total += data.length;
    if (total > 250_000_000) throw new Error('MinerU 解析结果过大');
  }
  const markdownName = Object.keys(files).find(n => /(^|\/)full\.md$/.test(n));
  if (!markdownName) throw new Error('MinerU 结果没有 full.md');
  const base = markdownName.slice(0, -'full.md'.length);
  const markdown = new TextDecoder().decode(files[markdownName]);
  if (!markdown.trim()) throw new Error('MinerU 没有提取到正文');
  const assets = Object.entries(files).filter(([name]) => name.startsWith(base) && /\.(png|jpe?g|webp|gif|svg)$/i.test(name)).map(([name, bytes]) => ({ path: name.slice(base.length), bytes }));
  return { markdown, assets, pages: [], parser: 'mineru-v4-vlm' };
}
/** MinerU response payloads as received. Fields are unverified until checked at use. */
interface MineruBatch { batch_id?: unknown; file_urls?: unknown[] }
interface MineruResults { extract_result?: { state?: unknown; err_msg?: unknown; full_zip_url?: unknown }[] }
export class MineruParser implements PdfParser {
  constructor(private http: HttpClient, private token: string, private pollMs = 3000, private timeoutMs = 30 * 60_000) {}
  async parse(bytes: Uint8Array, filename: string, signal: AbortSignal): Promise<ParsedPaper> {
    if (!this.token) throw new Error('请在设置中选择已保存的 MinerU Token');
    if (bytes.length > 200 * 1024 * 1024) throw new Error('MinerU 首版支持不超过 200 MB 的 PDF');
    const headers = { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
    const json = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      aborted(signal);
      const response = await this.http('https://mineru.net/api/v4/' + path, method, headers, body === undefined ? undefined : JSON.stringify(body), signal);
      if (response.status < 200 || response.status >= 300) throw new Error(`MinerU 请求失败 (${response.status})`);
      const value = JSON.parse(new TextDecoder().decode(response.bytes)) as { code?: unknown; msg?: unknown; data?: T };
      if (value.code !== 0) throw new Error(`MinerU：${value.msg ?? '请求失败'}`);
      return value.data ?? ({} as T);
    };
    const batch = await json<MineruBatch>('file-urls/batch', 'POST', { files: [{ name: filename, data_id: 'paper-concepts' }], model_version: 'vlm', enable_table: true, enable_formula: true });
    const upload = batch.file_urls?.[0], batchId = batch.batch_id;
    if (typeof upload !== 'string' || !upload.startsWith('https://') || typeof batchId !== 'string') throw new Error('MinerU 上传响应无效');
    const uploaded = await this.http(upload, 'PUT', {}, bytes, signal);
    if (uploaded.status < 200 || uploaded.status >= 300) throw new Error('MinerU PDF 上传失败');
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const data = await json<MineruResults>('extract-results/batch/' + encodeURIComponent(batchId));
      const result = data.extract_result?.[0];
      if (result?.state === 'failed') throw new Error(`MinerU 解析失败：${result.err_msg ?? '未知错误'}`);
      if (result?.state === 'done') {
        if (typeof result.full_zip_url !== 'string' || !result.full_zip_url.startsWith('https://')) throw new Error('MinerU 下载链接无效');
        const response = await this.http(result.full_zip_url, 'GET', {}, undefined, signal);
        if (response.status !== 200) throw new Error('MinerU 结果下载失败');
        return extractMineru(response.bytes);
      }
      await delay(this.pollMs, signal);
    }
    throw new Error('MinerU 解析超时，原始 PDF 已保留');
  }
}
