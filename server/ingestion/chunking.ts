export interface Chunk {
  ordinal: number;
  text: string;
  startLine: number; // 1-based, inclusive
  endLine: number;
}

/** Split on line boundaries so every chunk maps back to exact source lines (citations). */
export function chunkLines(text: string, maxLines = 30, maxChars = 1500, overlap = 3): Chunk[] {
  const lines = text.split("\n");
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && end - start < maxLines && size + lines[end].length <= maxChars) {
      size += lines[end].length + 1;
      end += 1;
    }
    if (end === start) end = start + 1; // a single very long line
    let lo = start;
    let hi = end;
    while (lo < hi && !lines[lo].trim()) lo += 1;
    while (hi > lo && !lines[hi - 1].trim()) hi -= 1;
    if (hi > lo) chunks.push({ ordinal: chunks.length, text: lines.slice(lo, hi).join("\n"), startLine: lo + 1, endLine: hi });
    if (end >= lines.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
