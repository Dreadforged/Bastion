import { schemas } from "@bastion/shared";
import { describe, expect, it } from "vitest";
import { AttachmentError, decryptFile, downloadAttachment, encryptFile, MAX_PLAIN_BYTES, uploadChannelFile } from "../src/lib/attachments.js";
import { Api, MemoryTokenStore } from "../src/lib/http.js";

const S = "01HZZZZZZZZZZZZZZZZZZZZZS1";
const C = "01HZZZZZZZZZZZZZZZZZZZZZC1";
const FILE = "01HZZZZZZZZZZZZZZZZZZZZZF1";

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

function apiWith(handler: (method: string, path: string, body: unknown) => unknown) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url), "http://h").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    const out = handler(init?.method ?? "GET", path, body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  const tokens = { accessToken: "a".repeat(43), refreshToken: "r".repeat(43), accessExpiresAt: Date.now() + 1e6, refreshExpiresAt: Date.now() + 1e7 };
  const store = new MemoryTokenStore(tokens as schemas.SessionTokens);
  return { api: new Api({ baseUrl: "http://h", store, fetch }), calls };
}

describe("attachment encryption", () => {
  it("round trips and fits the message payload shape", async () => {
    const { cipher, key, nonce } = await encryptFile(bytes("secret plans"));
    expect(new TextDecoder().decode(cipher)).not.toContain("secret");
    const payload = schemas.MessagePayload.parse({ text: "", attachments: [{ id: FILE, key, nonce, name: "a.txt", mime: "text/plain", size: 12 }] });
    expect(new TextDecoder().decode(await decryptFile(cipher, payload.attachments[0]!))).toBe("secret plans");
  });

  it("uses a fresh key every time", async () => {
    const a = await encryptFile(bytes("same"));
    const b = await encryptFile(bytes("same"));
    expect(a.key).not.toBe(b.key);
  });

  it("refuses a wrong key or tampered bytes", async () => {
    const one = await encryptFile(bytes("hello"));
    const two = await encryptFile(bytes("hello"));
    await expect(decryptFile(one.cipher, two)).rejects.toBeInstanceOf(AttachmentError);
    one.cipher[0] = one.cipher[0]! ^ 1;
    await expect(decryptFile(one.cipher, one)).rejects.toMatchObject({ code: "cannot_decrypt" });
  });
});

describe("uploadChannelFile", () => {
  it("uploads ciphertext straight to storage, without our token, then completes", async () => {
    const { api, calls } = apiWith((_m, path) =>
      path === "/files/uploads"
        ? { fileId: FILE, uploadUrl: "https://r2.example.test/put", headers: { "content-type": "application/octet-stream" }, expiresAt: 1 }
        : { id: FILE, visibility: "private", status: "ready", size: 0, contentType: "application/octet-stream", createdAt: 1 },
    );
    const puts: { url: string; init: RequestInit }[] = [];
    const put = async (url: string, init?: RequestInit) => {
      puts.push({ url, init: init! });
      return new Response(null, { status: 200 });
    };
    const attachment = await uploadChannelFile(api, { serverId: S, channelId: C }, { name: "notes.txt", type: "text/plain", bytes: bytes("hello there") }, put);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /files/uploads", `POST /files/uploads/${FILE}/complete`]);
    const request = schemas.CreateUploadRequest.parse(calls[0]!.body);
    expect(request).toMatchObject({ visibility: "private", scope: { type: "channel", serverId: S, channelId: C } });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe("https://r2.example.test/put");
    expect(puts[0]!.init.method).toBe("PUT");
    expect(JSON.stringify(puts[0]!.init.headers)).not.toMatch(/authorization/i);
    const sent = puts[0]!.init.body as Uint8Array<ArrayBuffer>;
    expect(request.size).toBe(sent.length);
    expect(attachment).toMatchObject({ id: FILE, name: "notes.txt", mime: "text/plain", size: 11 });
    expect(new TextDecoder().decode(await decryptFile(sent, attachment))).toBe("hello there");
  });

  it("does not complete when storage refuses the upload", async () => {
    const { api, calls } = apiWith(() => ({ fileId: FILE, uploadUrl: "https://r2.example.test/put", headers: {}, expiresAt: 1 }));
    const put = async () => new Response(null, { status: 403 });
    await expect(uploadChannelFile(api, { serverId: S, channelId: C }, { name: "a", type: "", bytes: bytes("x") }, put)).rejects.toMatchObject({ code: "upload_failed" });
    expect(calls).toHaveLength(1);
  });

  it("rejects empty and oversize files before asking for an upload", async () => {
    const { api, calls } = apiWith(() => ({}));
    const put = async () => new Response(null, { status: 200 });
    await expect(uploadChannelFile(api, { serverId: S, channelId: C }, { name: "a", type: "", bytes: bytes("") }, put)).rejects.toMatchObject({ code: "empty" });
    const big = { length: MAX_PLAIN_BYTES + 1 } as Uint8Array<ArrayBuffer>;
    await expect(uploadChannelFile(api, { serverId: S, channelId: C }, { name: "a", type: "", bytes: big }, put)).rejects.toMatchObject({ code: "too_big" });
    expect(calls).toHaveLength(0);
  });
});

describe("downloadAttachment", () => {
  it("fetches the signed link and decrypts", async () => {
    const enc = await encryptFile(bytes("the file"));
    const { api } = apiWith(() => ({ url: "https://files.example.test/x?sig=1", expiresAt: 1 }));
    const get = async (url: string) => {
      expect(url).toBe("https://files.example.test/x?sig=1");
      return new Response(enc.cipher);
    };
    const out = await downloadAttachment(api, { id: FILE, key: enc.key, nonce: enc.nonce, name: "f", mime: "x/y", size: 8 }, get);
    expect(new TextDecoder().decode(out)).toBe("the file");
  });
});
