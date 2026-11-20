import type { schemas } from "@bastion/shared";

/**
 * The local test accounts. Fake addresses on the reserved `.test` domain; no
 * mail is ever sent to them.
 */
export interface Persona {
  handle: string;
  email: string;
  blurb: string;
  ageBand: schemas.AgeBand;
  accountState: schemas.AccountState;
  /** What each account looks like to the age and terms gate. */
  ageMethod: schemas.AgeMethod;
  /** Role in the seeded server; none means not a member. */
  membership: "owner" | "moderator" | "member" | null;
  staff?: boolean;
}

export const SEED_SERVER_NAME = "Bastion Dev";

export const PERSONAS: readonly Persona[] = [
  { handle: "alice", email: "alice@bastion.test", blurb: "Adult, owns the Bastion Dev server", ageBand: "18plus", accountState: "active", ageMethod: "verified", membership: "owner" },
  { handle: "bob", email: "bob@bastion.test", blurb: "Adult, moderator in Bastion Dev", ageBand: "18plus", accountState: "active", ageMethod: "verified", membership: "moderator" },
  { handle: "carol", email: "carol@bastion.test", blurb: "Adult, regular member of Bastion Dev", ageBand: "18plus", accountState: "active", ageMethod: "verified", membership: "member" },
  { handle: "dave", email: "dave@bastion.test", blurb: "Adult, in no server (use the invite to join)", ageBand: "18plus", accountState: "active", ageMethod: "verified", membership: null },
  { handle: "teen", email: "teen@bastion.test", blurb: "Declared 16 to 17: restricted, read only (alpha is 18+)", ageBand: "16to17", accountState: "restricted", ageMethod: "declared", membership: null },
  { handle: "review", email: "review@bastion.test", blurb: "Adult band but in age review", ageBand: "18plus", accountState: "pending_age_review", ageMethod: "declared", membership: null },
  { handle: "staff", email: "staff@bastion.test", blurb: "Adult; also unlocks the local /staff admin page", ageBand: "18plus", accountState: "active", ageMethod: "verified", membership: null, staff: true },
] as const;

export function personaByHandle(handle: unknown): Persona | undefined {
  return typeof handle === "string" ? PERSONAS.find((p) => p.handle === handle) : undefined;
}

/** The staff persona's address doubles as its staff id in the staff access log. */
export const DEV_STAFF_EMAIL = "staff@bastion.test";
export const DEV_STAFF_COOKIE = "bastion_dev_staff";
