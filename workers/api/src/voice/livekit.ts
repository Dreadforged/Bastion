import { schemas } from "@bastion/shared";
import type { VoiceEffect } from "@bastion/durable";
import { toBase64Url } from "../auth/crypto.js";

/**
 * LiveKit: access tokens for clients and the admin calls the Worker makes to
 * remove or restrict someone mid-call.
 *
 * LiveKit only ever sees random ids. The token has no name, metadata or
 * attributes, and the room id is not the channel id.
 */

export interface LiveKitConfig {
  /** wss:// URL clients connect to. */
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** What the Worker can tell LiveKit to do. Tests use a fake. */
export interface LiveKitAdmin {
  /** Disconnect one participant. Succeeds if they are already gone. */
  removeParticipant(roomId: string, participantId: string): Promise<void>;
  /** Change what a connected participant may publish. */
  updatePermissions(roomId: string, participantId: string, permissions: { canPublish: boolean; canShare: boolean }): Promise<void>;
}

export interface VoiceDeps {
  config: LiveKitConfig;
  admin: LiveKitAdmin;
}

const encoder = new TextEncoder();

async function sign(payload: Record<string, unknown>, secret: string): Promise<string> {
  const part = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)));
  const input = `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return `${input}.${toBase64Url(new Uint8Array(signature))}`;
}

export interface Grant {
  roomId: string;
  participantId: string;
  canPublish: boolean;
  canShare: boolean;
}

/** LiveKit source names for the video grant. Camera is never granted. */
function sources(canPublish: boolean, canShare: boolean): string[] {
  return [...(canPublish ? ["microphone"] : []), ...(canShare ? ["screen_share", "screen_share_audio"] : [])];
}

/**
 * A five minute token for one participant in one room. Publishing rights are
 * limited to what was checked: the microphone with SPEAK, screen share with STREAM.
 */
export async function issueToken(
  config: LiveKitConfig,
  grant: Grant,
  nowMs: number,
): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + schemas.VOICE_LIMITS.tokenTtlSeconds;
  const publish = grant.canPublish || grant.canShare;
  const token = await sign(
    {
      iss: config.apiKey,
      sub: grant.participantId,
      nbf: iat,
      iat,
      exp,
      video: {
        room: grant.roomId,
        roomJoin: true,
        canSubscribe: true,
        canPublish: publish,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        ...(publish ? { canPublishSources: sources(grant.canPublish, grant.canShare) } : {}),
      },
    },
    config.apiSecret,
  );
  return { token, expiresAt: exp * 1000 };
}

/** Talks to LiveKit's Twirp admin API over HTTPS. */
export class HttpLiveKitAdmin implements LiveKitAdmin {
  constructor(
    private readonly config: LiveKitConfig,
    private readonly now: () => number = Date.now,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async removeParticipant(roomId: string, participantId: string): Promise<void> {
    await this.call("RemoveParticipant", roomId, { room: roomId, identity: participantId });
  }

  async updatePermissions(roomId: string, participantId: string, p: { canPublish: boolean; canShare: boolean }): Promise<void> {
    const publish = p.canPublish || p.canShare;
    await this.call("UpdateParticipant", roomId, {
      room: roomId,
      identity: participantId,
      permission: {
        canSubscribe: true,
        canPublish: publish,
        canPublishData: false,
        canPublishSources: [...(p.canPublish ? ["MICROPHONE"] : []), ...(p.canShare ? ["SCREEN_SHARE", "SCREEN_SHARE_AUDIO"] : [])],
      },
    });
  }

  private async call(method: string, roomId: string, body: Record<string, unknown>): Promise<void> {
    const iat = Math.floor(this.now() / 1000);
    const token = await sign(
      { iss: this.config.apiKey, nbf: iat, iat, exp: iat + 60, video: { roomAdmin: true, room: roomId } },
      this.config.apiSecret,
    );
    const base = this.config.url.replace(/^ws/, "http").replace(/\/+$/, "");
    const response = await this.fetcher(`${base}/twirp/livekit.RoomService/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    // The person or room already being gone is the outcome we wanted.
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`livekit ${method} failed with ${response.status}`);
  }
}

/**
 * Carry out what a Server object asked for. Each call is independent and safe
 * to repeat; one failing does not stop the rest. Returns how many failed.
 */
export async function applyVoiceEffects(admin: LiveKitAdmin, effects: readonly VoiceEffect[] | undefined): Promise<number> {
  if (!effects || effects.length === 0) return 0;
  const results = await Promise.allSettled(
    effects.map((e) =>
      e.kind === "remove"
        ? admin.removeParticipant(e.roomId, e.participantId)
        : admin.updatePermissions(e.roomId, e.participantId, { canPublish: e.canPublish, canShare: e.canShare }),
    ),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  // Ids are random and carry nothing personal, so the count is all the log needs.
  if (failed > 0) console.error(`voice: ${failed} of ${effects.length} livekit calls failed`);
  return failed;
}
