import type { schemas } from "@bastion/shared";
import type { DirectChat } from "./controller.js";

/**
 * The readable history this device holds, for "Export my messages".
 * The server cannot produce this: it only has ciphertext. Only what this
 * device has decrypted and kept is included, so a new device exports less.
 *
 * Attachment keys are left out so the export file does not carry secrets that
 * unlock files stored elsewhere; attachments appear by name, type and size.
 */
export interface ChatExport {
  format: "bastion-chat-export";
  version: 1;
  exportedAt: number;
  userId: string | null;
  direct: { conversationId: string; peerId: string; messages: ExportedMessage[] }[];
  channels: { channelId: string; messages: ExportedMessage[] }[];
  note: string;
}

export interface ExportedMessage {
  id: string | null;
  senderId: string;
  at: number;
  text: string;
  attachments: { name: string; mime: string; size: number }[];
}

const NOTE =
  "Only messages this device could read and still holds. Messages that are locked to this device, deleted, or sent before it joined are not included.";

function describe(payload: schemas.MessagePayload) {
  return {
    text: payload.text,
    attachments: (payload.attachments ?? []).map((a) => ({ name: a.name, mime: a.mime, size: a.size })),
  };
}

export function buildChatExport(
  input: {
    userId: string | null;
    dms: Record<string, DirectChat>;
    channelMessages: Record<string, schemas.Message[]>;
    plaintext: Record<string, schemas.MessagePayload | null>;
  },
  now: number,
): ChatExport {
  const direct = Object.values(input.dms).map((chat) => ({
    conversationId: chat.conversationId,
    peerId: chat.peerId,
    messages: chat.messages.map((m) => ({ id: null, senderId: m.senderId, at: m.createdAt, ...describe(m.payload) })),
  }));

  const channels: ChatExport["channels"] = [];
  for (const [channelId, list] of Object.entries(input.channelMessages)) {
    const messages: ExportedMessage[] = [];
    for (const m of list) {
      const payload = input.plaintext[m.id];
      if (!payload) continue;
      messages.push({ id: m.id, senderId: m.authorId, at: m.createdAt, ...describe(payload) });
    }
    if (messages.length > 0) channels.push({ channelId, messages });
  }
  return { format: "bastion-chat-export", version: 1, exportedAt: now, userId: input.userId, direct, channels, note: NOTE };
}

/** Save an object as a JSON file through the browser. Not used in tests. */
export function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
