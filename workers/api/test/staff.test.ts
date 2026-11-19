import { newId } from "@bastion/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { advanceAgeBands, recordAgeSignal } from "../src/safety/account.js";
import { FlagReader } from "../src/safety/flags.js";
import { cloudflareAccessAuth } from "../src/safety/staff-auth.js";
import { handleStaff } from "../src/safety/staff-routes.js";
import { createTestD1 } from "./d1.js";

const TEAM = "bastion.cloudflareaccess.com";
const AUD = "aud-tag-123";

let db: D1Database;
let flags: FlagReader;
let now: number;
let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string };
let changed: { userId: string; state: string }[];
let reportHolds: [string, string, boolean][];

const enc = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(claims: Record<string, unknown>, kid = "k1", key = privateKey) {
  const head = enc({ alg: "RS256", kid });
  const payload = enc(claims);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${payload}`)));
  return `${head}.${payload}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

const goodClaims = () => ({ iss: `https://${TEAM}`, aud: [AUD], email: "Staff@Dreadforged.test", exp: Math.floor(now / 1000) + 600 });

const newPair = async () =>
  (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;

beforeAll(async () => {
  const pair = await newPair();
  privateKey = pair.privateKey;
  publicJwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "k1" };
});

beforeEach(() => {
  db = createTestD1();
  now = Date.UTC(2026, 10, 19, 12);
  flags = new FlagReader(db, () => now);
  changed = [];
  reportHolds = [];
});

const auth = (extra: { allowedEmails?: string[] } = {}) =>
  cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, now: () => now, fetchKeys: async () => ({ keys: [publicJwk] }), ...extra });

describe("Cloudflare Access sign-in", () => {
  const withToken = (t: string | null) => new Request("https://api.test/staff", { headers: t ? { "cf-access-jwt-assertion": t } : {} });

  it("accepts a correctly signed token and returns the lowercased email", async () => {
    expect(await auth().authenticate(withToken(await sign(goodClaims())))).toBe("staff@dreadforged.test");
  });

  it("refuses a missing token, a bad signature, another audience, another issuer and an expired token", async () => {
    const a = auth();
    expect(await a.authenticate(withToken(null))).toBeNull();
    expect(await a.authenticate(withToken("a.b.c"))).toBeNull();
    const other = await newPair();
    expect(await a.authenticate(withToken(await sign(goodClaims(), "k1", other.privateKey)))).toBeNull();
    expect(await a.authenticate(withToken(await sign({ ...goodClaims(), aud: ["other"] })))).toBeNull();
    expect(await a.authenticate(withToken(await sign({ ...goodClaims(), iss: "https://evil.example" })))).toBeNull();
    expect(await a.authenticate(withToken(await sign({ ...goodClaims(), exp: Math.floor(now / 1000) - 3600 })))).toBeNull();
    expect(await a.authenticate(withToken(await sign(goodClaims(), "unknown-kid")))).toBeNull();
  });

  it("applies an optional email allowlist", async () => {
    const token = await sign(goodClaims());
    expect(await auth({ allowedEmails: ["someone@else.test"] }).authenticate(withToken(token))).toBeNull();
    expect(await auth({ allowedEmails: ["staff@dreadforged.test"] }).authenticate(withToken(token))).toBe("staff@dreadforged.test");
  });

  it("fails closed when the keys cannot be fetched", async () => {
    const a = cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, now: () => now, fetchKeys: async () => { throw new Error("down"); } });
    expect(await a.authenticate(withToken(await sign(goodClaims())))).toBeNull();
  });
});

async function user(overrides: Record<string, string | number | null> = {}) {
  const userId = newId();
  await db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(userId, `${userId.toLowerCase()}@test`, now).run();
  for (const [col, val] of Object.entries(overrides)) await db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).bind(val, userId).run();
  return userId;
}

