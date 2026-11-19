import { describe, expect, it, vi } from "vitest";
import { AuthClient, tokenFromHash } from "../src/lib/auth.js";
import { Api, ApiError, MemoryTokenStore } from "../src/lib/http.js";

const tokens = (access: string, expires: number) => ({
  accessToken: access.padEnd(43, "x"),
  accessExpiresAt: expires,
  refreshToken: "r".repeat(43),
  refreshExpiresAt: expires + 1e6,
});
const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status });

describe("Api", () => {
  it("sends the bearer token and idempotency key", async () => {
    const fetch = vi.fn(async () => json(200, { ok: true }));
    const api = new Api({ baseUrl: "http://h", store: new MemoryTokenStore(tokens("a", Date.now() + 1e6)), fetch });
    await api.post("/servers", { name: "x" }, { idempotencyKey: "key-12345678" });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${"a".padEnd(43, "x")}`);
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("key-12345678");
  });

  it("refreshes once for many concurrent requests when the token is about to lapse", async () => {
    let refreshes = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/refresh")) {
        refreshes++;
        return json(200, tokens("fresh", Date.now() + 1e6));
      }
      return json(200, []);
    });
    const api = new Api({ baseUrl: "http://h", store: new MemoryTokenStore(tokens("old", Date.now() + 1000)), fetch });
    await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);
    expect(refreshes).toBe(1);
    expect(api.tokens!.accessToken).toBe("fresh".padEnd(43, "x"));
  });

  it("retries once after a 401 using a refreshed token", async () => {
    let first = true;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/auth/refresh")) return json(200, tokens("new", Date.now() + 1e6));
      if (first) {
        first = false;
        return json(401, { error: "invalid_token" });
      }
      return json(200, { auth: (init?.headers as Record<string, string>)["authorization"] });
    });
    const api = new Api({ baseUrl: "http://h", store: new MemoryTokenStore(tokens("old", Date.now() + 1e6)), fetch });
    expect(await api.get<{ auth: string }>("/x")).toEqual({ auth: `Bearer ${"new".padEnd(43, "x")}` });
  });

  it("signs out when the refresh token is refused, but not on a server error", async () => {
    const onSignedOut = vi.fn();
    const store = new MemoryTokenStore(tokens("old", Date.now() + 1000));
    let status = 503;
    const fetch = vi.fn(async (url: string | URL | Request) => (String(url).endsWith("/auth/refresh") ? json(status, { error: "x" }) : json(200, [])));
    const api = new Api({ baseUrl: "http://h", store, fetch, onSignedOut });
    await api.get("/a");
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(store.load()).not.toBeNull();
    status = 401;
    await api.get("/a");
    expect(onSignedOut).toHaveBeenCalledOnce();
    expect(store.load()).toBeNull();
  });

  it("throws ApiError with the code and body from the server", async () => {
    const api = new Api({ baseUrl: "http://h", store: new MemoryTokenStore(), fetch: async () => json(409, { error: "already_exists", id: "abc" }) });
    const err = await api.post("/conversations", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "already_exists", body: { id: "abc" } });
  });

  it("returns undefined for 204", async () => {
    const api = new Api({ baseUrl: "http://h", store: new MemoryTokenStore(tokens("a", Date.now() + 1e6)), fetch: async () => json(204, null) });
    expect(await api.delete("/x")).toBeUndefined();
  });
});

describe("AuthClient", () => {
  it("registers a passkey from an emailed token and stores the session", async () => {
    const calls: string[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url), "http://h").pathname;
      calls.push(path);
      if (path.endsWith("/register/options")) return json(200, { challenge: "c" });
      expect(JSON.parse(String(init!.body))).toMatchObject({ token: "t".repeat(43), deviceName: "Laptop", response: { id: "cred" } });
      return json(201, { tokens: tokens("new", Date.now() + 1e6), recoveryCode: "AAAAA-BBBBB-CCCCC-DDDDD" });
    };
    const store = new MemoryTokenStore();
    const auth = new AuthClient(new Api({ baseUrl: "", store, fetch }), { create: async () => ({ id: "cred" }), get: async () => ({}) });
    const result = await auth.register("t".repeat(43), "Laptop");
    expect(result.recoveryCode).toBe("AAAAA-BBBBB-CCCCC-DDDDD");
    expect(store.load()).not.toBeNull();
    expect(calls).toEqual(["/auth/passkeys/register/options", "/auth/passkeys/register"]);
  });

  it("signs in with a passkey assertion", async () => {
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/signin/options")) return json(200, { challengeId: "ch", options: { challenge: "c" } });
      expect(JSON.parse(String(init!.body))).toEqual({ challengeId: "ch", response: { id: "cred" } });
      return json(200, tokens("signed", Date.now() + 1e6));
    };
    const store = new MemoryTokenStore();
    const auth = new AuthClient(new Api({ baseUrl: "", store, fetch }), { create: async () => ({}), get: async () => ({ id: "cred" }) });
    await auth.signIn();
    expect(store.load()!.accessToken).toBe("signed".padEnd(43, "x"));
  });

  it("clears tokens on sign-out even if the request fails", async () => {
    const store = new MemoryTokenStore(tokens("a", Date.now() + 1e6));
    const auth = new AuthClient(new Api({ baseUrl: "", store, fetch: async () => json(500, { error: "x" }) }));
    await auth.signOut().catch(() => undefined);
    expect(store.load()).toBeNull();
  });

  it("reads the enrollment token from the URL fragment", () => {
    const t = "A".repeat(43);
    expect(tokenFromHash(`#token=${t}`)).toBe(t);
    expect(tokenFromHash("#token=short")).toBeNull();
    expect(tokenFromHash("")).toBeNull();
  });
});
