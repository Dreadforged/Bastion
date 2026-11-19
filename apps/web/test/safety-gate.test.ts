import type { schemas } from "@bastion/shared";
import { describe, expect, it } from "vitest";
import { AuthClient } from "../src/lib/auth.js";
import { Controller } from "../src/lib/controller.js";
import { Api, MemoryTokenStore } from "../src/lib/http.js";
import { birthYears, gateFor } from "../src/lib/safety.js";

const base: schemas.AccountSafety = {
  ageBand: "18plus",
  ageMethod: "declared",
  ageBandUntil: null,
  accountState: "active",
  country: null,
  minAge: 18,
  ageDeclarationRequired: false,
  termsOutstanding: [],
};

describe("gateFor", () => {
  it("lets a normal account in", () => expect(gateFor(base)).toBeNull());
  it("blocks suspended and removed accounts", () => {
    expect(gateFor({ ...base, accountState: "suspended" })).toEqual({ kind: "blocked" });
    expect(gateFor({ ...base, accountState: "underage_removed" })).toEqual({ kind: "blocked" });
  });
  it("stops a restricted account and one under review", () => {
    expect(gateFor({ ...base, accountState: "restricted" })).toEqual({ kind: "too_young" });
    expect(gateFor({ ...base, accountState: "pending_age_review" })).toEqual({ kind: "review" });
  });
  it("asks for the age before the terms", () => {
    const terms = [{ document: "terms", version: "1" }];
    expect(gateFor({ ...base, ageBand: "unknown", ageDeclarationRequired: true, termsOutstanding: terms })).toEqual({ kind: "declare" });
    expect(gateFor({ ...base, termsOutstanding: terms })).toEqual({ kind: "terms", outstanding: terms });
  });
  it("offers a hundred years of birth years", () => {
    const years = birthYears(Date.UTC(2026, 5, 1));
    expect(years[0]).toBe(2026);
    expect(years).toHaveLength(101);
  });
});

function setup(responses: Record<string, () => Response>) {
  const calls: string[] = [];
  const api = new Api({
    baseUrl: "",
    store: new MemoryTokenStore({ accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 3_600_000 } as schemas.SessionTokens),
    fetch: async (input, init) => {
      const key = `${init?.method ?? "GET"} ${new URL(String(input), "http://h").pathname}`;
      calls.push(key);
      const r = responses[key];
      return r ? r() : new Response("[]");
    },
  });
  const sockets: unknown[] = [];
  const c = new Controller({
    api,
    auth: new AuthClient(api),
    createMls: () => { throw new Error("unused"); },
    gatewayUrl: "ws://h",
    createSocket: () => {
      const s = { readyState: 1, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
      sockets.push(s);
      return s as never;
    },
  });
  return { c, calls, sockets };
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body));
const fail = (status: number, error: string) => () => new Response(JSON.stringify({ error }), { status });

