# 0004. Voice end-to-end encryption keys come from the MLS group

- Status: accepted, needs human review of the crypto before launch (see "Not verified")
- Date: 2026-11-19

## Context

Voice and screen share rely on transport encryption (DTLS-SRTP), so the
LiveKit server can see media. Text is end-to-end encrypted with MLS, and voice
should match.

## Decision

Use LiveKit's client-side media encryption: an encoded transform in a worker
encrypts each frame (AES-GCM, per-sender keys derived with HKDF from the shared
key, key slot carried in every frame). We do not write our own frame cipher.
What we write is where the key comes from and when it changes.

```
baseKey = MLS-Exporter("bastion/voice/v1", utf8(roomId), 32)
```

- **Which group.** A voice channel uses the channel's encrypted conversation,
  so its members are everyone who can view the channel. A DM call uses a fresh
  `group` conversation made for that call (`startDmCallGroup`), so call keys
  have nothing to do with the DM's message history.
- **Room id as context.** The random room id from the voice token separates
  calls within one epoch. The server and LiveKit never see the key and cannot
  derive it, because they are not in the group.
- **Rotation.** Any epoch change installs a new key: a join or leave of the call
  (a self-update commit by one remaining participant), someone removed from the
  group (kick, ban, lost access: the server marks them pending removal and a
  member commits the removal), or any other commit. The device that commits is
  the lowest participant id other than the one who joined or left, so one
  commit lands. If it does not act within 3 s per rank, the next device does,
  but only if the epoch still has not moved. A lost commit race counts as done.
- **Receiving versus sending.** A new key is used for decrypting at once.
  Sending switches 500 ms later (except the first key of a call), so peers that
  have not applied the commit yet do not hear a gap. Frames carry their key
  slot (`epoch % 16`), so frames from the last 15 epochs still decrypt.
- **Joining needs the group.** A device must already be in the group (it holds a
  Welcome). If not, the join fails with `not_in_group`; it does not fall back.
- **No silent downgrade.** If the browser cannot do encoded transforms, or the
  device is not in the group, joining fails. Joining with transport encryption
  only needs `allowTransportOnly` and the call reports `encryption: "transport"`
  so the UI must say so. Nothing sets that option yet.
- **Screen share** uses the same key and the same frame encryption. Quality is
  clamped to the grant the server returned (720p30 free, 1080p60 plus) and
  needs a token that asked for screen share (STREAM permission), so the client
  check is a convenience: the token, not the client, decides.
- **Removed from the call is not removed from the group.** A moderator
  disconnect (LiveKit) is separate from removing someone from the MLS group; a
  kick or ban does both.

## Known limits

- Everyone who can view a voice channel is in its MLS group. A member who is
  not in the call can compute the call key if they also learn the room id and
  capture the ciphertext. The room id is only given to people with a token, so
  this needs a second leak; a per-call group would close it and costs a
  Welcome per call. Not done.
- A leaver who stays in the group can derive later keys. Leaving does not cut
  them off; only removal from the group does. Media access itself is gated by
  the LiveKit token.
- Opus frames are variable length and the length is visible, which leaks some
  information about speech. Not mitigated.
- The first byte of audio frames and the first 3 or 10 bytes of video frames
  (codec headers the media server needs) stay unencrypted. That is LiveKit's
  behaviour.
- A DM call needs a server route to hand out LiveKit tokens for a DM call and a
  way to ring the other person. Neither exists yet; only the group side does.

## Not verified

Run: Rust tests for the exporter, wasm build, and the web tests for key
derivation, rotation, DM call groups, the call flow against a fake room, and
the key provider's events (real MLS through WASM, no browser).

Not run, because it needs things we do not have here: a real LiveKit server,
and real browsers. Chrome, Firefox and Safari behave differently for encoded
transforms, and the worker and the screen share capture settings have never
executed. In particular untested: that frames actually come out encrypted on
the wire, that a keyframe after rotation decodes, Safari's lack of some codecs
with E2EE, and what LiveKit does when a participant's token loses the
screen share permission mid-call. The crypto changes (exporter, key
derivation, rotation) need review by a person before launch.

## Consequences

- If the exporter label or length changes, bump the version in the label.
- LiveKit's E2EE is marked experimental in the SDK; its API may change.
- The hardening doc still says the media server can see media for any call
  that joins without `encryption: "e2ee"`.
