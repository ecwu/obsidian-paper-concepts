import { posix } from 'node:path';
import type { ParsedPaper, ParserKind, VaultPort } from './types';
import type { Layout } from './settings';
import { scopedVault } from './scoped-vault';
import { aborted, hash } from './util';

interface ParseMetadata { sourceHash: string; key: string; parser: string; pages: ParsedPaper['pages']; markdownHash: string }

/** Parsed Markdown and images are stored in the assets folder, keyed by PDF hash and parser, and reused while they still match. */
export class ParseCache {
  private vault: VaultPort;
  constructor(vault: VaultPort, private layout: Layout) { this.vault = scopedVault(vault, layout.root); }

  /**
   * Makes sure `layout.parsedMarkdown(sourceHash, kind)` holds a valid parse.
   * The PDF is read only when no valid parse exists, so a parse can be reused after the PDF is gone.
   */
  async ensure(sourceHash: string, kind: ParserKind, readSource: () => Promise<Uint8Array>,
    parse: (bytes: Uint8Array) => Promise<ParsedPaper>, signal: AbortSignal, log: (text: string) => void): Promise<void> {
    const base = this.layout.parsedDir(sourceHash, kind), key = posix.basename(base);
    const markdownPath = this.layout.parsedMarkdown(sourceHash, kind), metadataPath = base + '/parsed.json';
    if (await this.isValid(markdownPath, metadataPath, sourceHash, key)) { log('复用已保存的解析正文'); return; }
    const bytes = await readSource();
    if (hash(bytes) !== sourceHash) throw new Error('原始 PDF 与任务记录不一致，不能按旧任务继续');
    const parsed = await parse(bytes);
    aborted(signal);
    for (const asset of parsed.assets) { aborted(signal); await this.save(`${base}/${asset.path}`, asset.bytes); }
    await this.save(markdownPath, parsed.markdown);
    const metadata: ParseMetadata = { sourceHash, key, parser: parsed.parser, pages: parsed.pages, markdownHash: hash(parsed.markdown) };
    await this.save(metadataPath, JSON.stringify(metadata, null, 2));
    const pages = parsed.pages.length ? `，${parsed.pages.length} 页` : '', images = parsed.assets.length ? `，${parsed.assets.length} 张图片` : '';
    log(`解析完成：${parsed.markdown.length} 个字符${pages}${images}`);
  }

  private async isValid(markdownPath: string, metadataPath: string, sourceHash: string, key: string): Promise<boolean> {
    if (!await this.vault.exists(metadataPath) || !await this.vault.exists(markdownPath)) return false;
    const metadata = JSON.parse(await this.vault.read(metadataPath)) as Partial<ParseMetadata>;
    return metadata.sourceHash === sourceHash && metadata.key === key && metadata.markdownHash === hash(await this.vault.read(markdownPath));
  }

  /** Writes a cache file, refusing to overwrite a different existing file. */
  private async save(path: string, content: string | Uint8Array): Promise<void> {
    await this.vault.mkdir(posix.dirname(path));
    if (await this.vault.exists(path)) {
      const old = typeof content === 'string' ? await this.vault.read(path) : await this.vault.readBinary(path);
      if (hash(old) !== hash(content)) throw new Error('已有解析文件内容不同，未覆盖；请保留后移走旧解析目录再重试');
    } else if (typeof content === 'string') await this.vault.create(path, content);
    else await this.vault.createBinary(path, content);
  }
}
