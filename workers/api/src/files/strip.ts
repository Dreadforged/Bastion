import type { schemas } from "@bastion/shared";

/**
 * Remove metadata from images shared in public channels: EXIF (GPS position,
 * camera serial numbers, timestamps), XMP, IPTC, comments and thumbnails.
 *
 * Each stripper walks the file's real structure and copies the parts that
 * make up the picture. Anything it does not recognize is dropped, and bytes
 * after the end of the image are dropped too, since they can hide a second
 * file. A file that does not parse is rejected, never passed through.
 *
 * Known limit: the EXIF orientation tag goes with the rest, so a photo that
 * relied on it shows rotated. Clients should bake the rotation into the
 * pixels before upload.
 */

export class InvalidFileError extends Error {
  constructor(message = "malformed image") {
    super(message);
  }
}

function need(ok: boolean): void {
  if (!ok) throw new InvalidFileError();
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const text = (bytes: Uint8Array, start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, end));
const u32be = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

// ------------------------------------------------------------------ PNG

/** Ancillary chunks that affect how the picture looks and carry nothing personal. */
const PNG_KEEP = new Set(["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "pHYs", "bKGD", "sBIT", "hIST", "acTL", "fcTL", "fdAT"]);

function stripPng(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let pos = 8;
  let first = true;
  for (;;) {
    need(pos + 12 <= b.length);
    const length = u32be(b, pos);
    const end = pos + 12 + length;
    need(end <= b.length);
    const type = text(b, pos + 4, pos + 8);
    need(/^[A-Za-z]{4}$/.test(type));
    if (first) need(type === "IHDR");
    first = false;
    // Upper case first letter means critical; the rest are kept only if known to be harmless.
    if (type[0] === type[0]!.toUpperCase() || PNG_KEEP.has(type)) out.push(b.subarray(pos, end));
    pos = end;
    if (type === "IEND") return concat(out);
  }
}

// ------------------------------------------------------------------ JPEG

const ICC = "ICC_PROFILE\0";

function keepJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xe0) return text(payload, 0, 5) === "JFIF\0";
  if (marker === 0xe2) return text(payload, 0, ICC.length) === ICC;
  if (marker === 0xee) return true; // Adobe colour transform, needed to decode
  if (marker >= 0xe1 && marker <= 0xef) return false; // EXIF, XMP, IPTC, MPF and other application data
  return marker !== 0xfe; // comments out, everything structural in
}

function stripJpeg(b: Uint8Array): Uint8Array<ArrayBuffer> {
  need(b[0] === 0xff && b[1] === 0xd8);
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let pos = 2;
  for (;;) {
    need(pos + 1 < b.length && b[pos] === 0xff);
    // Any number of 0xFF fill bytes may come before a marker.
    while (b[pos + 1] === 0xff) pos++;
    const marker = b[pos + 1]!;
    need(pos + 1 < b.length);
    if (marker === 0xd9) {
      out.push(b.subarray(pos, pos + 2));
      return concat(out);
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.push(b.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    need(pos + 4 <= b.length);
    const length = (b[pos + 2]! << 8) | b[pos + 3]!;
    need(length >= 2);
    const end = pos + 2 + length;
    need(end <= b.length);
    if (keepJpegSegment(marker, b.subarray(pos + 4, end))) out.push(b.subarray(pos, end));
    pos = end;
    if (marker === 0xda) {
      // Entropy-coded data runs until the next real marker: 0xFF then something
      // other than a stuffed zero, a restart marker or more fill.
      const start = pos;
      while (pos + 1 < b.length) {
        if (b[pos] === 0xff && b[pos + 1] !== 0x00 && b[pos + 1] !== 0xff && !(b[pos + 1]! >= 0xd0 && b[pos + 1]! <= 0xd7)) break;
        pos++;
      }
      need(pos + 1 < b.length);
      out.push(b.subarray(start, pos));
    }
  }
}

// ------------------------------------------------------------------ GIF

/** The end of a run of data sub-blocks starting at `at`, which end with a zero length. */
function subBlocksEnd(b: Uint8Array, at: number): number {
  let p = at;
  for (;;) {
    need(p < b.length);
    const size = b[p]!;
    p += 1 + size;
    if (size === 0) return p;
  }
}

function stripGif(b: Uint8Array): Uint8Array<ArrayBuffer> {
  need(b.length >= 13);
  const packed = b[10]!;
  let pos = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  need(pos <= b.length);
  const out: Uint8Array[] = [b.subarray(0, pos)];
  for (;;) {
    need(pos < b.length);
    const code = b[pos]!;
    if (code === 0x3b) {
      out.push(b.subarray(pos, pos + 1));
      return concat(out);
    }
    if (code === 0x21) {
      need(pos + 2 <= b.length);
      const label = b[pos + 1]!;
      const end = subBlocksEnd(b, pos + 2);
      const app = label === 0xff && b[pos + 2] === 11 ? text(b, pos + 3, pos + 14) : "";
      // Graphic control and the loop count of animations stay. Comments, plain
      // text and other application data (XMP lives there) go.
      if (label === 0xf9 || app === "NETSCAPE2.0" || app === "ANIMEXTS1.0") out.push(b.subarray(pos, end));
      pos = end;
      continue;
    }
    need(code === 0x2c && pos + 10 <= b.length);
    const local = b[pos + 9]!;
    const table = local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0;
    const end = subBlocksEnd(b, pos + 10 + table + 1);
    out.push(b.subarray(pos, end));
    pos = end;
  }
}

// ------------------------------------------------------------------ WebP

function stripWebp(b: Uint8Array): Uint8Array<ArrayBuffer> {
  need(b.length >= 20);
  const total = 8 + u32le(b, 4);
  need(total <= b.length && total >= 20);
  const chunks: Uint8Array[] = [];
  let pos = 12;
  while (pos < total) {
    need(pos + 8 <= total);
    const fourcc = text(b, pos, pos + 4);
    const size = u32le(b, pos + 4);
    const end = pos + 8 + size + (size % 2);
    need(end <= total);
    if (chunks.length === 0) need(fourcc === "VP8 " || fourcc === "VP8L" || fourcc === "VP8X");
    if (fourcc !== "EXIF" && fourcc !== "XMP ") {
      const chunk = b.slice(pos, end);
      // The extended header says which metadata chunks exist.
      if (fourcc === "VP8X") {
        need(size >= 10);
        chunk[8] = chunk[8]! & ~(0x08 | 0x04);
      }
      chunks.push(chunk);
    }
    pos = end;
  }
  need(chunks.length > 0);
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 4), 0);
  new DataView(header.buffer).setUint32(4, 4 + body.length, true);
  header.set(b.subarray(8, 12), 8);
  return concat([header, body]);
}

// ------------------------------------------------------------------ entry point

/** The same image without metadata. Throws InvalidFileError if it does not parse. */
export function stripMetadata(type: schemas.PublicFileType, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  switch (type) {
    case "image/png":
      return stripPng(bytes);
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/gif":
      return stripGif(bytes);
    case "image/webp":
      return stripWebp(bytes);
  }
}
