import { newId, schemas } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken, newToken } from "../src/auth/crypto.js";
import { authenticate } from "../src/auth/sessions.js";
import { advanceAgeBands, applyVerifiedAge, ageInYears, declareAge, getSafety, recordAgeSignal } from "../src/safety/account.js";
import { FlagReader, regionChain, setFlag } from "../src/safety/flags.js";
import { assertNotHeld, isHeld, placeHold, releaseHold } from "../src/safety/holds.js";
import { handleSafety } from "../src/safety/routes.js";
import { setAccountState } from "../src/safety/staff.js";
import { createTestD1 } from "./d1.js";

let db: D1Database;
let flags: FlagReader;
let now: number;
const STAFF = "staff-1";

beforeEach(() => {
  db = createTestD1();
  now = Date.UTC(2026, 10, 19, 12);
  flags = new FlagReader(db, () => now);
});

interface Session {
  userId: string;
  token: string;
}

async function signedIn(): Promise<Session> {
  const userId = newId();
  const deviceId = newId();
  const token = newToken();
  await db.prepare("INSERT INTO users (id, email, recovery_hash, created_at) VALUES (?, ?, 'hash', ?)").bind(userId, `${userId.toLowerCase()}@test`, now).run();
  await db
    .prepare("INSERT INTO devices (id, user_id, name, credential_id, public_key, created_at) VALUES (?, ?, 'Laptop', ?, 'pk', ?)")
    .bind(deviceId, userId, `cred-${deviceId}`, now)
    .run();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId(), userId, deviceId, await hashToken(token), now + 3_600_000, await hashToken(newToken()), now + 86_400_000, now)
    .run();
  return { userId, token };
}

