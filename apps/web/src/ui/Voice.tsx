import { useState } from "react";
import type { schemas } from "@bastion/shared";
import type { AppState, Controller } from "../lib/controller.js";
import type { VoiceUi } from "../voice/service.js";

/** Short stand-in for a user id until profiles exist. */
function who(userId: string): string {
  return userId.slice(-6).toLowerCase();
}

const NOTICES: Record<string, string> = {
  incoming_call: "Incoming call",
  call_declined: "The call was declined.",
  no_answer: "No answer.",
  call_dropped: "The call was disconnected.",
  call_ended: "The call ended.",
};

/** Plain words for what went wrong joining or starting a call. */
export function voiceErrorText(code: string): string {
  switch (code) {
    case "not_in_group":
      return "This device has not set up encryption for this call yet. Try again in a moment.";
    case "unsupported_browser":
      return "This browser cannot encrypt calls, so the call was not started.";
    case "key_unavailable":
      return "The other person has no device that can take the call yet.";
    case "already_in_call":
      return "Leave your current call first.";
    case "call_in_progress":
      return "There is already a call in this conversation.";
    case "voice_unavailable":
      return "Voice is not available on this server.";
    default:
      return code;
  }
}

/** Who is in each voice channel, with mute and screen share marks. Shown under the channel name. */
export function VoiceParticipants({ voice, channelId, me }: { voice: Record<string, schemas.VoiceState>; channelId: string; me: string | null }) {
  const people = Object.values(voice).filter((v) => v.channelId === channelId);
  if (people.length === 0) return null;
  return (
    <ul className="participants" aria-label="In call">
      {people.map((p) => (
        <li key={p.userId}>
          {who(p.userId)}
          {p.userId === me && " (you)"}
          {p.selfMute && <small title="Muted"> muted</small>}
          {p.streaming && <small title="Sharing their screen"> live</small>}
        </li>
      ))}
    </ul>
  );
}

/** Rings for DM calls, and the notice after one ends. */
export function CallAlerts({ controller, state }: { controller: Controller; state: AppState }) {
  const notice = state.callNotice && state.callNotice !== "incoming_call" ? NOTICES[state.callNotice] : null;
  if (state.incomingCalls.length === 0 && !notice) return null;
  return (
    <div className="call-alerts" role="region" aria-label="Calls">
      {state.incomingCalls.map((call) => (
        <div key={call.id} className="ring" role="alert">
          <span>{who(call.callerId)} is calling…</span>
          <button onClick={() => void controller.answerCall(call)} disabled={state.voice !== null} title={state.voice ? "Leave your current call first" : ""}>
            Answer
          </button>
          <button onClick={() => void controller.declineCall(call)}>Decline</button>
        </div>
      ))}
      {notice && (
        <p role="status" className="notice">
          {notice}{" "}
          <button className="link" onClick={() => controller.dismissCallNotice()}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}

/** The call this device is in: state, encryption, mute, screen share and leave. */
export function CallBar({ controller, ui }: { controller: Controller; ui: VoiceUi }) {
  const [tier, setTier] = useState(() => Math.max(0, ui.tiers.length - 1));
  const title = ui.kind === "dm" ? `Call with ${who(ui.peerId ?? "")}` : "Voice channel";
  const status = { calling: "Calling…", connecting: "Connecting…", connected: "Connected" }[ui.phase];
  const chosen = ui.tiers[Math.min(tier, ui.tiers.length - 1)];
  const busy = ui.phase !== "connected";
  return (
    <section className="callbar" aria-label="Current call">
      <div>
        <strong>{title}</strong> <span className="status">{status}</span>
      </div>
      {ui.encryption === "e2ee" && <small className="secure">End-to-end encrypted</small>}
      {ui.encryption === "transport" && (
        <small className="warn" role="alert">
          Not end-to-end encrypted: the media server can hear this call.
        </small>
      )}
      <div className="controls">
        {ui.phase !== "calling" && (
          <button aria-pressed={ui.muted} disabled={busy} onClick={() => void controller.setMuted(!ui.muted)}>
            {ui.muted ? "Unmute" : "Mute"}
          </button>
        )}
        {ui.canShare && ui.phase !== "calling" && (
          <>
            {!ui.sharing && ui.tiers.length > 1 && (
              <select aria-label="Screen share quality" value={tier} onChange={(e) => setTier(Number(e.target.value))}>
                {ui.tiers.map((t, i) => (
                  <option key={t.label} value={i}>
                    {t.label}
                  </option>
                ))}
              </select>
            )}
            <button disabled={busy} onClick={() => void (ui.sharing ? controller.stopShare() : controller.startShare(chosen))}>
              {ui.sharing ? "Stop sharing" : "Share screen"}
            </button>
          </>
        )}
        <button onClick={() => void controller.leaveVoice()}>{ui.phase === "calling" ? "Cancel" : ui.kind === "dm" ? "Hang up" : "Leave"}</button>
      </div>
    </section>
  );
}