async function staffCall(method: string, path: string, opts: { body?: unknown; token?: string | null; header?: boolean; configured?: boolean } = {}) {
  const token = opts.token === undefined ? await sign(goodClaims()) : opts.token;
  const headers: Record<string, string> = {};
  if (token) headers["cf-access-jwt-assertion"] = token;
  if (opts.header !== false && method !== "GET") headers["x-staff-request"] = "1";
  const res = await handleStaff(
    new Request(`https://api.test${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) }),
    {
      db,
      staff: opts.configured === false ? undefined : auth(),
      flags,
      now: () => now,
      onAccountChange: async (userId, state) => { changed.push({ userId, state }); },
      setReportHold: async (serverId, reportId, held) => { reportHolds.push([serverId, reportId, held]); return true; },
    },
  );
  if (!res) throw new Error("unrouted");
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: type.includes("json") && text ? JSON.parse(text) : text, headers: res.headers };
}

const logFor = async (subjectId: string) =>
  (await db.prepare("SELECT staff_id, kind, action FROM staff_access_log WHERE subject_id = ? ORDER BY at, rowid").bind(subjectId).all<{ staff_id: string; kind: string; action: string }>()).results;

describe("staff routes: access", () => {
  it("ignores other paths and answers 404 when staff access is not configured", async () => {
    expect(await handleStaff(new Request("https://api.test/servers"), { db, staff: undefined, flags, now: () => now })).toBeNull();
    expect((await staffCall("GET", "/staff/accounts", { configured: false })).status).toBe(404);
    expect((await staffCall("GET", "/staff", { configured: false })).status).toBe(404);
  });

  it("refuses requests without a valid Access token", async () => {
    expect((await staffCall("GET", "/staff/accounts", { token: null })).status).toBe(401);
    expect((await staffCall("GET", "/staff/accounts", { token: "x.y.z" })).status).toBe(401);
  });

  it("refuses a change without the staff header", async () => {
    const id = await user();
    const res = await staffCall("PUT", `/staff/accounts/${id}/state`, { body: { state: "suspended", reasonCode: "spam" }, header: false });
    expect(res).toMatchObject({ status: 403, body: { error: "missing_staff_header" } });
    expect((await db.prepare("SELECT account_state FROM users WHERE id = ?").bind(id).first<{ account_state: string }>())!.account_state).toBe("active");
  });

  it("serves the page with a nonce based CSP", async () => {
    const res = await staffCall("GET", "/staff");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(res.body).toContain(`nonce="${nonce}"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("staff routes: accounts and age reviews", () => {
  it("lists flagged accounts without emails and logs the view", async () => {
    const flagged = await user({ account_state: "pending_age_review", state_reason: "underage", age_band: "18plus" });
    await user();
    const list = await staffCall("GET", "/staff/accounts");
    expect(list.status).toBe(200);
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([flagged]);
    expect(JSON.stringify(list.body)).not.toContain("@test");
    expect(await logFor("flagged")).toEqual([{ staff_id: "staff@dreadforged.test", kind: "view", action: "accounts.list" }]);
  });

  it("includes active accounts carrying live signals and filters by state", async () => {
    const id = await user({ age_band: "18plus" });
    await recordAgeSignal(db, flags, id, "reported_underage", now);
    expect((await staffCall("GET", "/staff/accounts")).body.map((a: { id: string; signalWeight: number }) => [a.id, a.signalWeight])).toEqual([[id, 2]]);
    expect((await staffCall("GET", "/staff/accounts?state=restricted")).body).toEqual([]);
    expect((await staffCall("GET", "/staff/accounts?state=bogus")).status).toBe(400);
  });

  it("shows one account with signals and holds, and logs the view", async () => {
    const id = await user({ age_band: "18plus" });
    await recordAgeSignal(db, flags, id, "moderator_flag", now);
    const detail = await staffCall("GET", `/staff/accounts/${id}`);
    expect(detail.body).toMatchObject({ id, accountState: "active", signals: [{ kind: "moderator_flag", weight: 3 }], holds: [], held: false });
    expect(await logFor(id)).toEqual([{ staff_id: "staff@dreadforged.test", kind: "view", action: "account.view" }]);
    expect((await staffCall("GET", `/staff/accounts/${newId()}`)).status).toBe(404);
  });

  it("sets a state with a reason code, logs it and tells the Worker", async () => {
    const id = await user();
    expect((await staffCall("PUT", `/staff/accounts/${id}/state`, { body: { state: "suspended", reasonCode: "harassment" } })).status).toBe(200);
    expect(await db.prepare("SELECT account_state, state_reason FROM users WHERE id = ?").bind(id).first()).toEqual({ account_state: "suspended", state_reason: "harassment" });
    expect(changed).toEqual([{ userId: id, state: "suspended" }]);
    expect(await logFor(id)).toEqual([{ staff_id: "staff@dreadforged.test", kind: "change", action: "account.state.suspended" }]);
    expect((await staffCall("PUT", `/staff/accounts/${id}/state`, { body: { state: "suspended" } })).status).toBe(400);
  });

  it("clears an age review: verified adult, active again, later signals ignored", async () => {
    const id = await user({ age_band: "18plus", age_method: "declared" });
    for (const kind of ["declaration_conflict"] as const) await recordAgeSignal(db, flags, id, kind, now);
    expect((await db.prepare("SELECT account_state FROM users WHERE id = ?").bind(id).first<{ account_state: string }>())!.account_state).toBe("pending_age_review");

    expect((await staffCall("POST", `/staff/accounts/${id}/age-review`, { body: { outcome: "cleared" } })).status).toBe(200);
    expect(await db.prepare("SELECT account_state, age_method, age_band FROM users WHERE id = ?").bind(id).first()).toEqual({ account_state: "active", age_method: "verified", age_band: "18plus" });
    await recordAgeSignal(db, flags, id, "declaration_conflict", now);
    expect((await db.prepare("SELECT account_state FROM users WHERE id = ?").bind(id).first<{ account_state: string }>())!.account_state).toBe("active");
    expect(changed.at(-1)).toEqual({ userId: id, state: "active" });
  });

  it("restricts or removes after a review, and only works on accounts under review", async () => {
    const a = await user({ account_state: "pending_age_review" });
    const b = await user({ account_state: "pending_age_review" });
    const c = await user();
    expect((await staffCall("POST", `/staff/accounts/${a}/age-review`, { body: { outcome: "restrict" } })).status).toBe(200);
    expect((await staffCall("POST", `/staff/accounts/${b}/age-review`, { body: { outcome: "remove" } })).status).toBe(200);
    expect((await staffCall("POST", `/staff/accounts/${c}/age-review`, { body: { outcome: "remove" } })).status).toBe(409);
    expect((await db.prepare("SELECT account_state FROM users WHERE id = ?").bind(a).first<{ account_state: string }>())!.account_state).toBe("restricted");
    expect((await db.prepare("SELECT account_state FROM users WHERE id = ?").bind(b).first<{ account_state: string }>())!.account_state).toBe("underage_removed");
    expect(changed.map((x) => x.state)).toEqual(["restricted", "underage_removed"]);
  });

  it("agrees with the hourly band advance: a review does not undo itself", async () => {
    const id = await user({ account_state: "pending_age_review", age_band: "16to17", age_band_until: now - 1 });
    await advanceAgeBands(db, flags, now);
    expect((await db.prepare("SELECT account_state FROM users WHERE id = ?").bind(id).first<{ account_state: string }>())!.account_state).toBe("pending_age_review");
  });
});

describe("staff routes: flags, holds and the log", () => {
  it("sets a region flag, validates it, resets the cache and logs it", async () => {
    const set = (config: Record<string, unknown>) =>
      staffCall("PUT", "/staff/flags", { body: { module: "age", region: "US", enabled: true, config } });
    expect((await set({ minAge: 13 })).status).toBe(200);
    expect((await flags.get("age", ["US", "default"])).config.minAge).toBe(13);
    expect((await set({ nonsense: 1 })).status).toBe(400);
    const list = await staffCall("GET", "/staff/flags");
    expect(list.body).toEqual([expect.objectContaining({ module: "age", region: "US", enabled: true, config: expect.objectContaining({ minAge: 13 }), updatedBy: "staff@dreadforged.test" })]);
    expect((await logFor("age:US")).map((l) => l.action)).toEqual(["flag.set"]);
  });

  it("places and releases an account hold, which account deletion will respect", async () => {
    const id = await user();
    const placed = await staffCall("POST", "/staff/holds", { body: { subjectType: "account", subjectId: id, reasonCode: "child_safety", reference: "case-1" } });
    expect(placed.status).toBe(201);
    expect((await staffCall("GET", `/staff/accounts/${id}`)).body).toMatchObject({ held: true, holds: [{ id: placed.body.id, reference: "case-1" }] });
    expect((await staffCall("DELETE", `/staff/holds/${placed.body.id}`)).status).toBe(200);
    expect((await staffCall("GET", `/staff/accounts/${id}`)).body.held).toBe(false);
    expect((await staffCall("DELETE", `/staff/holds/${placed.body.id}`)).status).toBe(404);
    expect((await logFor(id)).filter((l) => l.kind === "change").map((l) => l.action)).toEqual(["hold.place", "hold.release"]);
  });

  it("keeps a report out of the retention sweep until its last hold is released", async () => {
    const server = newId();
    const report = newId();
    const place = () => staffCall("POST", "/staff/holds", { body: { subjectType: "report", subjectId: report, serverId: server, reasonCode: "illegal_content" } });
    expect((await staffCall("POST", "/staff/holds", { body: { subjectType: "report", subjectId: report, reasonCode: "illegal_content" } })).status).toBe(400);
    const a = await place();
    const b = await place();
    expect(reportHolds).toEqual([[server, report, true], [server, report, true]]);
    await staffCall("DELETE", `/staff/holds/${a.body.id}`);
    expect(reportHolds.at(-1)).toEqual([server, report, true]); // still held by b: no release
    expect(reportHolds).toHaveLength(2);
    await staffCall("DELETE", `/staff/holds/${b.body.id}`);
    expect(reportHolds.at(-1)).toEqual([server, report, false]);
  });

  it("shows the staff access log for a subject, and logs that view", async () => {
    const id = await user();
    await staffCall("PUT", `/staff/accounts/${id}/state`, { body: { state: "restricted", reasonCode: "underage" } });
    const log = await staffCall("GET", `/staff/log?subjectType=account&subjectId=${id}`);
    expect(log.body).toContainEqual(expect.objectContaining({ staffId: "staff@dreadforged.test", kind: "change", action: "account.state.restricted", reasonCode: "underage" }));
    expect((await logFor(id)).map((l) => l.action)).toContain("log.view");
    expect((await staffCall("GET", "/staff/log")).status).toBe(400);
  });
});
