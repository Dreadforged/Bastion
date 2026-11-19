import { beforeEach, describe, expect, it } from "vitest";
import { cleanupExpired } from "../src/auth/devices.js";
import { StubEmailSender } from "../src/auth/email.js";
import type { Passkeys } from "../src/auth/passkeys.js";
import { handleAuth } from "../src/auth/routes.js";
import { createTestD1 } from "./d1.js";

/**
 * Stands in for real authenticators. A "passkey" here proves itself by echoing
 * the challenge in clientDataJSON and signing with signature "ok". The real
 * cryptographic checks live in SimpleWebAuthn and are not re-tested here.
 */
const fakePasskeys: Passkeys = {
  async registrationOptions(user) {
    return {
      challenge: crypto.randomUUID().replace(/-/g, ""),
      rp: { name: "test", id: "localhost" },
      user: { id: user.id, name: user.email, displayName: "" },
      pubKeyCredParams: [],
      excludeCredentials: user.exclude.map((id) => ({ id, type: "public-key" as const })),
    };
  },
  async verifyRegistration(response, challenge) {
    if (response.response.clientDataJSON !== challenge) return null;
    return { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 };
  },
  async authenticationOptions() {
    return { challenge: crypto.randomUUID().replace(/-/g, "") };
  },
  async verifyAuthentication(response, challenge, credential) {
    if (response.response.clientDataJSON !== challenge || response.response.signature !== "ok") return null;
    return { newCounter: credential.counter + 1 };
  },
};

let db: D1Database;
let email: StubEmailSender;
let now: number;
let ipAllowed: boolean;
/** Sessions whose gateway sockets the routes asked to close. */
let ended: { userId: string; sessionIds: string[] }[];

beforeEach(() => {
  db = createTestD1();
  email = new StubEmailSender();
  now = Date.UTC(2026, 10, 18);
  ipAllowed = true;
  ended = [];
});

async function userIdOf(address = "user@example.com") {
  return (await db.prepare("SELECT id FROM users WHERE email = ?").bind(address).first<{ id: string }>())!.id;
}

