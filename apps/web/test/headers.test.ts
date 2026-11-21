import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script
import { buildCsp, buildHeaders } from "../scripts/headers.mjs";

describe("web security headers", () => {
  it("is closed by default", () => {
    const csp: string = buildCsp({});
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toMatch(/unsafe-eval(?!')/);
    expect(csp).not.toMatch(/script-src[^;]*(https?:|\*)/);
  });

  it("adds only the configured origins", () => {
    const csp: string = buildCsp({
      WEB_API_ORIGIN: "https://api.example.test/some/path",
      WEB_FILES_ORIGIN: "https://files.example.test",
      WEB_LIVEKIT_URL: "wss://live.example.test",
    });
    expect(csp).toContain("connect-src 'self' https://api.example.test wss://api.example.test https://files.example.test wss://live.example.test https://live.example.test");
    expect(csp).toContain("img-src 'self' blob: https://files.example.test data:");
    expect(csp).not.toContain("/some/path");
  });

  it("lets uploads reach the upload origin, and nothing else", () => {
    const csp: string = buildCsp({ WEB_FILES_ORIGIN: "https://files.example.test", WEB_UPLOAD_ORIGIN: "https://acct.r2.example.test/bucket" });
    expect(csp).toContain("connect-src 'self' https://files.example.test https://acct.r2.example.test;");
    expect(csp).not.toMatch(/(img|media|script)-src[^;]*acct\.r2/);
    expect(buildCsp({ WEB_FILES_ORIGIN: "https://f.example.test", WEB_UPLOAD_ORIGIN: "https://f.example.test" })).toContain("connect-src 'self' https://f.example.test;");
    expect(() => buildCsp({ WEB_UPLOAD_ORIGIN: "http://r2.example.test" })).toThrow();
  });

  it("rejects bad or insecure origins", () => {
    expect(() => buildCsp({ WEB_API_ORIGIN: "not a url" })).toThrow();
    expect(() => buildCsp({ WEB_API_ORIGIN: "http://api.example.test" })).toThrow();
  });

  it("emits the full header block", () => {
    const out: string = buildHeaders({});
    for (const h of ["Strict-Transport-Security", "X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer", "X-Frame-Options: DENY"]) {
      expect(out).toContain(h);
    }
  });
});
