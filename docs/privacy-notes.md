# Privacy page notes

Working notes for whoever writes the public privacy page and the marketing
"what we keep" table. Not a policy. The design is in the technical design v1
(data model, encryption design, open questions).

## What the server holds

| Data | Where | Readable by the server? | How long |
| --- | --- | --- | --- |
| Email address, created date | D1 `users` | Yes | Until the account is deleted |
| Recovery code | D1 `users` | Hash only (Argon2id) | Until used |
| Devices: name, passkey public key, last seen | D1 `devices` | Public key only | Until the device is removed |
| Sign-in sessions | D1 `sessions` | Hashes only | Access 15 minutes, refresh until expiry, then cleaned up hourly |
| Encryption keys: public identity key, one-time key packages | D1 | Public keys only | Until used or the device is removed |
| Server (community) names, channels, roles, members, invites | Server Durable Object, D1 `invite_codes` | Yes | Until deleted |
| Messages in servers and DMs | Durable Objects | No: ciphertext only | Until deleted, or the disappearing-message time |
| Files | R2 | Private files: no (encrypted on the device). Public-channel files: yes | Until deleted |
| Voice state (who is in which voice channel) | Server Durable Object | Yes | Only while the call is live. No call history |
| Reports | Server Durable Object | Only the messages the reporter chose to send | 90 days after closing |
| Audit log | Server Durable Object | Yes | 90 days |
| Privacy settings | D1 `privacy_settings` | Yes | Until the account is deleted |
| Age band (not a birth date), how it was learned, the month it expires, account state | D1 `users` | Yes | Until the account is deleted |
| Country code (two letters, never an IP address) | D1 `users` | Yes | Until the account is deleted |
| Age signals: kind, weight, date (no content) | D1 `age_signals` | Yes | 6 months |
| Which version of the terms and policies you accepted, and when | D1 `terms_acceptances` | Yes | Until the account is deleted |
| Legal holds on accounts, servers, files, reports | D1 `legal_holds` | Yes | Until released, then kept as a record |
| Staff access log (who looked at or changed what) and region flag history | D1 `staff_access_log`, `safety_flag_log` | Yes | To be decided with the lawyer |
| IP addresses | Not stored by us | n/a | Used as a rate limit key and never written down (see below) |

## Open question 1: routing metadata (answer for the page)

The design says to add this to the privacy page and the "what we keep" table.
The honest statement, from what the code does:

- The server has to route messages, so it knows **which accounts are in which
  conversation**, **that a message was sent and its size bucket** (messages are
  padded to 256 B, 1 KB, 4 KB, 16 KB or 64 KB), and **when**. It does not know
  what was said.
- For a DM, the server knows who the two people are and when they message. It
  also sees which device sent each message. "Sealed sender" (hiding the sender
  from the server) is planned for later, not built.
- Conversation ids are random, so they do not reveal the people in them, but
  the membership table links them.
- Server voice channels: the server knows who is in a call, when, and for how
  long while it is live, and keeps no history. The media servers see random room
  and participant ids and encrypted frames. They also see the network addresses
  of the people connecting, as any server does.
- Presence (online, idle, do not disturb) is shared with people who share a
  server with you. Choosing Invisible shares nothing. Typing indicators can be
  turned off in Settings, Privacy and data.
- Who may start a DM with you is a setting.

Suggested table rows for marketing: "Who talks to whom, and when: yes, the
server needs this to deliver messages. What is said: no."

## Open question 2: Cloudflare as a subprocessor (answer for the page)

Cloudflare hosts the service, so it is a subprocessor and must be on the
subprocessor list. State plainly:

- Cloudflare processes network traffic, including IP addresses, as our network
  provider. We never write IP addresses to our own storage, and we use the
  Workers rate limiting binding with the address only as a key.
- Cloudflare stores our data (D1, Durable Objects, R2) and so holds the
  ciphertext, the metadata above, and public-channel content and files.
  Encrypted messages and private files are unreadable to Cloudflare without
  keys that only devices have.
- Cloudflare can see public-channel traffic and traffic metadata.
- Some privacy-minded people object to Cloudflare being in the traffic path.
  Say so on the page and ask in interviews whether it matters (self-hosting
  scope, risks list).
- Voice and screen share media do not go through Cloudflare. They go to our own
  LiveKit media servers (see the streaming plan). That host is also a
  subprocessor once chosen, and the page should name it.

Still to name on the subprocessor list: the transactional email provider (an
open question in the design, one that signs a data processing agreement and does
not track opens or clicks), the media server host, and the code scanning
service for public images once chosen.

## Wording that is allowed and not allowed

- Do not use the phrase "end-to-end encrypted" in marketing or on the website
  until the outside review of the encryption code has passed. Inside the app,
  describing how messages are protected is fine. See the launch checklist.
- Do not say "audited" until the audit is published.
- Do not claim metadata privacy. Say what the server can see (above).
- Voice-privacy claims wait for the review to cover voice.
- A future broadcast feature must be labeled "encrypted in transit".
- New devices start fresh and do not see older messages. Losing every device
  and the recovery code loses message history. Say so.

## Data export and settings (shipped in milestone 7)

- Settings, Privacy and data: who can start a DM with you, typing indicators,
  and two exports.
- **Account data export** (server): email, devices, public keys, servers,
  conversation list, file records, settings. Limited to 3 an hour.
- **Message export** (device): the readable history this device holds.
  A new device has less. Attachment keys are left out.
- Not built yet: account deletion, which the privacy page and legal checklist
  will need before alpha users rely on "delete my data".
