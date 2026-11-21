import type { schemas } from "@bastion/shared";
import { useState } from "react";
import { describeSize, type Attachment } from "../lib/attachments.js";
import type { Controller } from "../lib/controller.js";
import { REPORT_CATEGORIES } from "./ServerAdmin.js";

/** Read a picked file, encrypt it on this device and upload it. */
export async function attachFile(controller: Controller, serverId: string, channelId: string, file: File): Promise<Attachment | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return controller.uploadAttachment(serverId, channelId, { name: file.name, type: file.type, bytes });
}

/** Files on a message. Saved as plain downloads, never opened in the page, whatever the file claims to be. */
export function Attachments({ controller, list }: { controller: Controller; list: Attachment[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function save(a: Attachment) {
    setBusy(a.id);
    setFailed(null);
    const bytes = await controller.fetchAttachment(a);
    setBusy(null);
    if (!bytes) {
      setFailed(a.id);
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = a.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <ul className="attachments">
      {list.map((a) => (
        <li key={a.id}>
          <span className="file-name">{a.name}</span> <small>{describeSize(a.size)}</small>{" "}
          <button className="link" disabled={busy === a.id} onClick={() => void save(a)}>
            {busy === a.id ? "Downloading…" : "Download"}
          </button>
          {failed === a.id && <small className="error"> Could not download.</small>}
        </li>
      ))}
    </ul>
  );
}

/** Report one message. The text sent is what this device decrypted; moderators can read it. */
export function ReportButton(props: { controller: Controller; serverId: string; channelId: string; message: schemas.Message; text: string }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<schemas.ReportCategory>("harassment");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  if (state === "sent") return <small> Reported. Thank you.</small>;
  if (!open) {
    return (
      <button className="link" onClick={() => setOpen(true)}>
        Report
      </button>
    );
  }
  return (
    <form
      className="report-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setState("sending");
        const result = await props.controller.reportMessages(
          props.serverId,
          props.channelId,
          category,
          [{ id: props.message.id, content: props.text }],
          note.trim() || undefined,
        );
        setState(result === undefined ? "failed" : "sent");
      }}
    >
      <p className="hint">Moderators of this server will be able to read this message. Your name is not shown to them.</p>
      <label>
        Why?
        <select value={category} onChange={(e) => setCategory(e.target.value as schemas.ReportCategory)}>
          {Object.entries(REPORT_CATEGORIES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Note (optional)
        <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </label>
      {state === "failed" && (
        <p role="alert" className="error">
          Could not send the report. Please try again.
        </p>
      )}
      <div className="controls">
        <button disabled={state === "sending"}>Send report</button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
