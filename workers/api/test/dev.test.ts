import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, UserSession } from "@bastion/durable";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../../durable/test/world.js";
import { authenticate } from "../src/auth/sessions.js";
import { devOriginOk, devSeedAllowed, type DevGateEnv } from "../src/dev/gate.js";
import { PERSONAS } from "../src/dev/personas.js";
import { devStaffAuth, handleDev } from "../src/dev/routes.js";
import { seedDevData } from "../src/dev/seed.js";
import { FlagReader } from "../src/safety/flags.js";
import { handleServers } from "../src/servers/routes.js";
import { createTestD1 } from "./d1.js";

// The Worker entry pulls in Durable Object classes, which need the Workers runtime module.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const LOCAL: DevGateEnv = { ENVIRONMENT: "development", DEV_SEED: "local", RP_ID: "localhost", APP_ORIGIN: "http://localhost:5173" };
const LOCAL_URL = "http://127.0.0.1:8787/dev/users";

// ------------------------------------------------------------------ the gate

describe("dev gate", () => {
  it("is off by default", () => {
    expect(devSeedAllowed({}, LOCAL_URL, false)).toBe(false);
    expect(devSeedAllowed({}, LOCAL_URL, true)).toBe(false);
  });

  it("is on only when everything says local", () => {
    expect(devSeedAllowed(LOCAL, LOCAL_URL, true)).toBe(true);
    expect(devSeedAllowed(LOCAL, "http://localhost:8787/dev/users", true)).toBe(true);
  });

  it("is off for a build that was not made for local dev", () => {
    expect(devSeedAllowed(LOCAL, LOCAL_URL, false)).toBe(false);
  });

  it.each([
    ["environment unset", { ENVIRONMENT: undefined }],
    ["staging", { ENVIRONMENT: "staging" }],
    ["production", { ENVIRONMENT: "production" }],
    ["environment misspelled", { ENVIRONMENT: "Development" }],
    ["flag unset", { DEV_SEED: undefined }],
    ["flag not exactly local", { DEV_SEED: "true" }],
    ["flag empty", { DEV_SEED: "" }],
    ["relying party not localhost", { RP_ID: "bastion.example" }],
    ["app origin on the internet", { APP_ORIGIN: "https://app.bastion.example" }],
    ["app origin https", { APP_ORIGIN: "https://localhost:5173" }],
    ["app origin lookalike", { APP_ORIGIN: "http://localhost.evil.example" }],
    ["app origin unparseable", { APP_ORIGIN: "not a url" }],
    ["app origin unset", { APP_ORIGIN: undefined }],
  ] as [string, Partial<DevGateEnv>][])("fails closed: %s", (_name, change) => {
    expect(devSeedAllowed({ ...LOCAL, ...change }, LOCAL_URL, true)).toBe(false);
  });

  it("fails closed when the request is not on a loopback host", () => {
    expect(devSeedAllowed(LOCAL, "https://api.bastion.example/dev/users", true)).toBe(false);
    expect(devSeedAllowed(LOCAL, "http://localhost.evil.example/dev/users", true)).toBe(false);
    expect(devSeedAllowed(LOCAL, "http://192.168.1.5:8787/dev/users", true)).toBe(false);
    expect(devSeedAllowed(LOCAL, "garbage", true)).toBe(false);
  });

  it("rejects requests from other sites", () => {
    const req = (origin?: string) => new Request(LOCAL_URL, origin ? { headers: { origin } } : {});
    expect(devOriginOk(req(), LOCAL.APP_ORIGIN)).toBe(true);
    expect(devOriginOk(req("http://localhost:5173"), LOCAL.APP_ORIGIN)).toBe(true);
    expect(devOriginOk(req("http://127.0.0.1:8787"), LOCAL.APP_ORIGIN)).toBe(true);
    expect(devOriginOk(req("https://evil.example"), LOCAL.APP_ORIGIN)).toBe(false);
  });
});

// ------------------------------------------------------------------ the Worker entry

