export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** The email provider is not chosen yet; everything sends through this. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Keeps sent messages in memory. Used by tests and local dev. */
export class StubEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  constructor(private readonly log = false) {}

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    // Local dev only: print the message so links can be clicked from the terminal.
    if (this.log) console.log(`[email stub] to=${message.to} subject=${message.subject}\n${message.text}`);
  }
}

export function createEmailSender(environment: string): EmailSender {
  if (environment === "development") return new StubEmailSender(true);
  return {
    async send() {
      throw new Error("no email provider configured");
    },
  };
}
