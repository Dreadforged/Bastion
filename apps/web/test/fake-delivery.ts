import { Api, MemoryTokenStore } from "../src/lib/http.js";

interface Dev {
  userId: string;
  deviceId: string;
  identityKey: string;
  packages: string[];
}

interface Env {
  seq: number;
  kind: "commit" | "message" | "welcome";
  senderId: string;
  senderDeviceId: string;
  epoch: number;
  data: string;
  createdAt: number;
  /** Welcomes are only for the device they were made for. */
  to?: string;
}

interface Conv {
  id: string;
  kind: "dm" | "channel" | "group";
  channelId: string | null;
  epoch: number;
  members: Set<string>;
  devices: { userId: string; deviceId: string }[];
  log: Env[];
}

/**
 * A small in-memory stand-in for the delivery service routes the client
 * uses. It follows the real rules that matter here: one commit per epoch,
 * messages must name the current epoch, welcomes go only to added devices.
 */
export class FakeDelivery {
  devices = new Map<string, Dev>();
  convs = new Map<string, Conv>();
  private n = 0;
  private dms = new Map<string, Conv>();
  private channels = new Map<string, Conv>();
  /** Everyone is a channel member in this fake; real access checks live in the server. */
  channelMembers = new Set<string>();

  api(userId: string, deviceId: string): Api {
    const store = new MemoryTokenStore({ accessToken: "a".repeat(43), accessExpiresAt: Date.now() + 3_600_000, refreshToken: "r".repeat(43), refreshExpiresAt: Date.now() + 3_600_000 });
    return new Api({ baseUrl: "http://test", store, fetch: (url, init) => this.handle(userId, deviceId, String(url), init) });
  }

  private reply(status: number, body: unknown): Response {
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private async handle(userId: string, deviceId: string, url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    const m = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    const path = u.pathname;
    const me = this.devices.get(deviceId);

    if (path === "/keys/packages/count") return this.reply(200, { count: me?.packages.length ?? 0 });
    if (path === "/keys/packages" && m === "POST") {
      this.devices.set(deviceId, { userId, deviceId, identityKey: body.identityKey, packages: [...(me?.packages ?? []), ...body.keyPackages] });
      return this.reply(200, { stock: body.keyPackages.length });
    }
    if (path === "/keys/packages/claim") {
      const keyPackages = [];
      for (const d of this.devices.values()) {
        if (!body.userIds.includes(d.userId) || d.deviceId === deviceId) continue;
        const kp = d.packages.shift();
        if (kp) keyPackages.push({ userId: d.userId, deviceId: d.deviceId, keyPackage: kp });
      }
      return this.reply(200, { keyPackages, exhausted: [] });
    }
    const keys = /^\/users\/([^/]+)\/keys$/.exec(path);
    if (keys) return this.reply(200, { devices: [...this.devices.values()].filter((d) => d.userId === keys[1]).map((d) => ({ deviceId: d.deviceId, identityKey: d.identityKey })) });

    if (path === "/conversations" && m === "POST" && body.kind === "channel") {
      const existing = this.channels.get(body.channelId);
      if (existing) return this.reply(409, { error: "already_exists", id: existing.id });
      const id = `chan${this.n++}`.padEnd(22, "A");
      const conv: Conv = { id, kind: "channel", channelId: body.channelId, epoch: 0, members: new Set(), devices: [{ userId, deviceId }], log: [] };
      this.convs.set(id, conv);
      this.channels.set(body.channelId, conv);
      return this.reply(201, this.view(conv));
    }
    if (path === "/conversations" && m === "POST" && body.kind === "group") {
      const id = `grp${this.n++}`.padEnd(22, "A");
      const conv: Conv = { id, kind: "group", channelId: null, epoch: 0, members: new Set([userId]), devices: [{ userId, deviceId }], log: [] };
      this.convs.set(id, conv);
      return this.reply(201, this.view(conv));
    }
    if (path === "/conversations" && m === "POST") {
      const peer = body.userId as string;
      const pair = [userId, peer].sort().join(":");
      let conv = this.dms.get(pair);
      if (!conv) {
        const id = `conv${this.n++}`.padEnd(22, "A");
        conv = { id, kind: "dm", channelId: null, epoch: 0, members: new Set([userId, peer]), devices: [{ userId, deviceId }], log: [] };
        this.convs.set(id, conv);
        this.dms.set(pair, conv);
      }
      return this.reply(201, this.view(conv));
    }
    const c = /^\/conversations\/([^/]+)(?:\/(\w+))?$/.exec(path);
    if (c) {
      const conv = this.convs.get(c[1]!);
      if (conv?.kind === "channel") conv.members.add(userId);
      if (!conv || !conv.members.has(userId)) return this.reply(404, { error: "not_found" });
      if (!c[2]) return this.reply(200, this.view(conv));
      if (c[2] === "envelopes") {
        const after = Number(u.searchParams.get("after") ?? 0);
        const envelopes = conv.log.filter((e) => e.seq > after && (e.to === undefined || e.to === deviceId));
        return this.reply(200, { envelopes, epoch: conv.epoch });
      }
      if (c[2] === "messages") {
        if (body.epoch !== conv.epoch) return this.reply(409, { error: "stale_epoch", epoch: conv.epoch });
        return this.reply(201, { seq: this.push(conv, { kind: "message", senderId: userId, senderDeviceId: deviceId, epoch: body.epoch, data: body.ciphertext }) });
      }
      if (c[2] === "commits") {
        if (body.epoch !== conv.epoch) return this.reply(409, { error: "stale_epoch", epoch: conv.epoch });
        const seq = this.push(conv, { kind: "commit", senderId: userId, senderDeviceId: deviceId, epoch: body.epoch, data: body.commit });
        conv.epoch++;
        for (const rm of (body.removes ?? []) as { deviceId: string }[]) conv.devices = conv.devices.filter((d) => d.deviceId !== rm.deviceId);
        for (const add of body.adds as { userId: string; deviceId: string }[]) {
          conv.devices.push(add);
          if (conv.kind === "group") conv.members.add(add.userId);
          this.push(conv, { kind: "welcome", senderId: userId, senderDeviceId: deviceId, epoch: conv.epoch, data: body.welcome, to: add.deviceId });
        }
        return this.reply(201, { seq, epoch: conv.epoch });
      }
    }
    return this.reply(404, { error: "not_found" });
  }

  private push(conv: Conv, e: Omit<Env, "seq" | "createdAt">): number {
    const seq = conv.log.length + 1;
    conv.log.push({ ...e, seq, createdAt: 1_700_000_000_000 + seq });
    return seq;
  }

  private view(conv: Conv) {
    return {
      id: conv.id,
      kind: conv.kind,
      serverId: null,
      channelId: conv.channelId,
      epoch: conv.epoch,
      members: [...conv.members].map((userId) => ({ userId, role: "member", pendingRemoval: false })),
      devices: conv.devices,
      createdAt: 0,
    };
  }
}
