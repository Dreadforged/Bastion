import { describe, expect, it } from "vitest";
import { detectType } from "../src/files/sniff.js";
import { InvalidFileError, stripMetadata } from "../src/files/strip.js";
import {
  GIF_PIXELS,
  JPEG_SCAN,
  PNG_PIXELS,
  WEBP_PIXELS,
  bytesOf,
  concat,
  contains,
  gifWithMetadata,
  jpegWithMetadata,
  makePng,
  pngChunk,
  pngWithMetadata,
  webpWithMetadata,
} from "./images.js";

describe("detectType", () => {
  it("reads the type from the first bytes", () => {
    expect(detectType(makePng())).toBe("image/png");
    expect(detectType(jpegWithMetadata())).toBe("image/jpeg");
    expect(detectType(gifWithMetadata())).toBe("image/gif");
    expect(detectType(gifWithMetadata().map((b, i) => (i === 4 ? 0x37 : b)))).toBe("image/gif");
    expect(detectType(webpWithMetadata())).toBe("image/webp");
  });

  it("rejects everything else, however it is named", () => {
    expect(detectType(bytesOf("MZ\x90\x00 portable executable"))).toBeNull();
    expect(detectType(bytesOf("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectType(bytesOf("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(detectType(bytesOf("%PDF-1.7"))).toBeNull();
    expect(detectType(bytesOf("PK\x03\x04 zip"))).toBeNull();
    expect(detectType(new Uint8Array())).toBeNull();
    // A RIFF file that is not WebP, such as a WAV.
    expect(detectType(concat(bytesOf("RIFF"), new Uint8Array(4), bytesOf("WAVE")))).toBeNull();
    // Looks like a PNG only if the whole signature is there.
    expect(detectType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe("PNG", () => {
  it("drops EXIF, text, XMP and timestamp chunks and keeps the picture", () => {
    const out = stripMetadata("image/png", pngWithMetadata());
    for (const secret of ["GPS-SECRET", "Jane Q Public", "compressed-secret", "eXIf", "tEXt", "iTXt", "zTXt", "tIME"]) {
      expect(contains(out, secret)).toBe(false);
    }
    expect(Buffer.from(out).equals(Buffer.from(makePng([pngChunk("gAMA", Uint8Array.from([0, 1, 0x86, 0xa0]))])))).toBe(true);
    expect(contains(out, "IDAT")).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from(PNG_PIXELS))).toBe(true);
  });

  it("is a no-op on a file that has none", () => {
    const clean = makePng();
    expect(Buffer.from(stripMetadata("image/png", clean)).equals(Buffer.from(clean))).toBe(true);
  });

  it("drops unknown ancillary chunks but keeps unknown critical ones", () => {
    const out = stripMetadata("image/png", makePng([pngChunk("prVt", bytesOf("private-SECRET")), pngChunk("PLTE", Uint8Array.from([1, 2, 3]))]));
    expect(contains(out, "private-SECRET")).toBe(false);
    expect(contains(out, "PLTE")).toBe(true);
  });

  it("drops anything appended after IEND", () => {
    const out = stripMetadata("image/png", makePng([], bytesOf("hidden-zip-SECRET")));
    expect(contains(out, "hidden-zip-SECRET")).toBe(false);
  });

  it("rejects files that do not parse", () => {
    const whole = makePng();
    const cases = {
      truncated: whole.slice(0, whole.length - 5),
      "no IEND": whole.slice(0, whole.length - 12),
      "chunk past the end": concat(whole.slice(0, 8), Uint8Array.from([0x7f, 0xff, 0xff, 0xff]), bytesOf("IHDR")),
      "wrong first chunk": concat(whole.slice(0, 8), pngChunk("IDAT", PNG_PIXELS), pngChunk("IEND")),
      "bad chunk type": concat(whole.slice(0, 8), pngChunk("IH\0R"), pngChunk("IEND")),
      "signature only": whole.slice(0, 8),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      expect(() => stripMetadata("image/png", bytes), name).toThrow(InvalidFileError);
    }
  });
});

describe("JPEG", () => {
  it("drops EXIF, XMP, IPTC, MPF thumbnails, comments and trailing data", () => {
    const out = stripMetadata("image/jpeg", jpegWithMetadata());
    for (const secret of ["GPS-SECRET", "embedded-thumbnail-SECRET", "iptc-SECRET", "comment-SECRET", "TRAILING-SECRET-PAYLOAD", "Exif", "xmpmeta"]) {
      expect(contains(out, secret)).toBe(false);
    }
  });

  it("keeps JFIF, the colour profile, the Adobe marker and the picture data", () => {
    const out = stripMetadata("image/jpeg", jpegWithMetadata());
    expect(contains(out, "JFIF")).toBe(true);
    expect(contains(out, "ICC_PROFILE")).toBe(true);
    expect(contains(out, "Adobe")).toBe(true);
    // Scan data with a stuffed zero and a restart marker survives byte for byte.
    expect(Buffer.from(out).includes(Buffer.from(JPEG_SCAN))).toBe(true);
    expect([...out.slice(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.slice(-2)]).toEqual([0xff, 0xd9]);
  });

  it("handles files with several scans", () => {
    const progressive = concat(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 1, 0, 0xaa, 0xbb, 0xff, 0xc4, 0, 4, 7, 0xcc, 0xff, 0xda, 0, 4, 1, 0, 0xdd, 0xff, 0xd9]),
      bytesOf("TRAILING-SECRET"),
    );
    const out = stripMetadata("image/jpeg", progressive);
    expect([...out]).toEqual([0xff, 0xd8, 0xff, 0xda, 0, 4, 1, 0, 0xaa, 0xbb, 0xff, 0xc4, 0, 4, 7, 0xcc, 0xff, 0xda, 0, 4, 1, 0, 0xdd, 0xff, 0xd9]);
  });

  it("rejects files that do not parse", () => {
    const whole = jpegWithMetadata();
    const cases = {
      "no end of image": whole.slice(0, 30 + 40).slice(0, 69),
      "segment past the end": concat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), bytesOf("short")),
      "bad length": Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 1, 0xff, 0xd9]),
      "not a marker": Uint8Array.from([0xff, 0xd8, 0x00, 0x01, 0x02]),
      "start only": Uint8Array.from([0xff, 0xd8]),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      expect(() => stripMetadata("image/jpeg", bytes), name).toThrow(InvalidFileError);
    }
  });
});

describe("GIF", () => {
  it("drops comments, plain text and XMP, and keeps the animation loop, timing and pixels", () => {
    const out = stripMetadata("image/gif", gifWithMetadata());
    for (const secret of ["GPS-SECRET", "comment-SECRET", "plain-text-SECRET", "XMP DataXMP"]) expect(contains(out, secret)).toBe(false);
    expect(contains(out, "NETSCAPE2.0")).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from(GIF_PIXELS))).toBe(true);
    expect(out.at(-1)).toBe(0x3b);
    expect(contains(out, "GIF89a")).toBe(true);
  });

  it("rejects files that do not parse", () => {
    const whole = gifWithMetadata();
    const cases = {
      truncated: whole.slice(0, whole.length - 8),
      "no trailer": whole.slice(0, whole.length - 1),
      "unknown block": concat(whole.slice(0, 19), Uint8Array.from([0x99, 0x3b])),
      "short header": bytesOf("GIF89a"),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      expect(() => stripMetadata("image/gif", bytes), name).toThrow(InvalidFileError);
    }
  });
});

