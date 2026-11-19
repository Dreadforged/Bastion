import type { schemas } from "@bastion/shared";
import type { Api } from "./http.js";

/**
 * Passkey flows. The server speaks WebAuthn JSON (simplewebauthn); browsers
 * parse and serialize that shape natively, so there is no extra library.
 * `Passkeys` is injectable for tests.
 */
export interface Passkeys {
  create(options: unknown): Promise<unknown>;
  get(options: unknown): Promise<unknown>;
}

type JsonCredential = { toJSON(): unknown };
type CredentialStatics = {
  parseCreationOptionsFromJSON(o: unknown): PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON(o: unknown): PublicKeyCredentialRequestOptions;
};

export const browserPasskeys: Passkeys = {
  async create(options) {
    const statics = PublicKeyCredential as unknown as CredentialStatics;
    const cred = await navigator.credentials.create({ publicKey: statics.parseCreationOptionsFromJSON(options) });
    if (!cred) throw new Error("passkey_cancelled");
    return (cred as unknown as JsonCredential).toJSON();
  },
  async get(options) {
    const statics = PublicKeyCredential as unknown as CredentialStatics;
    const cred = await navigator.credentials.get({ publicKey: statics.parseRequestOptionsFromJSON(options) });
    if (!cred) throw new Error("passkey_cancelled");
    return (cred as unknown as JsonCredential).toJSON();
  },
};

export interface Registered {
  tokens: schemas.SessionTokens;
  recoveryCode?: string;
}

export class AuthClient {
  constructor(
    private readonly api: Api,
    private readonly passkeys: Passkeys = browserPasskeys,
  ) {}

  /** Step 1 of sign-up. The server answers the same whether or not the email exists. */
  startSignup(email: string): Promise<void> {
    return this.api.post("/auth/signup", { email }, { anonymous: true });
  }

  /** Email a link that adds this device to an existing account. */
  sendDeviceLink(email: string): Promise<void> {
    return this.api.post("/auth/devices/link", { email }, { anonymous: true });
  }

  /** Step 2: the page opened from the email link. Returns the one-time recovery code on sign-up. */
  async register(token: string, deviceName: string): Promise<Registered> {
    const options = await this.api.post<unknown>("/auth/passkeys/register/options", { token }, { anonymous: true });
    const response = await this.passkeys.create(options);
    const result = await this.api.post<Registered>(
      "/auth/passkeys/register",
      { token, deviceName, response },
      { anonymous: true },
    );
    this.api.setTokens(result.tokens);
    return result;
  }

  async signIn(): Promise<schemas.SessionTokens> {
    const { challengeId, options } = await this.api.post<{ challengeId: string; options: unknown }>(
      "/auth/signin/options",
      undefined,
      { anonymous: true },
    );
    const response = await this.passkeys.get(options);
    const tokens = await this.api.post<schemas.SessionTokens>("/auth/signin", { challengeId, response }, { anonymous: true });
    this.api.setTokens(tokens);
    return tokens;
  }

  /** Redeem a recovery code. Returns the enrollment token for registering a new passkey. */
  async recover(email: string, code: string): Promise<string> {
    const { token } = await this.api.post<{ token: string }>("/auth/recover", { email, code }, { anonymous: true });
    return token;
  }

  async signOut(): Promise<void> {
    try {
      await this.api.post("/auth/signout");
    } finally {
      this.api.setTokens(null);
    }
  }

  devices(): Promise<schemas.Device[]> {
    return this.api.get("/auth/devices");
  }

  revokeDevice(id: string): Promise<void> {
    return this.api.delete(`/auth/devices/${id}`);
  }
}

/** Pull the one-time token out of `#token=...` on the enroll page. */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash);
  return m?.[1] ?? null;
}
