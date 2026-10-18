import { unzipSync } from 'fflate';
import type { HttpClient, ParsedPaper, PdfParser } from './types';
import { syntheticPdf } from './sample-pdf';
import { aborted, delay, redact } from './util';

/** Token-based v4 file API: https://mineru.net/apiManage/docs */
const API = 'https://mineru.net/api/v4/';
const MAX_BYTES = 200 * 1024 * 1024;
/** Documented API codes with a more useful explanation than the server message. */
const ERROR_REASONS: Record<string, string> = {
  A0202: 'Token 无效，请检查所选密钥内容', A0211: 'Token 已过期，请更新所选密钥', '-60018': '每日解析任务数量已达上限，请明日重试'
};
const STATE_LABELS: Record<string, string> = { 'waiting-file': '等待服务端接收文件', pending: '排队中', running: '解析中', converting: '格式转换中' };

/** Response payloads as received. Fields are unverified until checked at use. */
interface ExtractResult { state?: unknown; err_msg?: unknown; full_zip_url?: unknown; extract_progress?: { extracted_pages?: unknown; total_pages?: unknown } }
const httpsUrl = (value: unknown): value is string => typeof value === 'string' && value.startsWith('https://');
const ok = (status: number) => status >= 200 && status < 300;

/** The authenticated calls of one parse. The token goes only to the API host, never to upload or download URLs. */
class MineruApi {
  constructor(private http: HttpClient, private token: string, private signal: AbortSignal) {}

  async requestUpload(filename: string): Promise<{ uploadUrl: string; batchId: string }> {
    const data = await this.call<{ batch_id?: unknown; file_urls?: unknown[] }>('file-urls/batch',
      { files: [{ name: filename, data_id: 'paper-concepts' }], model_version: 'vlm', enable_table: true, enable_formula: true });
    const uploadUrl = data.file_urls?.[0], batchId = data.batch_id;
    if (!httpsUrl(uploadUrl) || typeof batchId !== 'string') throw new Error('MinerU 上传响应无效');
    return { uploadUrl, batchId };
  }
  async upload(url: string, bytes: Uint8Array): Promise<void> {
    if (!ok((await this.http(url, 'PUT', {}, bytes, this.signal)).status)) throw new Error('MinerU PDF 上传失败');
  }
  async result(batchId: string): Promise<ExtractResult | undefined> {
    return (await this.call<{ extract_result?: ExtractResult[] }>('extract-results/batch/' + encodeURIComponent(batchId))).extract_result?.[0];
  }
  async download(url: string): Promise<Uint8Array> {
    const response = await this.http(url, 'GET', {}, undefined, this.signal);
    if (response.status !== 200) throw new Error('MinerU 结果下载失败');
    aborted(this.signal);
    return response.bytes;
  }
  /** Removes the token from text that the server may have echoed. */
  hide(text: string): string { return redact(text.split(this.token).join('[REDACTED]')).slice(0, 1000); }

  /** POST when a body is given, otherwise GET. Returns `data` of a successful `{ code: 0, data }` envelope. */
  private async call<T>(path: string, body?: unknown): Promise<T> {
    aborted(this.signal);
    const headers = { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
    const response = await this.http(API + path, body === undefined ? 'GET' : 'POST', headers, body === undefined ? undefined : JSON.stringify(body), this.signal);
    let envelope: { code?: unknown; msg?: unknown; data?: unknown } | null;
    try { envelope = JSON.parse(new TextDecoder().decode(response.bytes)); }
    catch { throw new Error(`MinerU 返回非 JSON 响应 (HTTP ${response.status})，请检查网络或稍后重试`); }
    const code = String(envelope?.code ?? '');
    if (code !== '0' || !ok(response.status)) {
      const reason = ERROR_REASONS[code] ?? (response.status === 401 || response.status === 403 ? '认证失败，请检查 MinerU Token'
        : response.status === 429 ? '请求受限，请稍后重试' : String(envelope?.msg ?? '请求失败'));
      throw new Error(`MinerU：${this.hide(reason)} (HTTP ${response.status}${code ? '，code ' + code : ''})`);
    }
    if (!envelope?.data || typeof envelope.data !== 'object') throw new Error('MinerU 响应缺少 data');
    return envelope.data as T;
  }
}

function progressText(result: ExtractResult | undefined): string {
  const pages = result?.extract_progress;
  const count = Number.isInteger(pages?.extracted_pages) && Number.isInteger(pages?.total_pages) ? ` (${pages!.extracted_pages}/${pages!.total_pages} 页)` : '';
  return `MinerU：${STATE_LABELS[String(result?.state)] ?? '等待解析结果'}${count}`;
}

export class MineruParser implements PdfParser {
  constructor(private http: HttpClient, private token: string, private pollMs = 3000, private timeoutMs = 30 * 60_000) {}

