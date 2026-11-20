import type { schemas } from "@bastion/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown = null,
  ) {
    super(code);
  }
}

/** Where tokens live between page loads. */
export interface TokenStore {
  load(): schemas.SessionTokens | null;
  save(tokens: schemas.SessionTokens | null): void;
}

export class MemoryTokenStore implements TokenStore {
  constructor(private tokens: schemas.SessionTokens | null = null) {}
  load() {
    return this.tokens;
  }
  save(tokens: schemas.SessionTokens | null) {
    this.tokens = tokens;
  }
}

export class LocalTokenStore implements TokenStore {
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private readonly key = "bastion.session",
  ) {}
  load(): schemas.SessionTokens | null {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as schemas.SessionTokens;
    } catch {
      return null;
    }
  }
  save(tokens: schemas.SessionTokens | null) {
    if (tokens) this.storage.setItem(this.key, JSON.stringify(tokens));
    else this.storage.removeItem(this.key);
  }
}

export interface ApiOptions {
  baseUrl: string;
  store: TokenStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called when the session can no longer be refreshed. */
  onSignedOut?: () => void;
}

/** A random idempotency key. Retries of one logical write must reuse it. */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  /** Skip the Authorization header (sign-in and sign-up routes). */
  anonymous?: boolean;
}

/**
 * Thin fetch wrapper: JSON in and out, bearer token, one shared refresh when
 * the access token is about to lapse or the server says it already has.
 */
export class Api {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly opts: ApiOptions) {
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
    this.now = opts.now ?? Date.now;
  }

  get tokens() {
    return this.opts.store.load();
  }

  setTokens(tokens: schemas.SessionTokens | null) {
    this.opts.store.save(tokens);
  }

  get baseUrl() {
    return this.opts.baseUrl;
  }

  /** A usable access token, refreshing first if it is within a minute of expiry. */
  async accessToken(): Promise<string | null> {
    let tokens = this.tokens;
    if (!tokens) return null;
    if (tokens.accessExpiresAt - this.now() < 60_000) {
      await this.refresh();
      tokens = this.tokens;
    }
    return tokens?.accessToken ?? null;
  }

  /** Single flight: concurrent callers share one refresh. Returns false if it failed. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const tokens = this.tokens;
    if (!tokens) return false;
    const res = await this.fetchImpl(`${this.opts.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (res.ok) {
      this.setTokens((await res.json()) as schemas.SessionTokens);
      return true;
    }
    // Only a refusal ends the session; a flaky network or 5xx leaves it alone.
    if (res.status === 401 || res.status === 403) {
      this.setTokens(null);
      this.opts.onSignedOut?.();
    }
    return false;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    // Every signed-in write needs a key. Make one per call, so the retry after a token refresh reuses it.
    const key = options.idempotencyKey ?? (method !== "GET" && !options.anonymous ? newIdempotencyKey() : undefined);
    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers["content-type"] = "application/json";
      if (key) headers["idempotency-key"] = key;
      if (!options.anonymous) {
        const token = await this.accessToken();
        if (token) headers["authorization"] = `Bearer ${token}`;
      }
      const url = new URL(this.opts.baseUrl + path, globalThis.location?.href ?? "http://localhost");
      for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      return this.fetchImpl(url.toString(), {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    };

    let res = await send();
    if (res.status === 401 && !options.anonymous && this.tokens && (await this.refresh())) res = await send();
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? "request_failed", data);
    return data as T;
  }

  get<T>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>("GET", path, query ? { query } : {});
  }
  post<T>(path: string, body?: unknown, o: RequestOptions = {}) {
    return this.request<T>("POST", path, { ...o, ...(body !== undefined ? { body } : {}) });
  }
  put<T>(path: string, body?: unknown, o: RequestOptions = {}) {
    return this.request<T>("PUT", path, { ...o, ...(body !== undefined ? { body } : {}) });
  }
  patch<T>(path: string, body?: unknown, o: RequestOptions = {}) {
    return this.request<T>("PATCH", path, { ...o, ...(body !== undefined ? { body } : {}) });
  }
  delete<T>(path: string, body?: unknown) {
    return this.request<T>("DELETE", path, body !== undefined ? { body } : {});
  }
}
