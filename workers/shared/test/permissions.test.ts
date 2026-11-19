import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  Permission,
  computeBasePermissions,
  computePermissions,
  has,
  parsePermissions,
  serializePermissions,
  type PermissionContext,
} from "../src/permissions.js";

const P = Permission;

function ctx(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    userId: "user",
    ownerId: "owner",
    everyoneRole: { id: "everyone", permissions: P.VIEW_CHANNEL | P.SEND_MESSAGES },
    memberRoles: [],
    ...overrides,
  };
}

describe("permission flags", () => {
  it("are distinct single bits within 64 bits", () => {
    const bits = Object.values(Permission);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) {
      expect(bit & (bit - 1n)).toBe(0n);
      expect(bit < 1n << 64n).toBe(true);
    }
  });

  it("round-trips through serialization", () => {
    expect(parsePermissions(serializePermissions(ALL_PERMISSIONS))).toBe(ALL_PERMISSIONS);
    expect(() => parsePermissions((1n << 64n).toString())).toThrow(RangeError);
  });
});

describe("computePermissions", () => {
  it("starts from @everyone and ORs in member roles", () => {
    const perms = computePermissions(
      ctx({ memberRoles: [{ id: "mod", permissions: P.KICK | P.TIMEOUT }] }),
    );
    expect(perms).toBe(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.KICK | P.TIMEOUT);
  });

  it("grants everything to the server owner, ignoring overrides", () => {
    const perms = computePermissions(
      ctx({ userId: "owner", channel: { everyone: { allow: 0n, deny: P.VIEW_CHANNEL } } }),
    );
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  it("grants everything to ADMINISTRATOR, ignoring overrides", () => {
    const perms = computePermissions(
      ctx({
        memberRoles: [{ id: "admin", permissions: P.ADMINISTRATOR }],
        channel: { members: { user: { allow: 0n, deny: P.SEND_MESSAGES } } },
      }),
    );
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  it("applies @everyone override, then role denies, role allows, member override", () => {
    const base = ctx({
      memberRoles: [
        { id: "a", permissions: 0n },
        { id: "b", permissions: 0n },
      ],
      channel: {
        everyone: { allow: 0n, deny: P.SEND_MESSAGES },
        roles: {
          // A role allow wins over a deny from a different role.
          a: { allow: 0n, deny: P.ATTACH_FILES | P.VIEW_CHANNEL },
          b: { allow: P.SEND_MESSAGES | P.ATTACH_FILES, deny: 0n },
        },
      },
    });
    const perms = computePermissions(base);
    expect(has(perms, P.SEND_MESSAGES)).toBe(true);
    expect(has(perms, P.ATTACH_FILES)).toBe(true);
    expect(has(perms, P.VIEW_CHANNEL)).toBe(false);

    const withMember = computePermissions({
      ...base,
      channel: {
        ...base.channel,
        members: { user: { allow: P.VIEW_CHANNEL, deny: P.SEND_MESSAGES } },
      },
    });
    expect(has(withMember, P.VIEW_CHANNEL)).toBe(true);
    expect(has(withMember, P.SEND_MESSAGES)).toBe(false);
  });
});

describe("computeBasePermissions", () => {
  it("ignores channel overrides", () => {
    const perms = computeBasePermissions(
      ctx({ channel: { everyone: { allow: 0n, deny: P.VIEW_CHANNEL | P.SEND_MESSAGES } } }),
    );
    expect(perms).toBe(P.VIEW_CHANNEL | P.SEND_MESSAGES);
  });

  it("gives the owner and ADMINISTRATOR everything", () => {
    expect(computeBasePermissions(ctx({ userId: "owner" }))).toBe(ALL_PERMISSIONS);
    expect(
      computeBasePermissions(ctx({ memberRoles: [{ id: "admin", permissions: P.ADMINISTRATOR }] })),
    ).toBe(ALL_PERMISSIONS);
  });
});

describe("channel override edge cases", () => {
  it("lets an @everyone override allow a bit the roles lack", () => {
    const perms = computePermissions(
      ctx({ channel: { everyone: { allow: P.ATTACH_FILES, deny: 0n } } }),
    );
    expect(has(perms, P.ATTACH_FILES)).toBe(true);
  });

  it("ignores overrides for roles the member does not hold", () => {
    const perms = computePermissions(
      ctx({ channel: { roles: { other: { allow: P.MANAGE_MESSAGES, deny: P.VIEW_CHANNEL } } } }),
    );
    expect(perms).toBe(P.VIEW_CHANNEL | P.SEND_MESSAGES);
  });

  it("ignores overrides for other members", () => {
    const perms = computePermissions(
      ctx({ channel: { members: { someoneElse: { allow: 0n, deny: P.VIEW_CHANNEL } } } }),
    );
    expect(has(perms, P.VIEW_CHANNEL)).toBe(true);
  });

  it("lets a member allow beat both @everyone and role denies", () => {
    const perms = computePermissions(
      ctx({
        memberRoles: [{ id: "muted", permissions: 0n }],
        channel: {
          everyone: { allow: 0n, deny: P.SEND_MESSAGES },
          roles: { muted: { allow: 0n, deny: P.SEND_MESSAGES } },
          members: { user: { allow: P.SEND_MESSAGES, deny: 0n } },
        },
      }),
    );
    expect(has(perms, P.SEND_MESSAGES)).toBe(true);
  });

  it("lets a role deny remove a bit granted at server level", () => {
    const perms = computePermissions(
      ctx({
        memberRoles: [{ id: "muted", permissions: 0n }],
        channel: { roles: { muted: { allow: 0n, deny: P.SEND_MESSAGES } } },
      }),
    );
    expect(has(perms, P.SEND_MESSAGES)).toBe(false);
    expect(has(perms, P.VIEW_CHANNEL)).toBe(true);
  });

  it("never returns bits above 64", () => {
    const perms = computePermissions(
      ctx({ channel: { everyone: { allow: 1n << 70n, deny: 0n } } }),
    );
    expect(perms < 1n << 64n).toBe(true);
  });
});
