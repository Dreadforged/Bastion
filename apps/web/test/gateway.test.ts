import { CloseCode, GATEWAY_AUTH_PREFIX, GATEWAY_PROTOCOL } from "@bastion/shared";
import { describe, expect, it } from "vitest";
import { backoffMs, Gateway, type SocketLike } from "../src/lib/gateway.js";

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: unknown[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  open() {
    this.onopen?.({});
  }
  frame(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

function rig() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const events: unknown[] = [];
  let token: string | null = "tok";
  const gw = new Gateway(
    {
      url: "ws://h/gateway",
      token: async () => token,
      createSocket: (u, p) => {
        const s = new FakeSocket(u, p);
        sockets.push(s);
        return s;
      },
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeout: () => {},
      random: () => 1,
    },
    { onReady: () => {}, onEvent: (t, d, s) => events.push([t, d, s]) },
  );
  const tick = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { gw, sockets, timers, events, setToken: (t: string | null) => (token = t), tick };
}

const ready = (seq: number) => ({ op: "ready", d: { userId: "U", seq, servers: [] } });

describe("Gateway", () => {
  it("connects with the auth subprotocol and identifies", async () => {
    const r = rig();
    r.gw.start();
    await r.tick();
    const s = r.sockets[0]!;
    expect(s.protocols).toEqual([GATEWAY_PROTOCOL, GATEWAY_AUTH_PREFIX + "tok"]);
    s.open();
    expect(s.sent).toEqual([{ op: "identify" }]);
    s.frame(ready(5));
    expect(r.gw.status).toBe("ready");
    expect(r.gw.seq).toBe(5);
  });

  it("tracks the sequence and resumes from it after a drop", async () => {
    const r = rig();
    r.gw.start();
    await r.tick();
    const s = r.sockets[0]!;
    s.open();
    s.frame(ready(5));
    s.frame({ op: "dispatch", t: "MESSAGE_CREATE", s: 6, d: {} });
    s.frame({ op: "dispatch", t: "TYPING_START", d: {} }); // ephemeral: no seq
    expect(r.gw.seq).toBe(6);
    expect(r.events).toHaveLength(2);

    s.drop();
    r.timers.at(-1)!.fn();
    await r.tick();
    const s2 = r.sockets[1]!;
    s2.open();
    expect(s2.sent).toEqual([{ op: "resume", seq: 6 }]);
    s2.frame({ op: "resumed", seq: 9 });
    expect(r.gw.seq).toBe(9);
    expect(r.gw.status).toBe("ready");
  });

  it("falls back to identify when the server forgot the session", async () => {
    const r = rig();
    r.gw.start();
    await r.tick();
    const s = r.sockets[0]!;
    s.open();
    s.frame(ready(1));
    s.drop();
    r.timers.at(-1)!.fn();
    await r.tick();
    const s2 = r.sockets[1]!;
    s2.open();
    s2.frame({ op: "invalid_session" });
    expect(s2.sent).toEqual([{ op: "resume", seq: 1 }, { op: "identify" }]);
    expect(r.gw.seq).toBeNull();
  });

  it("stops for good when the server ends the session", async () => {
    const r = rig();
    r.gw.start();
    await r.tick();
    r.sockets[0]!.open();
    const before = r.timers.length;
    r.sockets[0]!.drop(CloseCode.SESSION_ENDED);
    expect(r.gw.status).toBe("ended");
    expect(r.timers.length).toBe(before);
  });

  it("backs off with jitter, capped at 30 seconds", () => {
    expect(backoffMs(0, 1)).toBe(1000);
    expect(backoffMs(1, 1)).toBe(2000);
    expect(backoffMs(10, 1)).toBe(30_000);
    expect(backoffMs(0, 0)).toBe(500);
  });

  it("keeps retrying while no token is available", async () => {
    const r = rig();
    r.setToken(null);
    r.gw.start();
    await r.tick();
    expect(r.sockets).toHaveLength(0);
    expect(r.timers).toHaveLength(1);
    r.setToken("tok");
    r.timers[0]!.fn();
    await r.tick();
    expect(r.sockets).toHaveLength(1);
  });

  it("pings while open", async () => {
    const r = rig();
    r.gw.start();
    await r.tick();
    const s = r.sockets[0]!;
    s.open();
    r.timers.at(-1)!.fn();
    expect(s.sent.at(-1)).toEqual({ op: "ping" });
  });
});
