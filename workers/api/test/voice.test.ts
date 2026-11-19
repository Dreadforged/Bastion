import { newId, type schemas } from "@bastion/shared";
import type { Server, UserSession } from "@bastion/durable";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../../durable/test/world.js";
import { hashToken, newToken } from "../src/auth/crypto.js";
import { cleanupLiveStreams, handleServers } from "../src/servers/routes.js";
import { applyVoiceEffects, HttpLiveKitAdmin, issueToken, type LiveKitConfig } from "../src/voice/livekit.js";
import { createTestD1 } from "./d1.js";
import { FakeLiveKitAdmin } from "./fake-livekit.js";

const CONFIG: LiveKitConfig = { url: "wss://voice.test", apiKey: "APIkey123", apiSecret: "s3cret-for-tests-only-0123456789abcdef" };
const HEX32 = /^[0-9a-f]{32}$/;
const STREAM = (1n << 15n).toString();

let db: D1Database;
let world: World;
let admin: FakeLiveKitAdmin;
let configured: boolean;
let plans: Map<string, schemas.Plan>;

beforeEach(() => {
  db = createTestD1();
  world = new World();
  admin = new FakeLiveKitAdmin();
  configured = true;
  plans = new Map();
});

const servers = {
  idFromName: (name: string) => name,
  get: (id: string) => ({ handle: (u: string, op: unknown, key: string | null) => world.server(id).handle(u, op, key), setAgeLimit: async (u: string, on: boolean) => world.server(id).setAgeLimit(u, on) }),
} as unknown as DurableObjectNamespace<Server>;

const sessions = {
  idFromName: (name: string) => name,
  get: (userId: string) => ({
    createServer: (u: string, key: string, name: string) => world.session(u).core.createServer(u, key, name),
  }),
} as unknown as DurableObjectNamespace<UserSession>;