describe("Controller safety gate", () => {
  it("holds the app at the age screen and opens it after a declaration", async () => {
    const { c, calls, sockets } = setup({
      "GET /account/safety": ok({ ...base, ageBand: "unknown", ageDeclarationRequired: true }),
      "PUT /account/age": ok(base),
    });
    await c.connect();
    expect(c.getState().phase).toBe("safety-gate");
    expect(c.getState().gate).toEqual({ kind: "declare" });
    expect(sockets).toHaveLength(0);
    expect(calls).not.toContain("GET /auth/devices");
    await c.declareAge(1990, 4);
    expect(c.getState().gate).toBeNull();
    expect(calls).toContain("PUT /account/age");
    expect(sockets).toHaveLength(1);
  });

  it("sends only the month and year", async () => {
    let sent = "";
    const { c } = setup({
      "GET /account/safety": ok({ ...base, ageBand: "unknown", ageDeclarationRequired: true }),
      "PUT /account/age": () => new Response(JSON.stringify(base)),
    });
    const api = (c as unknown as { o: { api: Api } }).o.api;
    const orig = api.put.bind(api);
    api.put = ((p: string, b: unknown) => { sent = JSON.stringify(b); return orig(p, b as never); }) as typeof api.put;
    await c.connect();
    await c.declareAge(1990, 4);
    expect(JSON.parse(sent)).toEqual({ birthYear: 1990, birthMonth: 4 });
  });

  it("signs out and says why when the person is under 13", async () => {
    const { c, sockets } = setup({
      "GET /account/safety": ok({ ...base, ageBand: "unknown", ageDeclarationRequired: true }),
      "PUT /account/age": fail(403, "underage"),
    });
    await c.connect();
    await c.declareAge(2020, 1);
    expect(c.getState().phase).toBe("signed-out");
    expect(c.getState().error).toBe("underage");
    expect(sockets).toHaveLength(0);
  });

  it("keeps an under-18 account out of the app", async () => {
    const { c, sockets } = setup({
      "GET /account/safety": ok({ ...base, ageBand: "16to17", accountState: "restricted" }),
    });
    await c.connect();
    expect(c.getState().gate).toEqual({ kind: "too_young" });
    expect(sockets).toHaveLength(0);
  });

  it("accepts every outstanding document, then opens", async () => {
    const terms = [{ document: "terms", version: "1" }, { document: "privacy", version: "1" }];
    const { c, calls, sockets } = setup({
      "GET /account/safety": ok({ ...base, termsOutstanding: terms }),
      "POST /account/terms": ok(base),
    });
    await c.connect();
    expect(c.getState().gate?.kind).toBe("terms");
    await c.acceptTerms();
    expect(calls.filter((x) => x === "POST /account/terms")).toHaveLength(2);
    expect(sockets).toHaveLength(1);
  });

  it("signs a blocked account out with a clear error", async () => {
    const { c, sockets } = setup({ "GET /account/safety": ok({ ...base, accountState: "suspended" }) });
    await c.connect();
    expect(c.getState().phase).toBe("signed-out");
    expect(c.getState().error).toBe("account_blocked");
    expect(sockets).toHaveLength(0);
  });

  it("does not open the app when the safety record cannot be loaded", async () => {
    const { c, sockets } = setup({ "GET /account/safety": fail(403, "account_blocked") });
    await c.connect();
    expect(c.getState().phase).toBe("signed-out");
    expect(c.getState().error).toBe("account_blocked");
    expect(sockets).toHaveLength(0);
  });
});

describe("Controller.deleteAccount", () => {
  it("wipes the device after the server deletes the account", async () => {
    const { c, calls } = setup({ "DELETE /account": () => new Response(null, { status: 204 }) });
    const api = (c as unknown as { o: { api: Api } }).o.api;
    await c.deleteAccount().then((r) => expect(r).toBeNull());
    expect(calls).toContain("DELETE /account");
    expect(api.tokens).toBeNull();
    expect(c.getState().phase).toBe("signed-out");
  });

  it("keeps the session and returns the refusal when the server says no", async () => {
    for (const code of ["legal_hold", "owns_servers"]) {
      const { c } = setup({ "DELETE /account": fail(409, code) });
      const api = (c as unknown as { o: { api: Api } }).o.api;
      expect(await c.deleteAccount()).toBe(code);
      expect(api.tokens).not.toBeNull();
    }
  });
});

describe("Controller message requests", () => {
  const req = { conversationId: "AAAAAAAAAAAAAAAAAAAAAA", from: "01HZZZZZZZZZZZZZZZZZZZZZU2" };

  it("lists, accepts and declines through the API", async () => {
    const { c, calls } = setup({ "GET /conversations/requests": ok([req]), "POST /conversations/AAAAAAAAAAAAAAAAAAAAAA/accept": () => new Response(null, { status: 204 }), "POST /conversations/AAAAAAAAAAAAAAAAAAAAAA/decline": () => new Response(null, { status: 204 }) });
    expect(await c.messageRequests()).toEqual([req]);
    await c.acceptRequest(req);
    await c.declineRequest(req);
    expect(calls).toEqual(expect.arrayContaining(["POST /conversations/AAAAAAAAAAAAAAAAAAAAAA/accept", "POST /conversations/AAAAAAAAAAAAAAAAAAAAAA/decline"]));
    expect(c.getState().error).toBeNull();
  });

  it("shows the refusal when the server says no", async () => {
    const { c } = setup({ "POST /conversations/AAAAAAAAAAAAAAAAAAAAAA/accept": fail(404, "not_found") });
    await c.acceptRequest(req);
    expect(c.getState().error).toBe("not_found");
  });
});
