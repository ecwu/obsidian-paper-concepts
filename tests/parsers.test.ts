import { describe, it, expect, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { zipSync, strToU8 } from 'fflate';
import { LocalPdfParser } from '../src/parsers';
import { MineruParser, extractMineru, mineruTestPdf, testMineruApi } from '../src/mineru';
import type { HttpClient } from '../src/types';
import { samplePdf } from './helpers';
import { localPdfResources } from '../src/pdf-resources';
import { resolve } from 'node:path';

const archive = () => zipSync({ 'paper/full.md': strToU8('# Parsed paper\n\nText and ![](images/one.png)'), 'paper/images/one.png': new Uint8Array([1, 2]) });
const response = (data: unknown) => ({ status: 200, bytes: strToU8(JSON.stringify({ code: 0, data })) });

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
  it('matches the documented v4 contract and reports server progress', async () => {
    let polls = 0; const progress: string[] = [];
    const pdf = samplePdf();
    const http: HttpClient = async (url, method, headers, body) => {
      if (url.endsWith('file-urls/batch')) {
        expect(method).toBe('POST'); expect(headers.Authorization).toBe('Bearer raw-token');
        expect(JSON.parse(body as string)).toEqual({ files: [{ name: 'study.pdf', data_id: 'paper-concepts' }], model_version: 'vlm', enable_table: true, enable_formula: true });
        return response({ batch_id: 'batch/id', file_urls: ['https://upload.example/pdf'] });
      }
      if (url.startsWith('https://upload.')) { expect(method).toBe('PUT'); expect(headers).toEqual({}); expect(body).toEqual(pdf); return { status: 200, bytes: new Uint8Array() }; }
      if (url.includes('extract-results')) {
        expect(url).toBe('https://mineru.net/api/v4/extract-results/batch/batch%2Fid'); expect(method).toBe('GET');
        return response({ extract_result: [++polls === 1 ? { state: 'running', extract_progress: { extracted_pages: 1, total_pages: 2 } } : { state: 'done', full_zip_url: 'https://download.example/result' }] });
      }
      expect(method).toBe('GET'); expect(headers).toEqual({}); return { status: 200, bytes: archive() };
    };
    await new MineruParser(http, ' Bearer raw-token ', 1).parse(pdf, 'study.pdf', new AbortController().signal, text => progress.push(text));
    expect(progress).toContain('MinerU：解析中 (1/2 页)'); expect(progress.at(-1)).toContain('已就绪');
  });
  it.each([['A0202', 'Token 无效'], ['A0211', 'Token 已过期'], [-60018, '每日解析任务数量已达上限']])('explains documented API error %s', async (code, message) => {
    const http: HttpClient = async () => ({ status: 200, bytes: strToU8(JSON.stringify({ code, msg: 'error' })) });
    await expect(new MineruParser(http, 'secret').parse(samplePdf(), 'study.pdf', new AbortController().signal)).rejects.toThrow(message);
  });
  it('redacts an exact token echoed by an error response', async () => {
    const http: HttpClient = async () => ({ status: 400, bytes: strToU8(JSON.stringify({ code: -500, msg: 'unexpected sensitive-token-value' })) });
    await expect(new MineruParser(http, 'sensitive-token-value').parse(samplePdf(), 'study.pdf', new AbortController().signal)).rejects.not.toThrow('sensitive-token-value');
  });
  it('explains non-JSON and HTTP authentication failures', async () => {
    const html: HttpClient = async () => ({ status: 502, bytes: strToU8('<html>Bad gateway</html>') });
    await expect(new MineruParser(html, 'secret').parse(samplePdf(), 'study.pdf', new AbortController().signal)).rejects.toThrow('HTTP 502');
    const denied: HttpClient = async () => ({ status: 401, bytes: strToU8('{}') });
    await expect(new MineruParser(denied, 'secret').parse(samplePdf(), 'study.pdf', new AbortController().signal)).rejects.toThrow('认证失败');
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

describe('MinerU API test', () => {
  it('uses a readable synthetic single-page PDF', async () => {
    const parsed = await new LocalPdfParser(pdfjs, localPdfResources(resolve('node_modules/pdfjs-dist'))).parse(mineruTestPdf(), 'test.pdf', new AbortController().signal);
    expect(parsed.pages).toHaveLength(1); expect(parsed.markdown).toContain('Paper Concepts MinerU API test');
  });
  it('runs the actual upload, parse and download path without creating knowledge', async () => {
    const http: HttpClient = async (url, _method, _headers, body) => {
      if (url.endsWith('file-urls/batch')) { expect(JSON.parse(body as string).files[0].name).toBe('paper-concepts-api-test.pdf'); return response({ batch_id: 'b', file_urls: ['https://upload.example/pdf'] }); }
      if (url.startsWith('https://upload.')) { expect(body).toEqual(mineruTestPdf()); return { status: 200, bytes: new Uint8Array() }; }
      if (url.includes('extract-results')) return response({ extract_result: [{ state: 'done', full_zip_url: 'https://download.example/zip' }] });
      return { status: 200, bytes: archive() };
    };
    expect(await testMineruApi(http, 'secret', new AbortController().signal, () => {})).toContain('测试成功');
  });
  it('stops an API test on cancellation', async () => {
    let calls = 0; const http: HttpClient = async () => { calls++; return response({}); };
    const c = new AbortController(); c.abort();
    await expect(testMineruApi(http, 'secret', c.signal, () => {})).rejects.toThrow('取消'); expect(calls).toBe(0);
  });
  it('bounds the complete API test to three minutes', async () => {
    vi.useFakeTimers();
    try {
      const http: HttpClient = async (_url, _method, _headers, _body, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
      const expected = expect(testMineruApi(http, 'secret', new AbortController().signal, () => {})).rejects.toThrow('超过三分钟');
      await vi.advanceTimersByTimeAsync(180_000); await expected;
    } finally { vi.useRealTimers(); }
  });
});
