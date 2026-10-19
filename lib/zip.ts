import { strToU8, zipSync } from 'fflate';
import type { GeneratedFiles } from '@/lib/generators/types';

/** Creates the zip in memory: nothing is written to disk, and no user text is ever used as a path. */
export function createZip(files: GeneratedFiles, mtime: Date = new Date()): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\') || path.includes('\u0000')) {
      throw new Error(`Unsafe path in the archive: ${path}`);
    }
    entries[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(entries, { level: 9, mtime });
}
