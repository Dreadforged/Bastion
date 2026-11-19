#!/usr/bin/env node
/**
 * WebSocket load test against `wrangler dev`.
 *
 *   node test/load/run.mjs [--clients 100] [--messages 20] [--port 8799]
 *
 * Seeds signed-in users straight into a throwaway local D1, starts the Worker
 * from test/load/wrangler.toml, then runs one server through join, connect,
 * messaging and disconnect. Every Durable Object call logs a DOREQ line; the
 * script counts them per phase and prints the totals as JSON and a table.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = join(here, "wrangler.toml");
const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const CLIENTS = arg("clients", 100);
const MESSAGES = arg("messages", 20);
const PORT = arg("port", 8817);
const BASE = `http://127.0.0.1:${PORT}`;

// ------------------------------------------------------------------ helpers

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let seq = 0;
function ulid() {
  const now = Date.now();
  seq = now === lastTime ? seq + 1 : 0;
  lastTime = now;
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  const rand = randomBytes(16);
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rand[i] % 32];
  return time + tail;
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = () => b64url(randomBytes(32));
const hash = (value) => b64url(createHash("sha256").update(value).digest());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => `load-${ulid()}`;

function wrangler(argv, opts = {}) {
  return spawnSync(process.execPath, [wranglerBin, ...argv], {
    encoding: "utf8",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    ...opts,
  });
}

async function api(method, path, user, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${user.token}`,
      "content-type": "application/json",
      ...(method === "GET" ? {} : { "idempotency-key": key() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return parsed;
}

// ------------------------------------------------------------------ DOREQ counting

const counts = [];
let lastLineAt = Date.now();
function onOutput(chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    const match = line.match(/DOREQ (\S+)/);
    if (match) {
      counts.push(match[1]);
      lastLineAt = Date.now();
    }
  }
}

/** Wait until no Durable Object call has been logged for `quietMs`. */
async function settle(quietMs = 2000) {
  // Give the last calls time to start logging before waiting for quiet.
  await sleep(500);
  lastLineAt = Math.max(lastLineAt, Date.now() - quietMs + 1000);
  while (Date.now() - lastLineAt < quietMs) await sleep(200);
}

const phases = [];
let phaseStart = 0;
function endPhase(name, extra = {}) {
  const tally = {};
  for (const n of counts.slice(phaseStart)) tally[n] = (tally[n] ?? 0) + 1;
  phases.push({ name, tally, ...extra });
  phaseStart = counts.length;
}

/**
 * Requests as Cloudflare bills them: every RPC, fetch and alarm counts as one,
 * and incoming WebSocket messages to a hibernating object count 20 to 1.
 * Close events are shown but not billed here.
 */
function billable(tally) {
  let total = 0;
  for (const [name, n] of Object.entries(tally)) {
    if (name === "UserSession.wsMessage") total += n / 20;
    else if (name !== "UserSession.wsClose") total += n;
  }
  return Math.round(total * 10) / 10;
}

// ------------------------------------------------------------------ run