describe("WebP", () => {
  it("drops EXIF and XMP chunks, clears their flags, fixes the size and drops trailing data", () => {
    const out = stripMetadata("image/webp", webpWithMetadata());
    for (const secret of ["GPS-SECRET", "EXIF", "XMP ", "TRAILING-SECRET"]) expect(contains(out, secret)).toBe(false);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(4, true)).toBe(out.length - 8);
    // VP8X flags: EXIF (0x08) and XMP (0x04) off, ICC (0x20) still on.
    expect(out[20]).toBe(0x20);
    expect(contains(out, "ICCP")).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from(WEBP_PIXELS))).toBe(true);
  });

  it("rejects files that do not parse", () => {
    const whole = webpWithMetadata();
    const lying = whole.slice();
    new DataView(lying.buffer).setUint32(4, whole.length * 2, true);
    const cases = {
      "size larger than file": lying,
      truncated: whole.slice(0, 25),
      "unknown first chunk": concat(bytesOf("RIFF"), Uint8Array.from([12, 0, 0, 0]), bytesOf("WEBP"), bytesOf("JUNK"), Uint8Array.from([0, 0, 0, 0])),
      "header only": whole.slice(0, 12),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      expect(() => stripMetadata("image/webp", bytes), name).toThrow(InvalidFileError);
    }
  });
});
