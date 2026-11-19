import { z } from "zod";
import { Id } from "./ids.js";

/**
 * Safety groundwork: account age band and state, region flags, reason codes,
 * terms acceptance and legal holds. See docs/safety-and-compliance-plan.md.
 *
 * Design rule: Bastion plans for children being present even when the minimum
 * age is higher. Nothing here reads encrypted content. Age is a band that
 * expires, never a birth date, and country is a two letter code, never an IP.
 */

// ------------------------------------------------------------------ age and account state

/** `unknown` until the person declares. Under-13s are refused and never get a band. */
export const AgeBand = z.enum(["unknown", "13to15", "16to17", "18plus"]);
export type AgeBand = z.infer<typeof AgeBand>;

/** How the band was learned. Later methods are stronger. */
export const AgeMethod = z.enum(["declared", "estimated", "verified", "store_signal"]);
export type AgeMethod = z.infer<typeof AgeMethod>;

export const AGE_METHOD_STRENGTH: Record<AgeMethod, number> = { declared: 1, store_signal: 2, estimated: 2, verified: 3 };

/**
 * active              normal use
 * restricted          below the region's minimum age, or limited by staff; may read and export, not use features
 * pending_age_review  signals suggest the declared age is wrong; waiting on a stronger age check
 * suspended           staff action; signed out and cannot sign in
 * underage_removed    declared or confirmed under 13; signed out, cannot sign in, data due for deletion
 */
export const AccountState = z.enum(["active", "restricted", "pending_age_review", "suspended", "underage_removed"]);
export type AccountState = z.infer<typeof AccountState>;

/** States that cannot use the API at all. */
export const BLOCKED_STATES: readonly AccountState[] = ["suspended", "underage_removed"];

export const COUNTRY_CODE = /^[A-Z]{2}$/;
export const Country = z.string().toUpperCase().regex(COUNTRY_CODE);

/** The person tells us when they were born; we keep only the band and when it ends. */
export const DeclareAgeRequest = z.object({
  birthYear: z.number().int().min(1900).max(2100),
  birthMonth: z.number().int().min(1).max(12),
  country: Country.optional(),
});
export type DeclareAgeRequest = z.infer<typeof DeclareAgeRequest>;

export const AccountSafety = z.object({
  ageBand: AgeBand,
  ageMethod: AgeMethod.nullable(),
  /** First day of the month the band stops being right; null when unknown or 18plus. */
  ageBandUntil: z.number().int().nullable(),
  accountState: AccountState,
  country: z.string().nullable(),
  /** The region's minimum age, so the client can say why an account is limited. */
  minAge: z.number().int(),
  /** True when the region requires a declaration and none has been made. */
  ageDeclarationRequired: z.boolean(),
  /** Documents the person has not accepted at the current version. */
  termsOutstanding: z.array(z.object({ document: z.string(), version: z.string() })),
});
export type AccountSafety = z.infer<typeof AccountSafety>;

// ------------------------------------------------------------------ age signals (no content scanning)

/**
 * Evidence that a declared age may be wrong. Every one of these comes from
 * something the server legitimately has: reports a user chose to send,
 * what a moderator observed, the person contradicting themselves, or a signal
 * from an app store or age checker. None comes from reading messages.
 */
export const AgeSignalKind = z.enum([
  "reported_underage", // a user reported the account as under age
  "moderator_flag", // a server moderator or platform staff flagged it
  "declaration_conflict", // later declared a younger age than before
  "country_mismatch", // declared country differs from the connection country
  "store_signal", // app store or platform age signal says younger
  "estimator", // an age estimation check said younger
]);
export type AgeSignalKind = z.infer<typeof AgeSignalKind>;

export const AGE_SIGNAL_WEIGHT: Record<AgeSignalKind, number> = {
  reported_underage: 2,
  moderator_flag: 3,
  declaration_conflict: 5,
  country_mismatch: 1,
  store_signal: 5,
  estimator: 4,
};

// ------------------------------------------------------------------ reason codes

/**
 * A fixed list of reasons for platform and moderator actions, kept next to the
 * free text. Needed to tell the affected person why, to count actions for
 * transparency reports, and to route appeals.
 */
