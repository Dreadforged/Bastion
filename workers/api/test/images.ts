/** Builders for small, structurally valid images with metadata in them. */

const enc = new TextEncoder();
export const bytesOf = (text: string): Uint8Array => enc.encode(text);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function contains(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, "latin1"));
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

// ------------------------------------------------------------------ PNG

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

export function pngChunk(type: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const body = concat(bytesOf(type), data);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A 1x1 greyscale pixel. */
const IHDR = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
export const PNG_PIXELS = Uint8Array.from([0x08, 0xd7, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);

export function makePng(extra: Uint8Array[] = [], trailing: Uint8Array = new Uint8Array()): Uint8Array {
  return concat(PNG_SIGNATURE, pngChunk("IHDR", IHDR), ...extra, pngChunk("IDAT", PNG_PIXELS), pngChunk("IEND"), trailing);
}

export const pngWithMetadata = (): Uint8Array =>
  makePng([
    pngChunk("gAMA", Uint8Array.from([0, 1, 0x86, 0xa0])),
    pngChunk("tEXt", bytesOf("Author\0Jane Q Public")),
    pngChunk("iTXt", bytesOf("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>GPS-SECRET</x:xmpmeta>")),
    pngChunk("zTXt", bytesOf("Comment\0\0compressed-secret")),
    pngChunk("eXIf", bytesOf("MM\0*GPS-SECRET")),
    pngChunk("tIME", Uint8Array.from([7, 0xea, 11, 19, 4, 30, 0])),
  ]);

// ------------------------------------------------------------------ JPEG

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return concat(Uint8Array.from([0xff, marker, length >> 8, length & 0xff]), payload);
}

export const JPEG_SCAN = Uint8Array.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);

export function jpegWithMetadata(): Uint8Array {
  return concat(
    Uint8Array.from([0xff, 0xd8]),
    segment(0xe0, bytesOf("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    segment(0xe1, bytesOf("Exif\0\0MM\0*GPS-SECRET")),
    segment(0xe1, bytesOf("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS-SECRET</x:xmpmeta>")),
    segment(0xe2, bytesOf("ICC_PROFILE\0\x01\x01profile-bytes")),
    segment(0xe2, bytesOf("MPF\0embedded-thumbnail-SECRET")),
    segment(0xed, bytesOf("Photoshop 3.0\x008BIMiptc-SECRET")),
    segment(0xee, bytesOf("Adobe\0\x64\0\0\0\0\x01")),
    segment(0xfe, bytesOf("comment-SECRET")),
    segment(0xdb, Uint8Array.from([0, 1, 2, 3])),
    segment(0xc0, Uint8Array.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    segment(0xda, Uint8Array.from([1, 1, 0, 0, 0x3f, 0])),
    JPEG_SCAN,
    Uint8Array.from([0xff, 0xd9]),
    bytesOf("TRAILING-SECRET-PAYLOAD"),
  );
}

// ------------------------------------------------------------------ GIF

export const GIF_PIXELS = Uint8Array.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00]);

function extension(label: number, ...blocks: Uint8Array[]): Uint8Array {
  return concat(Uint8Array.from([0x21, label]), ...blocks.map((b) => concat(Uint8Array.from([b.length]), b)), Uint8Array.from([0]));
}

export function gifWithMetadata(): Uint8Array {
  return concat(
    bytesOf("GIF89a"),
    Uint8Array.from([1, 0, 1, 0, 0x80, 0, 0]), // logical screen with a 2 colour table
    Uint8Array.from([0, 0, 0, 255, 255, 255]),
    extension(0xff, bytesOf("NETSCAPE2.0"), Uint8Array.from([1, 0, 0])),
    extension(0xff, bytesOf("XMP DataXMP"), bytesOf("<x:xmpmeta>GPS-SECRET</x:xmpmeta>")),
    extension(0xfe, bytesOf("comment-SECRET")),
    extension(0x01, Uint8Array.from([12, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]), bytesOf("plain-text-SECRET")),
    extension(0xf9, Uint8Array.from([4, 0, 0, 0, 0]).subarray(0, 4)),
    GIF_PIXELS,
    Uint8Array.from([0x3b]),
  );
}

// ------------------------------------------------------------------ WebP

function riffChunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const pad = payload.length % 2 ? 1 : 0;
  const out = new Uint8Array(8 + payload.length + pad);
  out.set(bytesOf(fourcc), 0);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

export const WEBP_PIXELS = Uint8Array.from([0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00]);

export function webpWithMetadata(): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x08 | 0x04 | 0x20; // EXIF, XMP and ICC flags
  const chunks = concat(
    riffChunk("VP8X", vp8x),
    riffChunk("ICCP", bytesOf("icc-profile!")),
    riffChunk("VP8L", WEBP_PIXELS),
    riffChunk("EXIF", bytesOf("MM\0*GPS-SECRET")),
    riffChunk("XMP ", bytesOf("<x:xmpmeta>GPS-SECRET</x:xmpmeta>")),
  );
  const out = concat(bytesOf("RIFF"), new Uint8Array(4), bytesOf("WEBP"), chunks, bytesOf("TRAILING-SECRET"));
  new DataView(out.buffer).setUint32(4, 4 + chunks.length, true);
  return out;
}
