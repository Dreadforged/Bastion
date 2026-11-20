import { schemas } from "@bastion/shared";

const BLOCKED: readonly schemas.AccountState[] = schemas.BLOCKED_STATES;

/**
 * What the person must do before the app opens, decided from their account
 * safety record. The server enforces the same limits; this only decides what
 * to show. Order matters: a blocked account sees nothing else.
 */
export type Gate =
  | { kind: "blocked" }
  | { kind: "too_young" }
  | { kind: "review" }
  | { kind: "declare" }
  /** Not from the server: asked last, once per browser (see lib/device.ts). */
  | { kind: "device" }
  | { kind: "terms"; outstanding: schemas.AccountSafety["termsOutstanding"] };

export function gateFor(safety: schemas.AccountSafety): Gate | null {
  if (BLOCKED.includes(safety.accountState)) return { kind: "blocked" };
  if (safety.accountState === "restricted") return { kind: "too_young" };
  if (safety.ageDeclarationRequired) return { kind: "declare" };
  if (safety.accountState === "pending_age_review") return { kind: "review" };
  if (safety.termsOutstanding.length > 0) return { kind: "terms", outstanding: safety.termsOutstanding };
  return null;
}

/** Birth months for the declaration form: this year back 100 years. */
export function birthYears(now: number): number[] {
  const year = new Date(now).getUTCFullYear();
  return Array.from({ length: 101 }, (_, i) => year - i);
}