async function signedIn(): Promise<{ userId: string; token: string }> {
  const userId = newId();
  const deviceId = newId();
  const token = newToken();
  const now = world.now;
  await db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(userId, `${userId.toLowerCase()}@test`, now).run();
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

let keyCounter = 0;

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (method !== "GET") headers["idempotency-key"] = `k-${++keyCounter}-abcdefgh`;
  const request = new Request(`https://api.test${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const res = await handleServers(request, {
    db,
    servers,
    sessions,
    now: () => world.now,
    voice: configured ? { config: CONFIG, admin } : undefined,
    planFor: async (userId) => plans.get(userId) ?? "free",
  });
  if (!res) throw new Error("unrouted");
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

interface Setup {
  owner: { userId: string; token: string };
  guest: { userId: string; token: string };
  serverId: string;
  general: string;
  lounge: string;
}

/** An owner and a guest in a server with a voice channel. */
async function setup(): Promise<Setup> {
  const owner = await signedIn();
  const guest = await signedIn();
  const created = await call("POST", "/servers", { token: owner.token, body: { name: "Home" } });
  const serverId = created.body.server.id as string;
  const general = created.body.channels[0].id as string;
  const channel = await call("POST", `/servers/${serverId}/channels`, { token: owner.token, body: { name: "lounge", kind: "voice" } });
  const invite = await call("POST", `/servers/${serverId}/invites`, { token: owner.token, body: { maxUses: 1 } });
  await call("POST", `/invites/${invite.body.code}`, { token: guest.token });
  return { owner, guest, serverId, general, lounge: channel.body.id as string };
}

/** Give the guest a role holding STREAM. */
async function allowStreaming(t: Setup) {
  const role = await call("POST", `/servers/${t.serverId}/roles`, {
    token: t.owner.token,
    body: { name: "streamers", permissions: STREAM, position: 1 },
  });
  await call("PUT", `/servers/${t.serverId}/members/${t.guest.userId}/roles/${role.body.id}`, { token: t.owner.token });
}

function decode(token: string) {
  const [h, p, sig] = token.split(".") as [string, string, string];
  const json = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  return { header: json(h), payload: json(p), signature: sig, signed: `${h}.${p}` };
}

async function verifies(token: string, secret = CONFIG.apiSecret): Promise<boolean> {
  const { signed, signature } = decode(token);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
  const expected = btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return expected === signature;
}

function tokenRoute(t: Setup, channelId = t.lounge, extra: Record<string, unknown> = {}, as = t.guest) {
  return call("POST", `/servers/${t.serverId}/voice/token`, { token: as.token, body: { channelId, ...extra } });
}

// ------------------------------------------------------------------ token route

describe("POST /servers/:id/voice/token", () => {
  it("issues a five minute token for a random room and participant", async () => {
    const t = await setup();
    const res = await tokenRoute(t);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({ url: CONFIG.url, canPublish: true, canShare: false });
    expect(res.body.roomId).toMatch(HEX32);
    expect(res.body.participantId).toMatch(HEX32);
    expect(res.body.expiresAt).toBe(world.now + 300_000);

    const { header, payload } = decode(res.body.token);
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({ iss: CONFIG.apiKey, sub: res.body.participantId });
    expect(payload.exp - payload.iat).toBe(300);
    expect(payload.exp * 1000).toBe(res.body.expiresAt);
    expect(payload.video).toMatchObject({ room: res.body.roomId, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: false });
    expect(await verifies(res.body.token)).toBe(true);
    expect(await verifies(res.body.token, "another-secret")).toBe(false);
  });

  it("puts nothing but random ids in the token", async () => {
    const t = await setup();
    const res = await tokenRoute(t);
    const raw = JSON.stringify(decode(res.body.token).payload).toLowerCase();
    for (const value of [t.guest.userId, t.owner.userId, t.serverId, t.lounge, "lounge", "home"]) {
      expect(raw).not.toContain(value.toLowerCase());
    }
    expect(Object.keys(decode(res.body.token).payload).sort()).toEqual(["exp", "iat", "iss", "nbf", "sub", "video"]);
    // The participant id is not the user id, and changes with every new call.
    expect(res.body.participantId).not.toBe(t.guest.userId);
    await call("DELETE", `/servers/${t.serverId}/voice`, { token: t.guest.token });
    expect((await tokenRoute(t)).body.participantId).not.toBe(res.body.participantId);
  });

  it("grants the microphone only, unless screen share was asked for and allowed", async () => {
    const t = await setup();
    const plain = await tokenRoute(t);
    expect(decode(plain.body.token).payload.video.canPublishSources).toEqual(["microphone"]);

    const denied = await tokenRoute(t, t.lounge, { screenShare: true });
    expect(denied).toMatchObject({ status: 403, body: { error: "missing_permissions" } });

    await allowStreaming(t);
    // Allowed, but not asked for: still no screen share in the token.
    expect(decode((await tokenRoute(t)).body.token).payload.video.canPublishSources).toEqual(["microphone"]);
    const allowed = await tokenRoute(t, t.lounge, { screenShare: true });
    expect(allowed.status).toBe(200);
    expect(allowed.body.canShare).toBe(true);
    expect(decode(allowed.body.token).payload.video.canPublishSources).toEqual(["microphone", "screen_share", "screen_share_audio"]);
  });

  it("is refused for a member who is timed out, until the timeout ends", async () => {
    const t = await setup();
    const timeout = await call("PUT", `/servers/${t.serverId}/members/${t.guest.userId}/timeout`, { token: t.owner.token, body: { seconds: 60 } });
    expect(timeout.status).toBe(200);
    expect(await tokenRoute(t)).toMatchObject({ status: 403, body: { error: "missing_permissions" } });
    world.now += 61_000;
    expect((await tokenRoute(t)).status).toBe(200);
  });

  it("is refused without CONNECT_VOICE, and does not put them in the call", async () => {
    const t = await setup();
    const denied = await call("PUT", `/servers/${t.serverId}/channels/${t.lounge}/overrides/member/${t.guest.userId}`, {
      token: t.owner.token,
      body: { allow: "0", deny: (1n << 4n).toString() },
    });
    expect(denied.status).toBe(200);
    expect((await tokenRoute(t)).status).toBe(403);
    expect((await call("GET", `/servers/${t.serverId}/voice`, { token: t.owner.token })).body).toEqual([]);
  });

  it("only works for voice channels the caller can see", async () => {
    const t = await setup();
    expect((await tokenRoute(t, t.general)).body).toEqual({ error: "not_voice_channel" });
    expect((await tokenRoute(t, newId())).status).toBe(404);
    expect((await tokenRoute(t, "not-an-id")).status).toBe(400);
  });

  it("needs a signed-in user and a valid body", async () => {
    const t = await setup();
    expect((await call("POST", `/servers/${t.serverId}/voice/token`, { body: { channelId: t.lounge } })).status).toBe(401);
    expect((await call("POST", `/servers/${t.serverId}/voice/token`, { token: t.guest.token, body: {} })).status).toBe(400);
    const badFlag = await call("POST", `/servers/${t.serverId}/voice/token`, { token: t.guest.token, body: { channelId: t.lounge, screenShare: "yes" } });
    expect(badFlag.status).toBe(400);
  });

  it("answers 503 and changes nothing when LiveKit is not configured", async () => {
    const t = await setup();
    configured = false;
    expect((await tokenRoute(t)).body).toEqual({ error: "voice_unavailable" });
    configured = true;
    expect((await call("GET", `/servers/${t.serverId}/voice`, { token: t.owner.token })).body).toEqual([]);
  });

  it("uses the plan's quality tier", async () => {
    const t = await setup();
    expect((await tokenRoute(t)).body.quality).toMatchObject({ height: 720, fps: 30, maxViewers: 25 });
    plans.set(t.guest.userId, "plus");
    expect((await tokenRoute(t)).body.quality).toMatchObject({ height: 1080, fps: 60, maxViewers: 50 });
  });

  it("is not available to non-members", async () => {
    const t = await setup();
    const stranger = await signedIn();
    expect((await tokenRoute(t, t.lounge, {}, stranger)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ state and moderation routes

describe("voice state routes", () => {
  it("list, update and leave", async () => {
    const t = await setup();
    const joined = await tokenRoute(t);
    const listed = await call("GET", `/servers/${t.serverId}/voice`, { token: t.owner.token });
    expect(listed.body).toEqual([
      { serverId: t.serverId, userId: t.guest.userId, channelId: t.lounge, participantId: joined.body.participantId, selfMute: false, selfDeaf: false, streaming: false },
    ]);
    const muted = await call("PATCH", `/servers/${t.serverId}/voice`, { token: t.guest.token, body: { selfMute: true } });
    expect(muted.body).toMatchObject({ selfMute: true });
    expect((await call("PATCH", `/servers/${t.serverId}/voice`, { token: t.guest.token, body: { selfMute: "x" } })).status).toBe(400);
    expect((await call("DELETE", `/servers/${t.serverId}/voice`, { token: t.guest.token })).status).toBe(204);
    expect((await call("GET", `/servers/${t.serverId}/voice`, { token: t.owner.token })).body).toEqual([]);
    expect((await call("PATCH", `/servers/${t.serverId}/voice`, { token: t.guest.token, body: {} })).status).toBe(409);
  });
});

describe("moderator voice routes", () => {
  it("remove someone from a call and tell LiveKit to disconnect them", async () => {
    const t = await setup();
    const joined = await tokenRoute(t);
    const res = await call("DELETE", `/servers/${t.serverId}/voice/${t.guest.userId}`, { token: t.owner.token, body: { reason: "spam" } });
    expect(res.status).toBe(204);
    expect(admin.calls).toEqual([{ kind: "remove", roomId: joined.body.roomId, participantId: joined.body.participantId }]);
  });

  it("end a stream and take screen share away at LiveKit, leaving the microphone", async () => {
    const t = await setup();
    await allowStreaming(t);
    const joined = await tokenRoute(t, t.lounge, { screenShare: true });
    await call("PATCH", `/servers/${t.serverId}/voice`, { token: t.guest.token, body: { streaming: true } });
    const res = await call("POST", `/servers/${t.serverId}/voice/${t.guest.userId}/end-stream`, { token: t.owner.token, body: {} });
    expect(res.status).toBe(200);
    expect(res.body.streaming).toBe(false);
    expect(res.body).not.toHaveProperty("effects");
    expect(admin.calls).toEqual([
      { kind: "update", roomId: joined.body.roomId, participantId: joined.body.participantId, canPublish: true, canShare: false },
    ]);
  });

  it("are refused for members without MUTE_MEMBERS, and validate ids", async () => {
    const t = await setup();
    await tokenRoute(t);
    expect((await call("DELETE", `/servers/${t.serverId}/voice/${t.owner.userId}`, { token: t.guest.token, body: {} })).status).toBe(403);
    expect((await call("DELETE", `/servers/${t.serverId}/voice/not-an-id`, { token: t.owner.token, body: {} })).status).toBe(404);
    expect(admin.calls).toEqual([]);
  });

  it("a timeout started over HTTP drops the person at LiveKit", async () => {
    const t = await setup();
    const joined = await tokenRoute(t);
    const res = await call("PUT", `/servers/${t.serverId}/members/${t.guest.userId}/timeout`, { token: t.owner.token, body: { seconds: 60 } });
    expect(res.status).toBe(200);
    expect(admin.calls).toEqual([{ kind: "remove", roomId: joined.body.roomId, participantId: joined.body.participantId }]);
  });

  it("still succeed if LiveKit cannot be reached, logging counts and no ids", async () => {
    const t = await setup();
    await tokenRoute(t);
    admin.failing = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("DELETE", `/servers/${t.serverId}/voice/${t.guest.userId}`, { token: t.owner.token, body: {} });
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("1 of 1"));
    expect(spy.mock.calls.flat().join(" ")).not.toContain(t.guest.userId);
    spy.mockRestore();
  });
});

// ------------------------------------------------------------------ LiveKit client

describe("issueToken", () => {
  const grant = { roomId: "a".repeat(32), participantId: "b".repeat(32), canPublish: false, canShare: false };

  it("grants listening only when the person cannot speak", async () => {
    const { token } = await issueToken(CONFIG, grant, 1_000_000);
    const { video } = decode(token).payload;
    expect(video.canPublish).toBe(false);
    expect(video).not.toHaveProperty("canPublishSources");
    expect(video.canSubscribe).toBe(true);
  });

  it("never grants the camera or data channels", async () => {
    const { token } = await issueToken(CONFIG, { ...grant, canPublish: true, canShare: true }, 1_000_000);
    const { video } = decode(token).payload;
    expect(video.canPublishSources).not.toContain("camera");
    expect(video.canPublishData).toBe(false);
  });
});

describe("HttpLiveKitAdmin", () => {
  function setupAdmin(status = 200) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    return { client: new HttpLiveKitAdmin(CONFIG, () => 5_000_000, fetcher), requests };
  }

  it("removes a participant with a short room admin token", async () => {
    const { client, requests } = setupAdmin();
    await client.removeParticipant("r".repeat(32), "p".repeat(32));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://voice.test/twirp/livekit.RoomService/RemoveParticipant");
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ room: "r".repeat(32), identity: "p".repeat(32) });
    const bearer = (requests[0]!.init.headers as Record<string, string>).authorization!.replace("Bearer ", "");
    const { payload } = decode(bearer);
    expect(payload.video).toEqual({ roomAdmin: true, room: "r".repeat(32) });
    expect(payload.exp - payload.iat).toBe(60);
    expect(await verifies(bearer)).toBe(true);
  });

  it("limits screen share by listing the sources that remain", async () => {
    const { client, requests } = setupAdmin();
    await client.updatePermissions("r", "p", { canPublish: true, canShare: false });
    expect(requests[0]!.url).toContain("UpdateParticipant");
    expect(JSON.parse(requests[0]!.init.body as string).permission).toEqual({
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canPublishSources: ["MICROPHONE"],
    });
  });

  it("treats a participant that is already gone as done, and reports real failures", async () => {
    await expect(setupAdmin(404).client.removeParticipant("r", "p")).resolves.toBeUndefined();
    await expect(setupAdmin(500).client.removeParticipant("r", "p")).rejects.toThrow("500");
  });
});

describe("applyVoiceEffects", () => {
  it("does nothing when there is nothing to do", async () => {
    expect(await applyVoiceEffects(admin, undefined)).toBe(0);
    expect(await applyVoiceEffects(admin, [])).toBe(0);
  });

  it("keeps going when one call fails and counts the failures", async () => {
    const calls: string[] = [];
    const flaky = {
      removeParticipant: async (_r: string, p: string) => {
        calls.push(p);
        if (p === "bad") throw new Error("nope");
      },
      updatePermissions: async () => {},
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await applyVoiceEffects(flaky, [
      { kind: "remove", roomId: "r", participantId: "bad" },
      { kind: "remove", roomId: "r", participantId: "good" },
    ]);
    spy.mockRestore();
    expect(failed).toBe(1);
    expect(calls).toEqual(["bad", "good"]);
  });
});

// ------------------------------------------------------------------ one stream per account

describe("one live stream per account", () => {
  /** A second server where the guest also has a voice channel and STREAM. */
  async function secondServer(t: Setup) {
    const created = await call("POST", "/servers", { token: t.guest.token, body: { name: "Other" } });
    const serverId = created.body.server.id as string;
    const channel = await call("POST", `/servers/${serverId}/channels`, { token: t.guest.token, body: { name: "room", kind: "voice" } });
    return { serverId, lounge: channel.body.id as string };
  }

  const goLive = (serverId: string, t: Setup) =>
    call("PATCH", `/servers/${serverId}/voice`, { token: t.guest.token, body: { streaming: true } });

  it("refuses a second stream in another server, and allows it after the first stops", async () => {
    const t = await setup();
    await allowStreaming(t);
    const other = await secondServer(t);
    await tokenRoute(t, t.lounge, { screenShare: true });
    expect((await goLive(t.serverId, t)).status).toBe(200);

    await call("POST", `/servers/${other.serverId}/voice/token`, { token: t.guest.token, body: { channelId: other.lounge, screenShare: true } });
    expect((await goLive(other.serverId, t)).body).toEqual({ error: "too_many_streams" });
    // The refused stream is not live there.
    const list = await call("GET", `/servers/${other.serverId}/voice`, { token: t.guest.token });
    expect(list.body.filter((s: schemas.VoiceState) => s.streaming)).toHaveLength(0);

    await call("PATCH", `/servers/${t.serverId}/voice`, { token: t.guest.token, body: { streaming: false } });
    expect((await goLive(other.serverId, t)).status).toBe(200);
  });

  it("lets the same stream keep renewing, and frees the slot when the person leaves", async () => {
    const t = await setup();
    await allowStreaming(t);
    const other = await secondServer(t);
    await tokenRoute(t, t.lounge, { screenShare: true });
    expect((await goLive(t.serverId, t)).status).toBe(200);
    world.now += 30_000;
    expect((await call("PATCH", `/servers/${t.serverId}/voice`, { token: t.guest.token, body: {} })).status).toBe(200);
    expect((await goLive(t.serverId, t)).status).toBe(200);

    await call("DELETE", `/servers/${t.serverId}/voice`, { token: t.guest.token });
    await call("POST", `/servers/${other.serverId}/voice/token`, { token: t.guest.token, body: { channelId: other.lounge, screenShare: true } });
    expect((await goLive(other.serverId, t)).status).toBe(200);
  });

  it("frees the slot by itself if the client stops renewing", async () => {
    const t = await setup();
    await allowStreaming(t);
    const other = await secondServer(t);
    await tokenRoute(t, t.lounge, { screenShare: true });
    expect((await goLive(t.serverId, t)).status).toBe(200);
    world.now += 91_000; // a voice lease is 90 seconds
    await call("POST", `/servers/${other.serverId}/voice/token`, { token: t.guest.token, body: { channelId: other.lounge, screenShare: true } });
    expect((await goLive(other.serverId, t)).status).toBe(200);
  });

  it("does not hold a slot for a stream that was refused", async () => {
    const t = await setup(); // guest has no STREAM
    const other = await secondServer(t);
    await tokenRoute(t);
    expect((await goLive(t.serverId, t)).status).toBe(403);
    await call("POST", `/servers/${other.serverId}/voice/token`, { token: t.guest.token, body: { channelId: other.lounge, screenShare: true } });
    expect((await goLive(other.serverId, t)).status).toBe(200);
  });

  it("is not shared between accounts, and cleanup removes lapsed rows", async () => {
    const t = await setup();
    await allowStreaming(t);
    await tokenRoute(t, t.lounge, { screenShare: true });
    expect((await goLive(t.serverId, t)).status).toBe(200);
    // The owner is a different account with its own slot, even while the guest is live.
    await tokenRoute(t, t.lounge, {}, t.owner);
    expect((await call("PATCH", `/servers/${t.serverId}/voice`, { token: t.owner.token, body: { streaming: true } })).status).toBe(200);
    world.now += 200_000;
    await cleanupLiveStreams(db, world.now);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM live_streams").first<{ n: number }>())!.n).toBe(0);
  });
});
