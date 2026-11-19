# 0004. Voice end-to-end encryption keys come from the MLS group

- Status: proposed (waiting for the WASM build of the crypto crate)
- Date: 2026-11-19

## Context

Voice and screen share currently rely on transport encryption (DTLS-SRTP), so
the LiveKit server can see media. Text is end-to-end encrypted with MLS, and
voice should match for channels that are encrypted. The client MLS library is
not available in browsers until the crypto crate's WASM build is done.

## Decision

Use LiveKit's client-side media encryption (insertable streams, frame
encryption with a shared key provider). The key for a call comes from the MLS
group that protects the channel:

```
baseKey = MLS-Exporter("bastion/voice/v1", utf8(roomId), 32)
```

- The group is the voice channel's encrypted conversation. Only its members can
  compute the key.
- The random room id from the voice token is the exporter context, so every call
  gets its own key, even within one epoch.
- When the MLS epoch changes (someone joins or leaves the group), clients
  derive and install a new key. Removing a person from the group stops them
  decrypting new media.
- The server, and LiveKit, never see the key and cannot derive it.

The contract is in `workers/shared/src/voice-e2ee.ts` (`VOICE_E2EE`,
`VoiceKeyDeriver`, `VoiceMediaKeys`). It is types and constants only. Nothing
on the server depends on it, and nothing in the voice code changes when the
client side lands, because the server already hands out only random ids.

## To do when the WASM build exists

- [ ] Add an exporter method to the crypto crate's WASM API:
      `export_secret(label, context, length)`.
- [ ] Implement `VoiceKeyDeriver` and `VoiceMediaKeys` in the web client and
      pass the key to LiveKit's key provider.
- [ ] Decide which channels are encrypted. Unencrypted voice channels keep
      transport encryption only and the UI must say so.
- [ ] Rotation: how long frames from the previous epoch keep decrypting, to
      avoid dropouts while everyone catches up.
- [ ] Late joiners: they need the current epoch, so they join the MLS group
      first; a Welcome is the gate.
- [ ] Screen share uses the same key. Check LiveKit's support for separate
      keys per track if we want to limit who can decrypt a stream.

## Consequences

- Moderators removing someone from a call (a LiveKit disconnect) is separate
  from removing them from the MLS group. A kick or ban does both.
- If the exporter label or length changes, bump the version in the label.
- Until this lands, the hardening doc is honest that the media server can see
  media.
