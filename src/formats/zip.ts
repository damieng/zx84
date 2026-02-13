/**
 * ZIP archive parser.
 * Extracts .sna / .z80 / .tap entries from ZIP files.
 * Uses browser DecompressionStream('deflate-raw') for inflate — no runtime deps.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOADABLE_EXTS = /\.(sna|z80|tap|tzx)$/i;

/** Parse a ZIP archive and return entries with loadable extensions. */
export async function unzip(data: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // ── 1. Find End-of-Central-Directory record ──────────────────────────
  const eocdSig = 0x06054b50;
  const searchStart = Math.max(0, data.length - 65557);
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file (EOCD not found)');

  // ── 2. Read EOCD fields ──────────────────────────────────────────────
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  // ── 3. Walk Central Directory ────────────────────────────────────────
  const cdSig = 0x02014b50;
  const lfhSig = 0x04034b50;

  interface CDEntry {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
  }

  const entries: CDEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > data.length || view.getUint32(pos, true) !== cdSig) break;

    const gpFlag = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const nameBytes = data.subarray(pos + 46, pos + 46 + nameLen);
    const isUTF8 = (gpFlag & (1 << 11)) !== 0;
    const name = new TextDecoder(isUTF8 ? 'utf-8' : 'ascii').decode(nameBytes);

    pos += 46 + nameLen + extraLen + commentLen;

    // Skip directories and unsupported compression methods
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) continue;
    if (!LOADABLE_EXTS.test(name)) continue;

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
  }

  // ── 4. Extract file data ─────────────────────────────────────────────
  const results: ZipEntry[] = [];

  for (const entry of entries) {
    const lhPos = entry.localHeaderOffset;
    if (lhPos + 30 > data.length || view.getUint32(lhPos, true) !== lfhSig) {
      throw new Error(`Invalid local file header for ${entry.name}`);
    }

    const localNameLen = view.getUint16(lhPos + 26, true);
    const localExtraLen = view.getUint16(lhPos + 28, true);
    const dataStart = lhPos + 30 + localNameLen + localExtraLen;

    // Use sizes from Central Directory (handles data descriptors correctly)
    const compressed = data.subarray(dataStart, dataStart + entry.compressedSize);

    let fileData: Uint8Array;
    if (entry.method === 0) {
      fileData = compressed;
    } else {
      fileData = await inflate(compressed, entry.uncompressedSize);
    }

    results.push({ name: entry.name, data: fileData });
  }

  return results;
}

/** Decompress deflate-raw data via browser DecompressionStream API. */
async function inflate(compressed: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressed as unknown as BufferSource);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.byteLength;
  }

  if (chunks.length === 1) return chunks[0];

  const result = new Uint8Array(expectedSize > 0 ? expectedSize : totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
