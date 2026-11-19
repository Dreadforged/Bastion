# LiveKit server hardening checklist

Voice and screen share run on a LiveKit media server. This is how to set one
up and what to check. **Nothing here orders or rents a server.** Do that
yourself, then run [`ops/livekit/setup.sh`](../../ops/livekit/setup.sh) on it.

The script has not been run against a real server yet. Treat the first run as
a dry run on a throwaway VM and read the output.

## What the server is allowed to know

Bastion's promise is that the voice server learns as little as possible.

| Thing | LiveKit sees it? |
| --- | --- |
| Channel name, server name | No. Rooms are random 128-bit ids. |
| User id, email, display name | No. Participants are random 128-bit ids, new for every join. |
| Who is in which call, mapped to people | No. Only the Server object knows that, and only while the call is live. |
| Audio and video content | Not readable for calls joined with client-side E2EE (ADR 0004; written but not yet run against a real LiveKit server or real browsers). A call joined without it is encrypted in transit (DTLS-SRTP) but the server can see media. |
| Network addresses of participants | Unavoidably, to route packets. Not logged or kept (below). |

## Design rules

- **One purpose.** The server runs LiveKit and a TLS proxy. Nothing else.
- **No Egress.** No recording, no composite streams, no RTMP out. The config
  has no `egress` section and the host has no Egress service or Redis.
- **No Ingress.** Same reason.
- **Webhooks off.** There is no `webhook` section, so LiveKit sends no events
  anywhere. Call state is tracked by the Worker, with leases (ADR 0003).
- **No telemetry, no Prometheus endpoint.** Turn metrics on only for a
  specific investigation, bound to localhost, and turn them off again.
- **Secrets stay out of git.** The API key and secret are made on the server
  and go into Worker secrets (`wrangler secret put`). Never commit them.
- **Pinned versions.** `LIVEKIT_VERSION` has no default. Read the release
  notes before bumping it.

## Before running the script

- [ ] A fresh Ubuntu 24.04 LTS VM, in a region close to your users.
- [ ] A DNS A (and AAAA) record for `LIVEKIT_DOMAIN` pointing at it. Caddy
      needs this to get a certificate.
- [ ] Your SSH **public** key (ed25519). Keep the private key off the server.
- [ ] A second way in for emergencies, such as the provider's web console.
      The script turns off password login and root login.
- [ ] You have read the script.

## What the script does

- **SSH.** Key only, no root, no passwords, one allowed user, three tries,
  no forwarding, `LogLevel QUIET` so connecting addresses are not written to
  the auth log. The trade-off: failed logins are not logged either, so rely on
  key-only access and the firewall rate limit.
- **Firewall (ufw).** Default deny in. Open: SSH (rate limited), 80/tcp (ACME),
  443/tcp (signaling), 7881/tcp (WebRTC over TCP), 3478/udp (TURN),
  50000-60000/udp (media). Firewall logging off.
- **Automatic updates.** `unattended-upgrades` for security fixes, with a
  reboot at `AUTO_REBOOT_TIME` (default 04:00) when needed. A reboot ends
  live calls, so pick a quiet hour or set it to `never` and reboot by hand.
- **Logs without IPs.** LiveKit logs at `warn`; routine connection lines,
  which include addresses, are not written. journald is in memory only
  (`Storage=volatile`), capped at 50 MB and 3 days. Caddy's own log is
  discarded and no access log is configured. No fail2ban, because it exists to
  store addresses.
- **LiveKit and Caddy in containers**, read-only, no capabilities, no new
  privileges, the LiveKit config mounted read-only.
- **Config.** Signaling on localhost behind Caddy. Built-in TURN over UDP.
  A generated API key and secret in `/etc/livekit/livekit.yaml` (mode 640).
  `max_participants: 100` per room as a backstop; the real viewer limits are
  enforced by the Worker (ADR 0003).

## After running the script

Do these from a second terminal before closing the first.

- [ ] `ssh <ADMIN_USER>@<host>` works with your key.
- [ ] `ssh root@<host>` is refused. `ssh -o PubkeyAuthentication=no <ADMIN_USER>@<host>` is refused.
- [ ] `sudo ufw status verbose` shows exactly the rules above and `Logging: off`.
- [ ] From outside, `nmap -Pn <host>` (your own server only) shows only SSH,
      80 and 443 over TCP, plus 7881.
- [ ] `systemctl status livekit caddy-livekit` are both active.
- [ ] `curl -I https://<LIVEKIT_DOMAIN>` returns a response over a valid certificate.
- [ ] `grep -nE 'egress|ingress|webhook|redis|prometheus' /etc/livekit/livekit.yaml`
      prints nothing.
- [ ] `sudo journalctl -u livekit --since "10 min ago"` contains no client
      addresses. Make a test call first, then check again.
- [ ] `ls /var/log/journal` does not exist (journald is volatile).
- [ ] `sudo unattended-upgrade --dry-run -v` runs without errors.
- [ ] `/etc/livekit/livekit.yaml` is not world readable (`ls -l`).
- [ ] The API key and secret are saved as Worker secrets and are not in your
      shell history (clear it) or any file in the repo.
- [ ] End to end on staging: join a call with two browsers, speak, share a
      screen, then have a moderator end the stream and remove someone. Both
      must take effect at LiveKit, not just in the app.
- [ ] Confirm that taking away the screen share source really stops a running
      share (`updatePermissions` in `workers/api/src/voice/livekit.ts`). If your
      LiveKit version leaves the track up, fall back to removing the
      participant and tell the client to rejoin.

## Worker settings

Non-secret, in `wrangler.toml` under each environment's `[vars]`:

```
LIVEKIT_URL = "wss://voice.example.org"
```

Secrets, with `wrangler secret put <NAME> --env <env>`:

```
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
```

Until all three are set, `POST /servers/:id/voice/token` answers `503
voice_unavailable` and nothing else about voice changes.

## Ongoing

- [ ] Watch for LiveKit releases and security notices; update the pinned
      version on staging first.
- [ ] Rotate the API key and secret if anyone who had them leaves, or yearly.
      Edit `/etc/livekit/livekit.yaml`, restart `livekit`, update the Worker
      secrets in the same minute. Existing tokens live five minutes.
- [ ] Rebuild rather than repair a server you cannot explain. The setup is a
      script on purpose.
- [ ] Capacity: a free stream allows 25 viewers at 720p30 and a Plus stream
      50 at 1080p60. One 1080p60 stream with 50 viewers is about 300 Mbps
      out of the server. Size the VM's network, not just its CPU.

## Known gaps

- Worker-to-LiveKit calls (remove a person, restrict publishing) are made
  once, best effort. If LiveKit is down at that moment the person stays
  connected until they leave or their token-less reconnect fails. A retry
  queue is future work.
- The abuse report path for voice and screen share is not built.
