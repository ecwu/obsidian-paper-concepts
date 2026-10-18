import { describe, it, expect } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { zipSync, strToU8 } from 'fflate';
import { LocalPdfParser, MineruParser, extractMineru, type HttpClient } from '../src/parsers';
import { samplePdf } from './helpers';
import { localPdfResources } from '../src/pdf-resources';
import { resolve } from 'node:path';

describe('local PDF parser', () => {
  it('reads bundled font and CMap resources without network access', async () => {
    const options = localPdfResources(resolve('node_modules/pdfjs-dist'));
    const factory = new options.BinaryDataFactory();
    expect((await factory.fetch({ kind: 'cMapUrl', filename: 'UniJIS-UTF16-H.bcmap' })).length).toBeGreaterThan(0);
    expect((await factory.fetch({ kind: 'standardFontDataUrl', filename: 'LiberationSans-Regular.ttf' })).length).toBeGreaterThan(0);
    const parsed = await new LocalPdfParser(pdfjs, options).parse(samplePdf(), 'study.pdf', new AbortController().signal);
    expect(parsed.markdown).toContain('limitations.');
    await expect(factory.fetch({ kind: 'cMapUrl', filename: '../LICENSE' })).rejects.toThrow('无效');
    await expect(factory.fetch({ kind: 'http', filename: 'secret' })).rejects.toThrow('无效');
  });
  it('extracts actual PDF text and page offsets without network requests', async () => {
    const parsed = await new LocalPdfParser(pdfjs).parse(samplePdf(), 'study.pdf', new AbortController().signal);
    expect(parsed.markdown).toContain('attention mechanisms'); expect(parsed.markdown).toContain('limitations.'); expect(parsed.pages).toEqual([{ page: 1, start: 0 }]);
  });
  it('reports scans or empty PDFs rather than producing invented analysis', async () => {
    await expect(new LocalPdfParser(pdfjs).parse(samplePdf(''), 'scan.pdf', new AbortController().signal)).rejects.toThrow('MinerU');
  });
  it('honors cancellation', async () => { const c = new AbortController(); c.abort(); await expect(new LocalPdfParser(pdfjs).parse(samplePdf(), 'study.pdf', c.signal)).rejects.toThrow(); });
});
describe('MinerU', () => {
  const archive = () => zipSync({ 'paper/full.md': strToU8('# Parsed paper\n\nText and ![](images/one.png)'), 'paper/images/one.png': new Uint8Array([1, 2]) });
  const response = (data: unknown) => ({ status: 200, bytes: strToU8(JSON.stringify({ code: 0, data })) });
  it('uploads, polls and downloads while keeping tokens off upload and download requests', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const http: HttpClient = async (url, _method, headers) => {
      calls.push({ url, headers });
      if (url.endsWith('file-urls/batch')) return response({ batch_id: 'batch', file_urls: ['https://upload.example/pdf'] });
      if (url.startsWith('https://upload.')) return { status: 200, bytes: new Uint8Array() };
      if (url.includes('extract-results')) return response({ extract_result: [{ state: 'done', full_zip_url: 'https://download.example/result' }] });
      return { status: 200, bytes: archive() };
    };
    const parsed = await new MineruParser(http, 'secret', 1).parse(samplePdf(), 'study.pdf', new AbortController().signal);
    expect(parsed.assets[0]!.path).toBe('images/one.png');
    expect(calls.filter(c => !c.url.startsWith('https://mineru.net')).every(c => !c.headers.Authorization)).toBe(true);
  });
  it('fails before uploading if no token exists', async () => { let calls = 0; const http: HttpClient = async () => { calls++; return response({}); }; await expect(new MineruParser(http, '').parse(samplePdf(), 'x.pdf', new AbortController().signal)).rejects.toThrow('Token'); expect(calls).toBe(0); });
  it('rejects missing Markdown', () => { expect(() => extractMineru(zipSync({ 'other.txt': strToU8('x') }))).toThrow('full.md'); });
  it('rejects archive traversal paths', () => { expect(() => extractMineru(zipSync({ '../full.md': strToU8('danger') }))).toThrow('不安全'); });
  it('handles a failed remote task', async () => {
    const http: HttpClient = async url => url.includes('file-urls') ? response({ batch_id: 'b', file_urls: ['https://upload.example/pdf'] }) : url.includes('extract-results') ? response({ extract_result: [{ state: 'failed', err_msg: 'bad PDF' }] }) : { status: 200, bytes: new Uint8Array() };
    await expect(new MineruParser(http, 'token').parse(samplePdf(), 'study.pdf', new AbortController().signal)).rejects.toThrow('bad PDF');
  });
  it('does not wait forever on remote parsing', async () => {
    const http: HttpClient = async url => url.includes('file-urls') ? response({ batch_id: 'b', file_urls: ['https://upload.example/pdf'] }) : response({ extract_result: [{ state: 'running' }] });
    await expect(new MineruParser(http, 'token', 1, 3).parse(samplePdf(), 'study.pdf', new AbortController().signal)).rejects.toThrow('超时');
  });
});
