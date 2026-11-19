# 0002. 64-bit permission bitmask with channel overrides

- Status: accepted
- Date: 2026-11-18

## Context

Servers need roles and per-channel permission overrides that resolve the same
way on every worker and client.

## Decision

Permissions are a 64-bit set (BigInt in TypeScript, decimal string over JSON
and in D1), computed only in `workers/shared/src/permissions.ts`.

v1 flags: VIEW_CHANNEL, SEND_MESSAGES, ATTACH_FILES, MANAGE_MESSAGES,
CONNECT_VOICE, SPEAK, MUTE_MEMBERS, KICK, BAN, TIMEOUT, MANAGE_CHANNELS,
MANAGE_ROLES, CREATE_INVITE, VIEW_AUDIT_LOG, ADMINISTRATOR, STREAM (bit 15,
screen share, added with voice and not in the default @everyone set).

Resolution:

1. Start with the @everyone role and OR in all of the member's roles.
2. If the member is the server owner or has ADMINISTRATOR, grant everything and stop.
3. Apply channel overrides in order: @everyone, role overrides (all denies,
   then all allows), then the member override.

## Consequences

- New flags take the next free bit; bits are never reused or reordered.
- Role allows beat role denies within a channel; a member override beats both.
