import {
  CloseCode,
  GATEWAY_AUTH_PREFIX,
  GATEWAY_PROTOCOL,
  type EventName,
  type GatewayServerFrame,
  type ReadyPayload,
} from "@bastion/shared";

export type GatewayStatus = "idle" | "connecting" | "ready" | "reconnecting" | "ended";

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface GatewayHandlers {
  /** A fresh start: replace all state with this. */
  onReady(ready: ReadyPayload): void;
  /** Events are upserts and may repeat; `s` is absent on ephemeral ones. */
  onEvent(name: EventName, data: unknown, seq: number | undefined): void;
  /** The missed events have all been delivered. */
  onResumed?(): void;
  onStatus?(status: GatewayStatus): void;
}

export interface GatewayOptions {
  /** ws(s):// URL of /gateway. */
  url: string;
  /** Fresh access token for each connection attempt, or null if signed out. */
  token: () => Promise<string | null>;
  createSocket?: (url: string, protocols: string[]) => SocketLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
  pingMs?: number;
}

const OPEN = 1;

/** Reconnect delay: 1s doubling to 30s, with up to 50% jitter. */
export function backoffMs(attempt: number, random: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.5 + random * 0.5));
}

/**
 * The realtime connection. Sends `identify` on a first connect and `resume`
 * with the last sequence number after a drop. Reconnects with backoff until
 * the server ends the session (4004) or `close()` is called.
 */
export class Gateway {
  status: GatewayStatus = "idle";
  /** Last sequence number applied; the resume point. */
  seq: number | null = null;

  private socket: SocketLike | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: unknown = null;
  private pinger: unknown = null;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;

  constructor(
    private readonly opts: GatewayOptions,
    private readonly handlers: GatewayHandlers,
  ) {
    this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000);
    this.socket = null;
    this.setStatus("ended");
  }

  private setStatus(s: GatewayStatus) {
    if (this.status === s) return;
    this.status = s;
    this.handlers.onStatus?.(s);
  }

  private clearTimers() {
    if (this.timer !== null) this.clearT(this.timer);
    if (this.pinger !== null) this.clearT(this.pinger);
    this.timer = this.pinger = null;
  }

  private async connect(): Promise<void> {
    this.setStatus(this.seq === null ? "connecting" : "reconnecting");
    let token: string | null;
    try {
      token = await this.opts.token();
    } catch {
      token = null;
    }
    if (this.stopped) return;
    if (!token) {
      // Signed out, or the token endpoint is down. Signed out is final.
      this.scheduleReconnect();
      return;
    }
    const create = this.opts.createSocket ?? ((u, p) => new WebSocket(u, p) as unknown as SocketLike);
    const socket = create(this.opts.url, [GATEWAY_PROTOCOL, GATEWAY_AUTH_PREFIX + token]);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify(this.seq === null ? { op: "identify" } : { op: "resume", seq: this.seq }));
      this.startPing(socket);
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.onFrame(socket, ev.data);
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      if (this.stopped) return;
      if (ev.code === CloseCode.SESSION_ENDED) {
        this.stopped = true;
        this.setStatus("ended");
        return;
      }
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // A close follows; reconnect logic lives there.
    };
  }

  private startPing(socket: SocketLike) {
    const every = this.opts.pingMs ?? 25_000;
    const tick = () => {
      if (this.socket !== socket) return;
      if (socket.readyState === OPEN) socket.send(JSON.stringify({ op: "ping" }));
      this.pinger = this.setT(tick, every);
    };
    this.pinger = this.setT(tick, every);
  }

  private scheduleReconnect() {
    this.setStatus("reconnecting");
    const delay = backoffMs(this.attempt++, (this.opts.random ?? Math.random)());
    this.timer = this.setT(() => void this.connect(), delay);
  }

  private onFrame(socket: SocketLike, raw: unknown) {
    let frame: GatewayServerFrame;
    try {
      frame = JSON.parse(String(raw)) as GatewayServerFrame;
    } catch {
      return;
    }
    switch (frame.op) {
      case "ready":
        this.seq = frame.d.seq;
        this.attempt = 0;
        this.setStatus("ready");
        this.handlers.onReady(frame.d);
        break;
      case "resumed":
        this.seq = frame.seq;
        this.attempt = 0;
        this.setStatus("ready");
        this.handlers.onResumed?.();
        break;
      case "invalid_session":
        // The replay window passed: start over with a fresh identify.
        this.seq = null;
        socket.send(JSON.stringify({ op: "identify" }));
        break;
      case "dispatch":
        if (frame.s !== undefined) this.seq = Math.max(this.seq ?? 0, frame.s);
        this.handlers.onEvent(frame.t, frame.d, frame.s);
        break;
      case "pong":
      case "error":
        break;
    }
  }
}