  async parse(bytes: Uint8Array, filename: string, signal: AbortSignal, progress: (text: string) => void = () => {}): Promise<ParsedPaper> {
    aborted(signal);
    const token = this.token.trim().replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new Error('请在设置中选择已保存的 MinerU Token');
    if (bytes.length > MAX_BYTES) throw new Error('MinerU 首版支持不超过 200 MB 的 PDF');
    const api = new MineruApi(this.http, token, signal);
    progress('MinerU：申请上传地址');
    const { uploadUrl, batchId } = await api.requestUpload(filename);
    progress('MinerU：上传 PDF');
    await api.upload(uploadUrl, bytes);
    const zipUrl = await this.waitForResult(api, batchId, signal, progress);
    progress('MinerU：下载解析结果');
    const parsed = extractMineru(await api.download(zipUrl));
    progress('MinerU：解析正文与附件已就绪');
    return parsed;
  }

  /** Polls until the task is done and returns the result ZIP URL. Reports each new state once. */
  private async waitForResult(api: MineruApi, batchId: string, signal: AbortSignal, progress: (text: string) => void): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    let reported = '';
    while (Date.now() < deadline) {
      const result = await api.result(batchId);
      if (result?.state === 'failed') throw new Error(`MinerU 解析失败：${api.hide(String(result.err_msg ?? '未知错误'))}`);
      if (result?.state === 'done') {
        if (!httpsUrl(result.full_zip_url)) throw new Error('MinerU 下载链接无效');
        return result.full_zip_url;
      }
      const text = progressText(result);
      if (text !== reported) { progress(text); reported = text; }
      await delay(this.pollMs, signal);
    }
    throw new Error('MinerU 解析超时，请稍后重试');
  }
}

/** Reads `full.md` and the images beside it from a MinerU result ZIP. Other files (JSON layouts, the origin PDF) are dropped. */
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
  const assets = Object.entries(files)
    .filter(([name]) => name.startsWith(base) && /\.(png|jpe?g|webp|gif|svg)$/i.test(name))
    .map(([name, data]) => ({ path: name.slice(base.length), bytes: data }));
  return { markdown, assets, pages: [], parser: 'mineru-v4-vlm' };
}

/** A synthetic one-page PDF. No vault content enters the API test. */
export const mineruTestPdf = (): Uint8Array => syntheticPdf(['Paper Concepts MinerU API test', 'This is a synthetic one-page test document.', 'A successful response includes readable Markdown.']);

/** Runs a real parse of the synthetic PDF: authentication, upload, parsing, and download. Stops after three minutes. */
export async function testMineruApi(http: HttpClient, token: string, signal: AbortSignal, progress: (text: string) => void): Promise<string> {
  const limit = new AbortController(), timer = setTimeout(() => limit.abort(), 180_000);
  try {
    const parsed = await new MineruParser(http, token).parse(mineruTestPdf(), 'paper-concepts-api-test.pdf', AbortSignal.any([signal, limit.signal]), progress);
    return `MinerU API 测试成功：上传、解析和下载均完成，返回 ${parsed.markdown.length} 个正文字符、${parsed.assets.length} 个附件。`;
  } catch (error) {
    if (limit.signal.aborted && !signal.aborted) throw new Error('MinerU API 测试超过三分钟，请稍后重试；云端任务可能继续运行。');
    throw error;
  } finally { clearTimeout(timer); }
}
