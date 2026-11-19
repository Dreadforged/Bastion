import { computePermissions, parsePermissions, type ChannelOverrides, type Override, type schemas } from "@bastion/shared";

/**
 * Channel permissions for a set of users, worked out from one member's
 * server snapshot. Users who aren't server members get 0. Returns null when
 * the snapshot doesn't include the channel, which means the snapshot's owner
 * can't view it (or it's gone).
 */
export function channelPermissions(
  snapshot: schemas.ServerSnapshot,
  channelId: string,
  userIds: readonly string[],
  now: number,
): Map<string, bigint> | null {
  const channel = snapshot.channels.find((c) => c.id === channelId);
  if (!channel) return null;
  const serverId = snapshot.server.id;
  const roles = new Map(snapshot.roles.map((r) => [r.id, { id: r.id, permissions: parsePermissions(r.permissions) }]));
  const everyoneRole = roles.get(serverId);
  if (!everyoneRole) return null;

  const overrides: { everyone?: Override; roles: Record<string, Override>; members: Record<string, Override> } = { roles: {}, members: {} };
  for (const o of channel.overrides) {
    const value = { allow: parsePermissions(o.allow), deny: parsePermissions(o.deny) };
    if (o.kind === "member") overrides.members[o.targetId] = value;
    else if (o.targetId === serverId) overrides.everyone = value;
    else overrides.roles[o.targetId] = value;
  }
  const channelOverrides: ChannelOverrides = overrides;

  const members = new Map(snapshot.members.map((m) => [m.userId, m]));
  const out = new Map<string, bigint>();
  for (const userId of userIds) {
    const member = members.get(userId);
    if (!member) {
      out.set(userId, 0n);
      continue;
    }
    const memberRoles = member.roles.flatMap((id) => {
      const role = roles.get(id);
      return role ? [role] : [];
    });
    out.set(
      userId,
      computePermissions({
        userId,
        ownerId: snapshot.server.ownerId,
        everyoneRole,
        memberRoles,
        channel: channelOverrides,
        timedOut: member.timeoutUntil !== null && member.timeoutUntil > now,
      }),
    );
  }
  return out;
}
