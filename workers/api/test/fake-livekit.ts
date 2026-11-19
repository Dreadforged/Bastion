import type { LiveKitAdmin } from "../src/voice/livekit.js";

export type AdminCall =
  | { kind: "remove"; roomId: string; participantId: string }
  | { kind: "update"; roomId: string; participantId: string; canPublish: boolean; canShare: boolean };

/** Records what the Worker asked LiveKit to do. */
export class FakeLiveKitAdmin implements LiveKitAdmin {
  calls: AdminCall[] = [];
  failing = false;

  async removeParticipant(roomId: string, participantId: string): Promise<void> {
    if (this.failing) throw new Error("livekit down");
    this.calls.push({ kind: "remove", roomId, participantId });
  }

  async updatePermissions(roomId: string, participantId: string, p: { canPublish: boolean; canShare: boolean }): Promise<void> {
    if (this.failing) throw new Error("livekit down");
    this.calls.push({ kind: "update", roomId, participantId, ...p });
  }
}