async function main() {
  const persist = mkdtempSync(join(tmpdir(), "bastion-load-"));
  const users = Array.from({ length: CLIENTS + 1 }, () => ({ id: ulid(), deviceId: ulid(), sessionId: ulid(), token: token() }));
  const [owner, ...members] = users;
  const now = Date.now();

  const seed = users
    .map((u, i) =>
      [
        `INSERT INTO users (id, email, created_at) VALUES ('${u.id}', 'load${i}@example.test', ${now});`,
        `INSERT INTO devices (id, user_id, name, credential_id, public_key, created_at) VALUES ('${u.deviceId}', '${u.id}', 'Load', 'cred-${u.deviceId}', 'pk', ${now});`,
        `INSERT INTO sessions (id, user_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at) VALUES ('${u.sessionId}', '${u.id}', '${u.deviceId}', '${hash(u.token)}', ${now + 3_600_000}, '${hash(token())}', ${now + 86_400_000}, ${now});`,
      ].join("\n"),
    )
    .join("\n");
  const seedFile = join(persist, "seed.sql");
  writeFileSync(seedFile, seed);

  for (const argv of [
    ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist, "-c", config],
    ["d1", "execute", "DB", "--local", "--persist-to", persist, "--file", seedFile, "-c", config],
  ]) {
    const r = wrangler(argv);
    if (r.status !== 0) throw new Error(`wrangler ${argv.slice(0, 3).join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  }

  // Something else on the port would answer with its own database.
  const taken = await fetch(`${BASE}/health`).then(
    () => true,
    () => false,
  );
  if (taken) throw new Error(`port ${PORT} is already in use; pass --port`);

  const dev = spawn(process.execPath, [wranglerBin, "dev", "-c", config, "--persist-to", persist, "--port", String(PORT), "--ip", "127.0.0.1"], {
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  let output = "";
  dev.stdout.on("data", (c) => {
    output += c;
    if (/Ready on/.test(output)) ready = true;
    onOutput(c);
  });
  dev.stderr.on("data", (c) => {
    output += c;
    onOutput(c);
  });

  try {
    for (let i = 0; !ready; i++) {
      if (i > 300) throw new Error(`wrangler dev did not start:\n${output.slice(-2000)}`);
      await sleep(200);
    }

    // ---------------------------------------------------- setup and joins
    const created = await api("POST", "/servers", owner, { name: "Load" });
    const serverId = created.server.id;
    const general = created.channels[0].id;
    const invite = await api("POST", `/servers/${serverId}/invites`, owner, { maxUses: 0, maxAgeSeconds: 3600 });
    await settle();
    endPhase("create server");

    for (let i = 0; i < members.length; i += 20) {
      await Promise.all(members.slice(i, i + 20).map((m) => api("POST", `/invites/${invite.code}`, m)));
    }
    await settle();
    endPhase(`${CLIENTS} members join`);

    // ---------------------------------------------------- connect
    const started = Date.now();
    const sockets = await Promise.all(
      users.map(
        (u) =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`, ["bastion.v1", `bastion.auth.${u.token}`]);
            const client = { user: u, ws, messages: new Set(), ready: false };
            const timer = setTimeout(() => reject(new Error(`no READY for ${u.id}`)), 60_000);
            ws.addEventListener("open", () => ws.send(JSON.stringify({ op: "identify" })));
            ws.addEventListener("message", (e) => {
              const frame = JSON.parse(e.data);
              if (frame.op === "ready") {
                client.ready = true;
                clearTimeout(timer);
                resolve(client);
              } else if (frame.op === "dispatch" && frame.t === "MESSAGE_CREATE") {
                client.messages.add(frame.d.id);
              }
            });
            ws.addEventListener("error", () => reject(new Error(`socket error for ${u.id}`)));
          }),
      ),
    );
    const connectMs = Date.now() - started;
    await settle();
    endPhase(`${CLIENTS + 1} clients connect`, { ms: connectMs });

    // ---------------------------------------------------- messages
    const sendStart = Date.now();
    const sent = [];
    for (let i = 0; i < MESSAGES; i++) {
      const author = members[i % members.length];
      const ciphertext = Buffer.from(`load message ${i}`).toString("base64");
      sent.push((await api("POST", `/servers/${serverId}/channels/${general}/messages`, author, { ciphertext, epoch: 0 })).id);
    }
    const deadline = Date.now() + 60_000;
    while (sockets.some((c) => sent.some((id) => !c.messages.has(id))) && Date.now() < deadline) await sleep(100);
    const fanoutMs = Date.now() - sendStart;
    const missing = sockets.reduce((n, c) => n + sent.filter((id) => !c.messages.has(id)).length, 0);
    await settle();
    endPhase(`${MESSAGES} messages to ${CLIENTS + 1} clients`, { ms: fanoutMs, missingDeliveries: missing });

    // ---------------------------------------------------- pings
    for (const c of sockets) c.ws.send(JSON.stringify({ op: "ping" }));
    await settle();
    endPhase(`${CLIENTS + 1} pings`);

    // ---------------------------------------------------- disconnect
    for (const c of sockets) c.ws.close(1000, "done");
    await settle(3000);
    endPhase(`${CLIENTS + 1} clients disconnect`);

    const report = phases.map((p) => ({ ...p, billable: billable(p.tally) }));
    const total = report.reduce((n, p) => n + p.billable, 0);
    console.log(JSON.stringify({ clients: CLIENTS, messages: MESSAGES, phases: report, totalBillable: total }, null, 2));
    console.log("\nphase | billable DO requests | breakdown");
    for (const p of report) {
      const breakdown = Object.entries(p.tally)
        .sort()
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
      console.log(`${p.name} | ${p.billable} | ${breakdown}`);
    }
  } finally {
    // wrangler starts workerd as a child; on Windows kill the whole tree.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"]);
    else dev.kill();
    await sleep(500);
    try {
      rmSync(persist, { recursive: true, force: true });
    } catch {
      // wrangler may still hold files on Windows; the OS temp dir is cleaned later
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