export const ReasonCode = z.enum([
  "spam",
  "harassment",
  "hate",
  "sexual_content",
  "violence",
  "self_harm",
  "illegal_content",
  "child_safety",
  "underage",
  "impersonation",
  "ban_evasion",
  "other",
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

// ------------------------------------------------------------------ region flags

export const SafetyModule = z.enum([
  "age",
  "reports",
  "public_scan",
  "reporting_out",
  "contact",
  "blocklists",
  "authorities",
  "transparency",
  "legal",
]);
export type SafetyModule = z.infer<typeof SafetyModule>;

/** What each module can be configured with. Unknown keys are rejected. */
export const MODULE_CONFIG = {
  age: z
    .object({
      /** Lowest age allowed to use the service in the region. */
      minAge: z.number().int().min(13).max(21).default(18),
      /** Strongest check the region requires, for the record and for the client. */
      assurance: z.enum(["declared", "estimated", "verified"]).default("declared"),
      /** Accounts with an unknown band are held until they declare. */
      requireDeclaration: z.boolean().default(true),
      /** Whether channels may be labelled age restricted at all. */
      ageRestrictedChannels: z.boolean().default(false),
      /** Signals add up to this before an account goes to age review. */
      reviewThreshold: z.number().int().min(1).max(100).default(5),
    })
    .strict(),
  reports: z.object({}).strict(),
  public_scan: z.object({}).strict(),
  reporting_out: z.object({}).strict(),
  contact: z
    .object({
      /** Whether a DM from a stranger can start as a request. When off, `requests` behaves like `nobody` for strangers. */
      messageRequests: z.boolean().default(true),
      /** The DM policy for 13 to 17 year olds who have not chosen one, and the loosest they may choose. */
      teenDmPolicy: z.enum(["requests", "nobody"]).default("requests"),
    })
    .strict(),
  blocklists: z.object({}).strict(),
  authorities: z.object({}).strict(),
  transparency: z.object({}).strict(),
  legal: z
    .object({
      /** The current version string of each document people must accept. */
      terms: z.string().min(1).max(64).default("unpublished"),
      privacy: z.string().min(1).max(64).default("unpublished"),
      aup: z.string().min(1).max(64).default("unpublished"),
    })
    .strict(),
} as const satisfies Record<SafetyModule, z.ZodType>;

export type ModuleConfig<M extends SafetyModule> = z.infer<(typeof MODULE_CONFIG)[M]>;

/** Region ids: `default`, a country (`DE`), a group (`EU`, `EEA`), or a US state (`US-TX`). */
export const Region = z.string().regex(/^(default|EU|EEA|[A-Z]{2}(-[A-Z0-9]{1,3})?)$/);

export const FlagValue = z.object({
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type FlagValue = z.infer<typeof FlagValue>;

/** What the client may know: its own region's effective values, never the rules for other regions. */
export const SafetyConfig = z.object({
  region: z.string(),
  minAge: z.number().int(),
  assurance: z.enum(["declared", "estimated", "verified"]),
  ageRestrictedChannels: z.boolean(),
  modules: z.record(SafetyModule, z.boolean()),
});
export type SafetyConfig = z.infer<typeof SafetyConfig>;

// ------------------------------------------------------------------ terms and legal holds

export const TermsDocument = z.enum(["terms", "privacy", "aup"]);
export type TermsDocument = z.infer<typeof TermsDocument>;

export const AcceptTermsRequest = z.object({
  document: TermsDocument,
  version: z.string().min(1).max(64),
});
export type AcceptTermsRequest = z.infer<typeof AcceptTermsRequest>;

export const HoldSubjectType = z.enum(["account", "server", "file", "report"]);
export type HoldSubjectType = z.infer<typeof HoldSubjectType>;

export const LegalHold = z.object({
  id: Id,
  subjectType: HoldSubjectType,
  subjectId: z.string().min(1).max(64),
  reasonCode: ReasonCode,
  /** A case or reference number from the authority or report. Not personal data. */
  reference: z.string().max(128).nullable(),
  createdBy: z.string(),
  createdAt: z.number().int(),
  releasedAt: z.number().int().nullable(),
});
export type LegalHold = z.infer<typeof LegalHold>;

// ------------------------------------------------------------------ what limited accounts may do

/** Accounts that cannot use features that write: restricted ones may only read and export. */
export const READ_ONLY_STATES: readonly AccountState[] = ["restricted"];

/** Accounts that cannot start new contact: DMs, calls, joining servers, creating servers. */
export const NO_NEW_CONTACT_STATES: readonly AccountState[] = ["restricted", "pending_age_review"];

/**
 * Whether age restricted channels are hidden from this account. True unless the
 * account is active and confirmed or declared 18 and over.
 */
export function isAgeLimited(state: AccountState, band: AgeBand): boolean {
  return state !== "active" || band !== "18plus";
}

// ------------------------------------------------------------------ staff admin requests

export const StaffSetStateRequest = z.object({
  state: AccountState,
  reasonCode: ReasonCode,
});
export type StaffSetStateRequest = z.infer<typeof StaffSetStateRequest>;

/** How a staff member closes an age review. `cleared` records that a stronger check showed 18 or over. */
export const StaffResolveAgeReviewRequest = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("cleared") }),
  z.object({ outcome: z.literal("restrict") }),
  z.object({ outcome: z.literal("remove") }),
]);
export type StaffResolveAgeReviewRequest = z.infer<typeof StaffResolveAgeReviewRequest>;

export const StaffSetFlagRequest = z.object({
  module: SafetyModule,
  region: Region,
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type StaffSetFlagRequest = z.infer<typeof StaffSetFlagRequest>;

export const StaffPlaceHoldRequest = z.object({
  subjectType: HoldSubjectType,
  subjectId: z.string().min(1).max(64),
  reasonCode: ReasonCode,
  reference: z.string().max(128).nullable().default(null),
  /** Required for a report hold: the server whose object stores the report. */
  serverId: Id.optional(),
});
export type StaffPlaceHoldRequest = z.infer<typeof StaffPlaceHoldRequest>;

export const StaffAccountListQuery = z.object({
  state: AccountState.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Deleting an account needs the person to say so explicitly. */
export const DeleteAccountRequest = z.object({ confirm: z.literal("delete my account") }).strict();
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;

// ------------------------------------------------------------------ message requests and teen defaults

/** The bands that get teen defaults. An unknown band is not here: those accounts are held at the age screen. */
export function isTeenBand(band: AgeBand): boolean {
  return band === "13to15" || band === "16to17";
}

export const MessageRequest = z.object({
  conversationId: z.string(),
  /** The person asking to message you. */
  from: Id,
});
export type MessageRequest = z.infer<typeof MessageRequest>;

/** Messages a requester may send before the recipient accepts. */
export const MESSAGE_REQUEST_SENDS = 1;
