/**
 * Permission flags and resolution.
 *
 * Permissions are a 64-bit set stored as a BigInt. This module is the only
 * place permissions are computed; every worker and client imports from here.
 */

export const Permission = {
  VIEW_CHANNEL: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  ATTACH_FILES: 1n << 2n,
  MANAGE_MESSAGES: 1n << 3n,
  CONNECT_VOICE: 1n << 4n,
  SPEAK: 1n << 5n,
  MUTE_MEMBERS: 1n << 6n,
  KICK: 1n << 7n,
  BAN: 1n << 8n,
  TIMEOUT: 1n << 9n,
  MANAGE_CHANNELS: 1n << 10n,
  MANAGE_ROLES: 1n << 11n,
  CREATE_INVITE: 1n << 12n,
  VIEW_AUDIT_LOG: 1n << 13n,
  ADMINISTRATOR: 1n << 14n,
  // Reserved for screen share (post-v1): STREAM: 1n << 15n
} as const;

export type PermissionName = keyof typeof Permission;

/**
 * What a timed-out member keeps: they can read, but not send, react, join
 * voice or act as a moderator until the timeout ends.
 */
export const TIMEOUT_ALLOWED: bigint = Permission.VIEW_CHANNEL;

/** Every permission bit defined in v1. */
export const ALL_PERMISSIONS: bigint = Object.values(Permission).reduce(
  (acc, bit) => acc | bit,
  0n,
);

const MASK_64 = (1n << 64n) - 1n;

export interface Role {
  id: string;
  permissions: bigint;
}

export interface Override {
  allow: bigint;
  deny: bigint;
}

export interface ChannelOverrides {
  /** Override for the @everyone role, if any. */
  everyone?: Override;
  /** Overrides keyed by role id. */
  roles?: Readonly<Record<string, Override>>;
  /** Overrides keyed by member (user) id. */
  members?: Readonly<Record<string, Override>>;
}

export interface PermissionContext {
  userId: string;
  ownerId: string;
  everyoneRole: Role;
  /** Roles held by the member, not including @everyone. */
  memberRoles: readonly Role[];
  channel?: ChannelOverrides;
  /** The member is in a timeout right now. Ignored for the owner and admins. */
  timedOut?: boolean;
}

export function has(permissions: bigint, flag: bigint): boolean {
  return (permissions & flag) === flag;
}

function apply(base: bigint, override: Override | undefined): bigint {
  if (!override) return base;
  return (base & ~override.deny) | override.allow;
}

function isOwnerOrAdmin(ctx: PermissionContext, base: bigint): boolean {
  return ctx.userId === ctx.ownerId || has(base, Permission.ADMINISTRATOR);
}

/** A timeout strips everything but reading, after overrides are applied. */
function restrict(ctx: PermissionContext, perms: bigint): bigint {
  return ctx.timedOut ? perms & TIMEOUT_ALLOWED : perms;
}

/** Server-level permissions: @everyone ORed with every member role. */
export function computeBasePermissions(ctx: PermissionContext): bigint {
  let perms = ctx.everyoneRole.permissions;
  for (const role of ctx.memberRoles) perms |= role.permissions;
  if (isOwnerOrAdmin(ctx, perms)) return ALL_PERMISSIONS;
  return restrict(ctx, perms) & MASK_64;
}

/**
 * Effective permissions in a channel.
 *
 * 1. Start with @everyone, OR in every member role.
 * 2. Server owner or ADMINISTRATOR: grant everything and stop.
 * 3. Apply channel overrides in order: @everyone, then all role denies,
 *    then all role allows, then the member override.
 * 4. A member in a timeout keeps only TIMEOUT_ALLOWED.
 */
export function computePermissions(ctx: PermissionContext): bigint {
  let perms = ctx.everyoneRole.permissions;
  for (const role of ctx.memberRoles) perms |= role.permissions;
  if (isOwnerOrAdmin(ctx, perms)) return ALL_PERMISSIONS;

  const channel = ctx.channel;
  if (!channel) return restrict(ctx, perms) & MASK_64;

  perms = apply(perms, channel.everyone);

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const role of ctx.memberRoles) {
    const override = channel.roles?.[role.id];
    if (!override) continue;
    roleDeny |= override.deny;
    roleAllow |= override.allow;
  }
  perms = (perms & ~roleDeny) | roleAllow;

  perms = apply(perms, channel.members?.[ctx.userId]);
  return restrict(ctx, perms) & MASK_64;
}

/** Serialize a permission set for JSON and D1 storage (decimal string). */
export function serializePermissions(permissions: bigint): string {
  return (permissions & MASK_64).toString();
}

export function parsePermissions(value: string): bigint {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > MASK_64) {
    throw new RangeError("permissions out of 64-bit range");
  }
  return parsed;
}