async function sessionIds(accessOrUser: { userId?: string; deviceId?: string }) {
  const { results } = await db
    .prepare("SELECT id FROM sessions WHERE (?1 IS NULL OR user_id = ?1) AND (?2 IS NULL OR device_id = ?2) ORDER BY id")
    .bind(accessOrUser.userId ?? null, accessOrUser.deviceId ?? null)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

const ipLimit = { limit: async () => ({ success: ipAllowed }) } as RateLimit;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.7" };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request(`https://api.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handleAuth(
    request,
    {
      db,
      email,
      passkeys: fakePasskeys,
      appOrigin: "https://app.test",
      now: () => now,
      endSessions: async (userId, sessionIds) => {
        ended.push({ userId, sessionIds });
      },
    },
    ipLimit,
  );
  if (!res) throw new Error(`unrouted ${method} ${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function lastLinkToken(): string {
  const match = email.sent.at(-1)?.text.match(/#token=([A-Za-z0-9_-]{43})/);
  if (!match) throw new Error("no link in last email");
  return match[1]!;
}

let credentialCounter = 0;

/** Run the passkey registration ceremony for an enrollment token. */
async function registerPasskey(token: string, deviceName = "Laptop") {
  const options = await call("POST", "/auth/passkeys/register/options", { token });
  if (options.status !== 200) return { ...options, credentialId: "" };
  const credentialId = `cred${++credentialCounter}`;
  const res = await call("POST", "/auth/passkeys/register", {
    token,
    deviceName,
    response: {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: { clientDataJSON: options.body.challenge, attestationObject: "abc" },
      clientExtensionResults: {},
    },
  });
  return { ...res, credentialId };
}

async function signUp(address = "user@example.com") {
  expect((await call("POST", "/auth/signup", { email: address })).status).toBe(202);
  const res = await registerPasskey(lastLinkToken());
  expect(res.status).toBe(201);
  return res;
}

async function signIn(credentialId: string, signature = "ok") {
  const options = await call("POST", "/auth/signin/options", {});
  const assertion = {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: { clientDataJSON: options.body.options.challenge, authenticatorData: "abc", signature },
    clientExtensionResults: {},
  };
  return call("POST", "/auth/signin", { challengeId: options.body.challengeId, response: assertion });
}

describe("sign-up", () => {
  it("emails a link, registers a passkey and returns a session and recovery code", async () => {
    const res = await signUp("  User@Example.com ");
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toBe("user@example.com");
    expect(res.body.recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);

    const devices = await call("GET", "/auth/devices", undefined, res.body.tokens.accessToken);
    expect(devices.status).toBe(200);
    expect(devices.body).toEqual([expect.objectContaining({ name: "Laptop", current: true })]);
  });

  it("stores only hashes of tokens and the recovery code", async () => {
    const res = await signUp();
    const dump = JSON.stringify([
      (await db.prepare("SELECT * FROM sessions").all()).results,
      (await db.prepare("SELECT * FROM users").all()).results,
    ]);
    expect(dump).not.toContain(res.body.tokens.accessToken);
    expect(dump).not.toContain(res.body.tokens.refreshToken);
    expect(dump).not.toContain(res.body.recoveryCode.replace(/-/g, ""));
    expect(dump).toContain("argon2id$");
  });

  it("only lets a link be used once", async () => {
    await call("POST", "/auth/signup", { email: "a@example.com" });
    const token = lastLinkToken();
    expect((await registerPasskey(token)).status).toBe(201);
    expect((await registerPasskey(token)).status).toBe(401);
  });

  it("rejects an expired link", async () => {
    await call("POST", "/auth/signup", { email: "a@example.com" });
    now += 16 * 60_000;
    expect((await registerPasskey(lastLinkToken())).status).toBe(401);
  });

  it("does not reveal whether an email already has an account", async () => {
    await signUp();
    const res = await call("POST", "/auth/signup", { email: "user@example.com" });
    expect(res.status).toBe(202);
    expect(email.sent.at(-1)!.subject).toMatch(/already have/);
    expect(email.sent.at(-1)!.text).not.toContain("#token=");
  });

  it("rejects invalid input", async () => {
    expect((await call("POST", "/auth/signup", { email: "not-an-email" })).status).toBe(400);
    expect((await call("POST", "/auth/signup", { email: "a@example.com", extra: 1 })).status).toBe(202);
    expect((await call("POST", "/auth/passkeys/register/options", { token: "short" })).status).toBe(400);
  });
});

describe("sign-in", () => {
  it("signs in with a registered passkey", async () => {
    const { credentialId } = await signUp();
    const res = await signIn(credentialId);
    expect(res.status).toBe(200);
    expect((await call("GET", "/auth/devices", undefined, res.body.accessToken)).status).toBe(200);
  });

  it("rejects a bad assertion and an unknown passkey", async () => {
    const { credentialId } = await signUp();
    expect((await signIn(credentialId, "forged")).status).toBe(401);
    expect((await signIn("nope")).status).toBe(401);
  });

  it("does not accept a challenge twice", async () => {
    const { credentialId } = await signUp();
    const options = await call("POST", "/auth/signin/options", {});
    const body = {
      challengeId: options.body.challengeId,
      response: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: { clientDataJSON: options.body.options.challenge, authenticatorData: "abc", signature: "ok" },
        clientExtensionResults: {},
      },
    };
    expect((await call("POST", "/auth/signin", body)).status).toBe(200);
    expect((await call("POST", "/auth/signin", body)).status).toBe(401);
  });
});

describe("sessions", () => {
  it("expires access tokens after 15 minutes", async () => {
    const { body } = await signUp();
    now += 14 * 60_000;
    expect((await call("GET", "/auth/devices", undefined, body.tokens.accessToken)).status).toBe(200);
    now += 2 * 60_000;
    expect((await call("GET", "/auth/devices", undefined, body.tokens.accessToken)).status).toBe(401);
  });

  it("rotates refresh tokens and revokes the session when an old one is reused", async () => {
    const { body } = await signUp();
    const first = await call("POST", "/auth/refresh", { refreshToken: body.tokens.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(body.tokens.refreshToken);

    // The old token was already used: treat it as stolen.
    const [sessionId] = await sessionIds({});
    expect((await call("POST", "/auth/refresh", { refreshToken: body.tokens.refreshToken })).status).toBe(401);
    expect(ended).toEqual([{ userId: await userIdOf(), sessionIds: [sessionId] }]);
    expect((await call("POST", "/auth/refresh", { refreshToken: first.body.refreshToken })).status).toBe(401);
    expect((await call("GET", "/auth/devices", undefined, first.body.accessToken)).status).toBe(401);
  });

  it("signs out and closes that session's sockets", async () => {
    const { body } = await signUp();
    const [sessionId] = await sessionIds({});
    expect((await call("POST", "/auth/signout", undefined, body.tokens.accessToken)).status).toBe(204);
    expect((await call("GET", "/auth/devices", undefined, body.tokens.accessToken)).status).toBe(401);
    expect(ended).toEqual([{ userId: await userIdOf(), sessionIds: [sessionId] }]);
  });

  it("still signs out when closing sockets fails", async () => {
    const { body } = await signUp();
    const request = new Request("https://api.test/auth/signout", {
      method: "POST",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` },
    });
    const failing = async () => {
      throw new Error("unreachable");
    };
    const res = await handleAuth(request, {
      db,
      email,
      passkeys: fakePasskeys,
      appOrigin: "https://app.test",
      now: () => now,
      endSessions: failing,
    });
    expect(res?.status).toBe(204);
    expect(await sessionIds({})).toEqual([]);
  });
});