async function call(method: string, path: string, as: Session | null, body?: unknown, headers: Record<string, string> = {}) {
  const request = new Request(`https://api.test${path}`, {
    method,
    headers: { ...(as ? { authorization: `Bearer ${as.token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handleSafety(request, { db, flags, now: () => now });
  if (!res) throw new Error("unrouted");
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A birth month `years` full years and `extraMonths` months before now (at the end of that month). */
function birth(years: number, extraMonths = 2) {
  const d = new Date(now);
  const idx = d.getUTCFullYear() * 12 + d.getUTCMonth() - years * 12 - extraMonths;
  return { birthYear: Math.floor(idx / 12), birthMonth: (idx % 12) + 1 };
}

describe("regions", () => {
  it("lists the most specific region first and always ends in default", () => {
    expect(regionChain(null)).toEqual(["default"]);
    expect(regionChain("US")).toEqual(["US", "default"]);
    expect(regionChain("US", "TX")).toEqual(["US-TX", "US", "default"]);
    expect(regionChain("DE")).toEqual(["DE", "EU", "EEA", "default"]);
    expect(regionChain("NO")).toEqual(["NO", "EEA", "default"]);
    expect(regionChain("zz")).toEqual(["default"]);
  });
});

describe("flags", () => {
  it("fall back to built in defaults when nothing is set", async () => {
    const age = await flags.get("age", ["default"]);
    expect(age).toMatchObject({ enabled: true, region: "builtin", config: { minAge: 18, assurance: "declared", ageRestrictedChannels: false } });
  });

  it("use the most specific region that has a value", async () => {
    await setFlag(db, STAFF, "age", "default", { enabled: true, config: { minAge: 18 } }, now);
    await setFlag(db, STAFF, "age", "EU", { enabled: true, config: { minAge: 16 } }, now);
    await setFlag(db, STAFF, "age", "DE", { enabled: true, config: { minAge: 17 } }, now);
    expect((await flags.get("age", regionChain("DE"))).config.minAge).toBe(17);
    expect((await flags.get("age", regionChain("FR"))).config.minAge).toBe(16);
    expect((await flags.get("age", regionChain("US"))).config.minAge).toBe(18);
  });

  it("are cached for a minute, and a change shows after that or after invalidate", async () => {
    await flags.get("age", ["default"]);
    await setFlag(db, STAFF, "age", "default", { enabled: true, config: { minAge: 16 } }, now);
    expect((await flags.get("age", ["default"])).config.minAge).toBe(18);
    now += 61_000;
    expect((await flags.get("age", ["default"])).config.minAge).toBe(16);
    await setFlag(db, STAFF, "age", "default", { enabled: true, config: { minAge: 13 } }, now);
    flags.invalidate();
    expect((await flags.get("age", ["default"])).config.minAge).toBe(13);
  });

  it("reject bad modules, regions and config, and write nothing", async () => {
    await expect(setFlag(db, STAFF, "nope" as never, "default", { enabled: true }, now)).rejects.toMatchObject({ code: "unknown_module" });
    await expect(setFlag(db, STAFF, "age", "mars", { enabled: true }, now)).rejects.toMatchObject({ code: "invalid_region" });
    await expect(setFlag(db, STAFF, "age", "default", { enabled: true, config: { minAge: 5 } }, now)).rejects.toMatchObject({ code: "invalid_config" });
    await expect(setFlag(db, STAFF, "age", "default", { enabled: true, config: { surprise: true } }, now)).rejects.toMatchObject({ code: "invalid_config" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM safety_flags").first<{ n: number }>())!.n).toBe(0);
  });

  it("keep a history and a staff log entry for every change", async () => {
    await setFlag(db, STAFF, "age", "EU", { enabled: true, config: { minAge: 16 } }, now);
    await setFlag(db, STAFF, "age", "EU", { enabled: false }, now + 1);
    const log = await db.prepare("SELECT enabled, changed_by FROM safety_flag_log ORDER BY changed_at").all<{ enabled: number; changed_by: string }>();
    expect(log.results).toEqual([
      { enabled: 1, changed_by: STAFF },
      { enabled: 0, changed_by: STAFF },
    ]);
    const staff = await db.prepare("SELECT action, subject_id FROM staff_access_log").all<{ action: string; subject_id: string }>();
    expect(staff.results).toEqual([
      { action: "flag.set", subject_id: "age:EU" },
      { action: "flag.set", subject_id: "age:EU" },
    ]);
  });

  it("fall back to defaults when a stored config no longer parses", async () => {
    await db.prepare("INSERT INTO safety_flags (module, region, enabled, config, updated_by, updated_at) VALUES ('age', 'default', 1, '{\"minAge\":3}', 's', 0)").run();
    expect((await flags.get("age", ["default"])).config.minAge).toBe(18);
  });
});

describe("age arithmetic", () => {
  it("rounds down and assumes the last day of the birth month", () => {
    // Born March 2013: on 19 Nov 2026 that is 13 years 8 months.
    expect(ageInYears(2013, 3, now)).toBe(13);
    // Born November 2013: could have turned 13 on 30 November, so not yet counted.
    expect(ageInYears(2013, 11, now)).toBe(12);
    // Born December 2013: certainly 12.
    expect(ageInYears(2013, 12, now)).toBe(12);
    expect(() => ageInYears(2027, 1, now)).toThrow();
  });
});

describe("declaring an age", () => {
  it("keeps only the band and when it ends, never the birth date", async () => {
    const me = await signedIn();
    const before = await call("GET", "/account/safety", me);
    expect(before.body).toMatchObject({ ageBand: "unknown", ageDeclarationRequired: true, accountState: "active", minAge: 18 });

    const { status, body } = await call("PUT", "/account/age", me, { ...birth(30), country: "US" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ageBand: "18plus", ageMethod: "declared", ageBandUntil: null, accountState: "active", country: "US", ageDeclarationRequired: false });

    const columns = (await db.prepare("PRAGMA table_info(users)").all<{ name: string }>()).results.map((c) => c.name);
    expect(columns.some((c) => /birth|dob/i.test(c))).toBe(false);
  });

  it("restricts someone below the region minimum and records when the band ends", async () => {
    const me = await signedIn();
    const { body } = await call("PUT", "/account/age", me, birth(15, 2));
    expect(body).toMatchObject({ ageBand: "13to15", accountState: "restricted" });
    // Born about 15 years 2 months ago: turns 16 about 10 months from now, at the start of the month after.
    expect(new Date(body.ageBandUntil).getUTCDate()).toBe(1);
    expect(body.ageBandUntil).toBeGreaterThan(now);
  });

  it("is lifted by a lower regional minimum", async () => {
    await setFlag(db, STAFF, "age", "default", { enabled: true, config: { minAge: 13 } }, now);
    const me = await signedIn();
    expect((await call("PUT", "/account/age", me, birth(14))).body).toMatchObject({ ageBand: "13to15", accountState: "active", minAge: 13 });
  });

  it("refuses under 13, removes the account, and blocks its token", async () => {
    const me = await signedIn();
    const res = await call("PUT", "/account/age", me, birth(11));
    expect(res).toEqual({ status: 403, body: { error: "underage" } });
    expect((await db.prepare("SELECT account_state, age_band FROM users WHERE id = ?").bind(me.userId).first())).toEqual({ account_state: "underage_removed", age_band: "unknown" });
    // The next request with the same token is refused everywhere.
    expect(await call("GET", "/account/safety", me)).toEqual({ status: 403, body: { error: "account_blocked" } });
  });

  it("does not let a retry change the answer upward", async () => {
    const me = await signedIn();
    await call("PUT", "/account/age", me, birth(30));
    // A different, older answer later is ignored.
    expect((await call("PUT", "/account/age", me, birth(40))).status).toBe(409);
    expect((await call("GET", "/account/safety", me)).body.ageBand).toBe("18plus");
  });

  it("treats declaring younger after claiming adult as a strong signal and sends the account to review", async () => {
    const me = await signedIn();
    await call("PUT", "/account/age", me, birth(30));
    const second = await call("PUT", "/account/age", me, birth(15));
    expect(second.body).toMatchObject({ ageBand: "13to15", accountState: "pending_age_review" });
  });

  it("limits how often it can be tried", async () => {
    const me = await signedIn();
    for (let i = 0; i < 5; i++) await call("PUT", "/account/age", me, birth(30));
    expect((await call("PUT", "/account/age", me, birth(30))).status).toBe(429);
  });

  it("reads the country code from the connection but never the address", async () => {
    const me = await signedIn();
    const res = await call("PUT", "/account/age", me, birth(30), { "cf-ipcountry": "DE", "cf-connecting-ip": "203.0.113.9" });
    expect(res.body.country).toBe("DE");
    const dump = JSON.stringify(await db.prepare("SELECT * FROM users").all());
    expect(dump).not.toContain("203.0.113.9");
  });

  it("notes a mismatch between the declared and the connection country as a weak signal", async () => {
    const me = await signedIn();
    await call("PUT", "/account/age", me, { ...birth(30), country: "US" }, { "cf-ipcountry": "DE" });
    const signals = await db.prepare("SELECT kind FROM age_signals WHERE user_id = ?").bind(me.userId).all<{ kind: string }>();
    expect(signals.results).toEqual([{ kind: "country_mismatch" }]);
  });

  it("rejects malformed input", async () => {
    const me = await signedIn();
    expect((await call("PUT", "/account/age", me, { birthYear: 1990 })).status).toBe(400);
    expect((await call("PUT", "/account/age", me, { birthYear: 1990, birthMonth: 13 })).status).toBe(400);
    expect((await call("PUT", "/account/age", me, { birthYear: 2090, birthMonth: 1 })).status).toBe(400);
    expect((await call("PUT", "/account/age", null, birth(30))).status).toBe(401);
  });
});

describe("age signals, for children who say they are older", () => {
  it("add up to an age review, and a verified age is not overridden by them", async () => {
    const me = await signedIn();
    await call("PUT", "/account/age", me, birth(30));
    expect(await recordAgeSignal(db, flags, me.userId, "reported_underage", now)).toBe("active");
    expect(await recordAgeSignal(db, flags, me.userId, "reported_underage", now)).toBe("active");
    // 2 + 2 + 1 reaches the default threshold of 5.
    expect(await recordAgeSignal(db, flags, me.userId, "country_mismatch", now)).toBe("pending_age_review");

    const other = await signedIn();
    await applyVerifiedAge(db, flags, other.userId, "18plus", null, "verified", now);
    for (let i = 0; i < 4; i++) await recordAgeSignal(db, flags, other.userId, "moderator_flag", now);
    expect((await getSafety(db, flags, other.userId)).accountState).toBe("active");
  });

  it("expire after six months", async () => {
    const me = await signedIn();
    await call("PUT", "/account/age", me, birth(30));
    await recordAgeSignal(db, flags, me.userId, "reported_underage", now);
    await recordAgeSignal(db, flags, me.userId, "reported_underage", now);
    now += 181 * 24 * 3_600_000;
    expect(await recordAgeSignal(db, flags, me.userId, "country_mismatch", now)).toBe("active");
  });

  it("use the region's threshold", async () => {
    await setFlag(db, STAFF, "age", "default", { enabled: true, config: { reviewThreshold: 2 } }, now);
    const me = await signedIn();
    expect(await recordAgeSignal(db, flags, me.userId, "reported_underage", now)).toBe("pending_age_review");
  });

  it("end with a stronger check, which can also confirm the person is below the minimum", async () => {
    const adult = await signedIn();
    await recordAgeSignal(db, flags, adult.userId, "moderator_flag", now);
    await recordAgeSignal(db, flags, adult.userId, "moderator_flag", now);
    expect((await getSafety(db, flags, adult.userId)).accountState).toBe("pending_age_review");
    expect(await applyVerifiedAge(db, flags, adult.userId, "18plus", null, "estimated", now)).toMatchObject({ accountState: "active", ageMethod: "estimated" });

    const teen = await signedIn();
    await recordAgeSignal(db, flags, teen.userId, "moderator_flag", now);
    await recordAgeSignal(db, flags, teen.userId, "moderator_flag", now);
    expect(await applyVerifiedAge(db, flags, teen.userId, "16to17", Date.UTC(2027, 3, 1), "verified", now)).toMatchObject({ accountState: "restricted", ageBand: "16to17" });
  });

  it("do not let a weaker method replace a stronger one", async () => {
    const me = await signedIn();
    await applyVerifiedAge(db, flags, me.userId, "18plus", null, "verified", now);
    await expect(applyVerifiedAge(db, flags, me.userId, "13to15", null, "estimated", now)).rejects.toMatchObject({ code: "weaker_method" });
    expect((await call("PUT", "/account/age", me, birth(15))).status).toBe(409);
  });

  it("are recorded without reading anything: only a kind, a weight and a date", async () => {
    const me = await signedIn();
    await recordAgeSignal(db, flags, me.userId, "reported_underage", now);
    const columns = (await db.prepare("PRAGMA table_info(age_signals)").all<{ name: string }>()).results.map((c) => c.name);
    expect(columns).toEqual(["id", "user_id", "kind", "weight", "created_at", "expires_at"]);
  });
});

describe("age bands over time", () => {
  it("move up when the month passes, then lift the restriction at the minimum age", async () => {
    await setFlag(db, STAFF, "age", "default", { enabled: true, config: { minAge: 16 } }, now);
    const me = await signedIn();
    const declared = (await call("PUT", "/account/age", me, birth(15, 2))).body;
    expect(declared).toMatchObject({ ageBand: "13to15", accountState: "restricted" });

    expect(await advanceAgeBands(db, flags, declared.ageBandUntil - 1)).toBe(0);
    now = declared.ageBandUntil + 1;
    flags.invalidate();
    expect(await advanceAgeBands(db, flags, now)).toBe(1);
    expect(await getSafety(db, flags, me.userId)).toMatchObject({ ageBand: "16to17", accountState: "active" });

    const next = (await getSafety(db, flags, me.userId)).ageBandUntil!;
    expect(new Date(next).getUTCFullYear()).toBe(new Date(declared.ageBandUntil).getUTCFullYear() + 2);
    now = next + 1;
    await advanceAgeBands(db, flags, now);
    expect(await getSafety(db, flags, me.userId)).toMatchObject({ ageBand: "18plus", ageBandUntil: null });
  });
});

describe("account states", () => {
  it("block a staff suspended account from every route, with a staff log entry", async () => {
    const me = await signedIn();
    expect(await authenticate(db, new Request("https://x", { headers: { authorization: `Bearer ${me.token}` } }), now)).toMatchObject({ userId: me.userId });
    await setAccountState(db, STAFF, me.userId, "suspended", "harassment", now);
    await expect(authenticate(db, new Request("https://x", { headers: { authorization: `Bearer ${me.token}` } }), now)).rejects.toMatchObject({ status: 403, code: "account_blocked" });
    const log = await db.prepare("SELECT staff_id, kind, action, subject_id, reason_code FROM staff_access_log").all();
    expect(log.results).toEqual([{ staff_id: STAFF, kind: "change", action: "account.state.suspended", subject_id: me.userId, reason_code: "harassment" }]);
  });

  it("keep restricted and pending review accounts able to read their own safety status", async () => {
    const me = await signedIn();
    await setAccountState(db, STAFF, me.userId, "pending_age_review", "underage", now);
    expect((await call("GET", "/account/safety", me)).body.accountState).toBe("pending_age_review");
  });

  it("say not found for an unknown account", async () => {
    await expect(setAccountState(db, STAFF, newId(), "suspended", "spam", now)).rejects.toMatchObject({ status: 404 });
  });
});

describe("terms acceptance", () => {
  it("lists documents not accepted at the current version, and clears them when accepted", async () => {
    await setFlag(db, STAFF, "legal", "default", { enabled: true, config: { terms: "2026-12-01", privacy: "2026-12-01", aup: "2026-12-01" } }, now);
    const me = await signedIn();
    expect((await call("GET", "/account/safety", me)).body.termsOutstanding).toHaveLength(3);

    for (const document of ["terms", "privacy", "aup"]) {
      await call("POST", "/account/terms", me, { document, version: "2026-12-01" });
    }
    expect((await call("GET", "/account/safety", me)).body.termsOutstanding).toEqual([]);

    // A new version needs a new acceptance; the old one stays on record.
    await setFlag(db, STAFF, "legal", "default", { enabled: true, config: { terms: "2027-03-01", privacy: "2026-12-01", aup: "2026-12-01" } }, now);
    flags.invalidate();
    expect((await call("GET", "/account/safety", me)).body.termsOutstanding).toEqual([{ document: "terms", version: "2027-03-01" }]);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM terms_acceptances WHERE user_id = ?").bind(me.userId).first<{ n: number }>();
    expect(rows!.n).toBe(3);
  });

  it("records an acceptance once and rejects bad documents", async () => {
    const me = await signedIn();
    await call("POST", "/account/terms", me, { document: "terms", version: "v1" });
    await call("POST", "/account/terms", me, { document: "terms", version: "v1" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM terms_acceptances").first<{ n: number }>())!.n).toBe(1);
    expect((await call("POST", "/account/terms", me, { document: "cookies", version: "v1" })).status).toBe(400);
  });
});

describe("client config", () => {
  it("gives the region's values and which modules are on", async () => {
    await setFlag(db, STAFF, "age", "DE", { enabled: true, config: { minAge: 16, assurance: "verified", ageRestrictedChannels: true } }, now);
    await setFlag(db, STAFF, "public_scan", "DE", { enabled: false }, now);
    const me = await signedIn();
    await call("PUT", "/account/age", me, { ...birth(30), country: "DE" });
    const { body } = await call("GET", "/safety/config", me);
    expect(body).toMatchObject({ region: "DE", minAge: 16, assurance: "verified", ageRestrictedChannels: true });
    expect(body.modules.public_scan).toBe(false);
    expect(body.modules.reports).toBe(true);
    expect(Object.keys(body.modules).sort()).toEqual([...schemas.SafetyModule.options].sort());
  });

  it("defaults to adults only with no age restricted channels", async () => {
    const me = await signedIn();
    expect((await call("GET", "/safety/config", me)).body).toMatchObject({ region: "default", minAge: 18, ageRestrictedChannels: false });
  });

  it("requires sign-in and ignores unknown paths", async () => {
    expect((await call("GET", "/safety/config", null)).status).toBe(401);
    expect((await call("GET", "/safety/staff", await signedIn())).status).toBe(404);
  });
});

describe("legal holds", () => {
  it("block deletion of the subject until released, and are logged", async () => {
    const id = await placeHold(db, STAFF, "account", "user-1", "child_safety", "case-42", now);
    expect(await isHeld(db, "account", "user-1")).toBe(true);
    expect(await isHeld(db, "account", "user-2")).toBe(false);
    expect(await isHeld(db, "file", "user-1")).toBe(false);
    await expect(assertNotHeld(db, "account", "user-1")).rejects.toMatchObject({ status: 409, code: "legal_hold" });

    await releaseHold(db, STAFF, id, now + 1);
    expect(await isHeld(db, "account", "user-1")).toBe(false);
    await assertNotHeld(db, "account", "user-1");
    await expect(releaseHold(db, STAFF, id, now + 2)).rejects.toMatchObject({ status: 404 });

    const log = await db.prepare("SELECT action, subject_type, subject_id FROM staff_access_log ORDER BY at, rowid").all();
    expect(log.results).toEqual([
      { action: "hold.place", subject_type: "account", subject_id: "user-1" },
      { action: "hold.release", subject_type: "account", subject_id: "user-1" },
    ]);
  });

  it("can stack, so a second hold keeps the subject held after the first is released", async () => {
    const a = await placeHold(db, STAFF, "server", "s1", "illegal_content", null, now);
    await placeHold(db, "staff-2", "server", "s1", "child_safety", "ref", now);
    await releaseHold(db, STAFF, a, now);
    expect(await isHeld(db, "server", "s1")).toBe(true);
  });
});

describe("the migration", () => {
  it("leaves existing accounts active with an unknown band", async () => {
    const me = await signedIn();
    expect(await db.prepare("SELECT age_band, account_state, country FROM users WHERE id = ?").bind(me.userId).first()).toEqual({
      age_band: "unknown",
      account_state: "active",
      country: null,
    });
  });
});
