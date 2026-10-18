import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function localPdfResources(directory: string) {
  const folders: Record<string, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };
  class BinaryDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const folder = folders[kind];
      if (!folder || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(filename) || filename.includes('..')) throw new Error('PDF 请求了无效的本地解析资源');
      return new Uint8Array(await readFile(join(directory, folder, filename)));
    }
  }
  return { BinaryDataFactory, useWorkerFetch: false, useSystemFonts: false, cMapPacked: true };
}