describe("adding a device", () => {
  it("needs approval from an existing device", async () => {
    const { body } = await signUp();
    const access = body.tokens.accessToken;
    const request = await call("POST", "/auth/devices/requests", { email: "user@example.com", deviceName: "Phone" });
    expect(request.status).toBe(202);
    expect(request.body.code).toMatch(/^\d{6}$/);

    expect((await registerPasskey(request.body.token, "Phone")).status).toBe(409);

    const pending = await call("GET", "/auth/devices/requests", undefined, access);
    expect(pending.body).toEqual([
      expect.objectContaining({ id: request.body.requestId, deviceName: "Phone", code: request.body.code }),
    ]);
    expect((await call("POST", `/auth/devices/requests/${request.body.requestId}/approve`, undefined, access)).status).toBe(204);

    const added = await registerPasskey(request.body.token, "Phone");
    expect(added.status).toBe(201);
    expect(added.body.recoveryCode).toBeUndefined();
    expect((await call("GET", "/auth/devices", undefined, access)).body).toHaveLength(2);
  });

  it("does not let another account approve a request", async () => {
    await signUp();
    const other = await signUp("other@example.com");
    const request = await call("POST", "/auth/devices/requests", { email: "user@example.com", deviceName: "Phone" });
    const res = await call("POST", `/auth/devices/requests/${request.body.requestId}/approve`, undefined, other.body.tokens.accessToken);
    expect(res.status).toBe(404);
  });

  it("expires approval requests after 15 minutes", async () => {
    const { body } = await signUp();
    const request = await call("POST", "/auth/devices/requests", { email: "user@example.com", deviceName: "Phone" });
    now += 16 * 60_000;
    const access = (await call("POST", "/auth/refresh", { refreshToken: body.tokens.refreshToken })).body.accessToken;
    expect((await call("POST", `/auth/devices/requests/${request.body.requestId}/approve`, undefined, access)).status).toBe(404);
  });

  it("works with an emailed link that expires in 15 minutes", async () => {
    await signUp();
    expect((await call("POST", "/auth/devices/link", { email: "user@example.com" })).status).toBe(202);
    const token = lastLinkToken();
    now += 14 * 60_000;
    expect((await registerPasskey(token, "Tablet")).status).toBe(201);

    await call("POST", "/auth/devices/link", { email: "user@example.com" });
    now += 16 * 60_000;
    expect((await registerPasskey(lastLinkToken(), "Tablet")).status).toBe(401);
  });

  it("sends nothing for unknown emails", async () => {
    expect((await call("POST", "/auth/devices/link", { email: "nobody@example.com" })).status).toBe(202);
    expect(email.sent).toHaveLength(0);
  });
});

