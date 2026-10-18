import type { ParsedPaper, PdfParser } from './types';
import { aborted } from './util';

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