describe("worker entry", () => {
  it("answers 404 for /dev routes even with a fully local environment, when the build is not the local one", async () => {
    const { default: worker } = await import("../src/index.js");
    const env = { ...LOCAL } as unknown as Parameters<NonNullable<typeof worker.fetch>>[1];
    for (const path of ["/dev/users", "/dev/signin"]) {
      const res = await worker.fetch!(new Request(`http://localhost:8787${path}`, { method: path === "/dev/users" ? "GET" : "POST", body: path === "/dev/signin" ? "{}" : null }), env);
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ wrangler.toml

/** Minimal reader: section name -> its `key = value` lines. Comments are dropped. */
function sections(file: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>([["", new Map()]]);
  let current = "";
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/^\s*#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      current = header[1]!.trim();
      if (!out.has(current)) out.set(current, new Map());
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (kv) out.get(current)!.set(kv[1]!, kv[2]!.trim());
  }
  return out;
}

describe("wrangler.toml", () => {
  const toml = sections(join(import.meta.dirname, "..", "wrangler.toml"));
  const envSections = [...toml.keys()].filter((name) => name.startsWith("env."));

  it("turns the dev routes on for the local config only", () => {
    expect(toml.get("vars")!.get("DEV_SEED")).toBe('"local"');
    expect(toml.get("vars")!.get("ENVIRONMENT")).toBe('"development"');
    expect(toml.get("define")!.get("__BASTION_LOCAL_DEV__")).toBe('"true"');
  });

  it("has staging and production blocks", () => {
    expect(envSections.some((s) => s.startsWith("env.staging"))).toBe(true);
    expect(envSections.some((s) => s.startsWith("env.production"))).toBe(true);
  });

  it("never sets DEV_SEED in staging or production", () => {
    for (const name of envSections) expect(toml.get(name)!.has("DEV_SEED"), name).toBe(false);
    for (const name of toml.keys()) if (name !== "vars") expect(toml.get(name)!.has("DEV_SEED"), name).toBe(false);
    // Not even as an uncommented line in the top-level keys.
    expect(toml.get("")!.has("DEV_SEED")).toBe(false);
  });

  it.each(["staging", "production"])("compiles the dev code out of %s and names the right environment", (env) => {
    expect(toml.get(`env.${env}.define`)!.get("__BASTION_LOCAL_DEV__")).toBe('"false"');
    expect(toml.get(`env.${env}.vars`)!.get("ENVIRONMENT")).toBe(`"${env}"`);
    for (const name of envSections.filter((s) => s.startsWith(`env.${env}`))) {
      expect(toml.get(name)!.get("__BASTION_LOCAL_DEV__"), name).not.toBe('"true"');
    }
  });

  it("does not let staging or production resolve to a local gate", () => {
    for (const env of ["staging", "production"]) {
      const vars = toml.get(`env.${env}.vars`)!;
      const resolved: DevGateEnv = {
        ENVIRONMENT: vars.get("ENVIRONMENT")?.replace(/"/g, ""),
        DEV_SEED: vars.get("DEV_SEED")?.replace(/"/g, ""),
        RP_ID: vars.get("RP_ID")?.replace(/"/g, ""),
        APP_ORIGIN: vars.get("APP_ORIGIN")?.replace(/"/g, ""),
      };
      const built = toml.get(`env.${env}.define`)!.get("__BASTION_LOCAL_DEV__") === '"true"';
      expect(devSeedAllowed(resolved, LOCAL_URL, built), env).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ seed and sign-in

let db: D1Database;
let world: World;

beforeEach(() => {
  db = createTestD1();
  world = new World();
});

const servers = {
  idFromName: (name: string) => name,
  get: (id: string) => ({
    handle: (u: string, op: unknown, key: string | null) => world.server(id).handle(u, op, key),
    setAgeLimit: async (u: string, on: boolean) => world.server(id).setAgeLimit(u, on),
  }),
} as unknown as DurableObjectNamespace<Server>;

const sessions = {
  idFromName: (name: string) => name,
  get: (userId: string) => ({
    createServer: (u: string, key: string, name: string) => world.session(u).core.createServer(u, key, name),
    listServerIds: async () => world.session(userId).core.serverIds(),
  }),
} as unknown as DurableObjectNamespace<UserSession>;

function deps() {
  const flags = new FlagReader(db, () => world.now);
  return {
    db,
    flags,
    now: () => world.now,
    api: async (req: Request) => (await handleServers(req, { db, servers, sessions, now: () => world.now, flags })) ?? new Response(null, { status: 404 }),
  };
}

async function dev(method: string, path: string, body?: unknown) {
  const res = await handleDev(new Request(`http://localhost:8787${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), deps());
  if (!res) throw new Error("unrouted");
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

describe("dev seed and sign-in", () => {
  it("lists the test accounts and an invite, seeding on first use", async () => {
    const r = await dev("GET", "/dev/users");
    expect(r.status).toBe(200);
    expect(r.body.users.map((u: { handle: string }) => u.handle)).toEqual(PERSONAS.map((p) => p.handle));
    expect(r.body.inviteCode).toMatch(/^[A-Za-z0-9]{10}$/);
  });

  it("is idempotent", async () => {
    expect((await seedDevData(deps())).seeded).toBe(true);
    expect((await seedDevData(deps())).seeded).toBe(false);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(count!.n).toBe(PERSONAS.length);
  });

  it("makes adults verified with terms accepted, and the others limited", async () => {
    await seedDevData(deps());
    const row = (handle: string) =>
      db.prepare("SELECT id, age_band, age_method, account_state FROM users WHERE email = ?").bind(`${handle}@bastion.test`).first<{ id: string; age_band: string; age_method: string; account_state: string }>();
    for (const h of ["alice", "bob", "carol", "dave", "staff"]) {
      const u = (await row(h))!;
      expect([u.age_band, u.age_method, u.account_state]).toEqual(["18plus", "verified", "active"]);
      const terms = await db.prepare("SELECT COUNT(*) AS n FROM terms_acceptances WHERE user_id = ?").bind(u.id).first<{ n: number }>();
      expect(terms!.n).toBe(3);
    }
    expect((await row("teen"))!.account_state).toBe("restricted");
    expect((await row("teen"))!.age_band).toBe("16to17");
    expect((await row("review"))!.account_state).toBe("pending_age_review");
  });

  it("puts alice, bob and carol in one server with channels, a moderator role and an invite", async () => {
    await seedDevData(deps());
    const id = async (h: string) => (await db.prepare("SELECT id FROM users WHERE email = ?").bind(`${h}@bastion.test`).first<{ id: string }>())!.id;
    const serverIds = world.session(await id("alice")).core.serverIds();
    expect(serverIds).toHaveLength(1);
    for (const h of ["bob", "carol"]) expect(world.session(await id(h)).core.serverIds()).toEqual(serverIds);
    for (const h of ["dave", "teen", "review", "staff"]) expect(world.session(await id(h)).core.serverIds()).toEqual([]);

    const tokens = await dev("POST", "/dev/signin", { handle: "bob" });
    const snap = await deps().api(new Request(`http://localhost/servers/${serverIds[0]}/channels/x/messages`, { headers: { authorization: `Bearer ${tokens.body.accessToken}` } }));
    expect(snap.status).not.toBe(401);
  });

  it("signs in as each account with a working session on a fresh device", async () => {
    for (const p of PERSONAS) {
      const r = await dev("POST", "/dev/signin", { handle: p.handle });
      expect(r.status, p.handle).toBe(200);
      const principal = await authenticate(db, new Request("http://localhost/x", { headers: { authorization: `Bearer ${r.body.accessToken}` } }), world.now);
      expect(principal.accountState).toBe(p.accountState);
      expect(principal.ageBand).toBe(p.ageBand);
    }
    const a = await dev("POST", "/dev/signin", { handle: "alice" });
    const b = await dev("POST", "/dev/signin", { handle: "alice" });
    const pa = await authenticate(db, new Request("http://localhost/x", { headers: { authorization: `Bearer ${a.body.accessToken}` } }), world.now);
    const pb = await authenticate(db, new Request("http://localhost/x", { headers: { authorization: `Bearer ${b.body.accessToken}` } }), world.now);
    expect(pa.deviceId).not.toBe(pb.deviceId);
  });

  it("rejects unknown handles and bad bodies", async () => {
    expect((await dev("POST", "/dev/signin", { handle: "mallory" })).status).toBe(404);
    expect((await dev("POST", "/dev/signin", { handle: 5 })).status).toBe(404);
    const bad = await handleDev(new Request("http://localhost:8787/dev/signin", { method: "POST", body: "{{" }), deps());
    expect(bad!.status).toBe(400);
  });

  it("does not own other paths", async () => {
    expect(await handleDev(new Request("http://localhost:8787/servers"), deps())).toBeNull();
    expect((await dev("GET", "/dev/nothing")).status).toBe(404);
  });

  it("sets a staff cookie only for the staff account, and clears it otherwise", async () => {
    const staff = await dev("POST", "/dev/signin", { handle: "staff" });
    expect(staff.headers.get("set-cookie")).toContain("bastion_dev_staff=1");
    expect(staff.headers.get("set-cookie")).toContain("HttpOnly");
    const other = await dev("POST", "/dev/signin", { handle: "alice" });
    expect(other.headers.get("set-cookie")).toContain("Max-Age=0");

    const auth = devStaffAuth();
    expect(await auth.authenticate(new Request("http://localhost/staff", { headers: { cookie: "a=b; bastion_dev_staff=1" } }))).toBe("staff@bastion.test");
    expect(await auth.authenticate(new Request("http://localhost/staff"))).toBeNull();
    expect(await auth.authenticate(new Request("http://localhost/staff", { headers: { cookie: "bastion_dev_staff=" } }))).toBeNull();
  });
});