describe("devices", () => {
  it("revoking a device signs it out", async () => {
    const first = await signUp();
    await call("POST", "/auth/devices/link", { email: "user@example.com" });
    const second = await registerPasskey(lastLinkToken(), "Phone");
    const devices = await call("GET", "/auth/devices", undefined, first.body.tokens.accessToken);
    const phone = devices.body.find((d: { name: string }) => d.name === "Phone");
    const phoneSessions = await sessionIds({ deviceId: phone.id });
    expect(phoneSessions).toHaveLength(1);

    expect((await call("DELETE", `/auth/devices/${phone.id}`, undefined, first.body.tokens.accessToken)).status).toBe(204);
    expect(ended).toEqual([{ userId: await userIdOf(), sessionIds: phoneSessions }]);
    expect((await call("GET", "/auth/devices", undefined, second.body.tokens.accessToken)).status).toBe(401);
    expect((await signIn(second.credentialId)).status).toBe(401);
  });

  it("cannot revoke another account's device", async () => {
    await signUp();
    const other = await signUp("other@example.com");
    const own = await call("GET", "/auth/devices", undefined, other.body.tokens.accessToken);
    const mine = await signUp("third@example.com");
    expect((await call("DELETE", `/auth/devices/${own.body[0].id}`, undefined, mine.body.tokens.accessToken)).status).toBe(404);
  });
});

describe("recovery code", () => {
  it("works once and is replaced after registering a new passkey", async () => {
    const { body } = await signUp();
    const code = body.recoveryCode as string;

    expect((await call("POST", "/auth/recover", { email: "user@example.com", code: "AAAAA-AAAAA-AAAAA-AAAAA" })).status).toBe(401);

    const redeemed = await call("POST", "/auth/recover", { email: "user@example.com", code: code.toLowerCase() });
    expect(redeemed.status).toBe(200);
    expect((await call("POST", "/auth/recover", { email: "user@example.com", code })).status).toBe(401);

    const added = await registerPasskey(redeemed.body.token, "New laptop");
    expect(added.status).toBe(201);
    expect(added.body.recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(added.body.recoveryCode).not.toBe(code);
  });

  it("rejects unknown emails the same way", async () => {
    const res = await call("POST", "/auth/recover", { email: "nobody@example.com", code: "AAAAA-AAAAA-AAAAA-AAAAA" });
    expect(res).toEqual({ status: 401, body: { error: "invalid_recovery_code" } });
  });
});

describe("rate limits", () => {
  it("limits sign-ups per email", async () => {
    for (let i = 0; i < 3; i++) expect((await call("POST", "/auth/signup", { email: "a@example.com" })).status).toBe(202);
    expect((await call("POST", "/auth/signup", { email: "a@example.com" })).status).toBe(429);
    now += 60 * 60_000;
    expect((await call("POST", "/auth/signup", { email: "a@example.com" })).status).toBe(202);
  });

  it("limits sign-in attempts per passkey", async () => {
    const { credentialId } = await signUp();
    for (let i = 0; i < 10; i++) expect((await signIn(credentialId, "forged")).status).toBe(401);
    expect((await signIn(credentialId)).status).toBe(429);
  });

  it("limits by IP using the binding", async () => {
    ipAllowed = false;
    expect((await call("POST", "/auth/signup", { email: "a@example.com" })).status).toBe(429);
    expect((await call("POST", "/auth/signin/options", {})).status).toBe(429);
  });

  it("stores no raw emails or IPs in rate limit rows", async () => {
    await call("POST", "/auth/signup", { email: "a@example.com" });
    const rows = JSON.stringify((await db.prepare("SELECT * FROM rate_limits").all()).results);
    expect(rows).not.toContain("a@example.com");
    expect(rows).not.toContain("203.0.113.7");
  });
});

describe("cleanup", () => {
  it("drops expired enrollments and challenges", async () => {
    await call("POST", "/auth/signup", { email: "a@example.com" });
    await call("POST", "/auth/signin/options", {});
    now += 16 * 60_000;
    await cleanupExpired(db, now);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM enrollments").first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM challenges").first<{ n: number }>())!.n).toBe(0);
  });
});
