import { schemas } from "@bastion/shared";
import { HttpError } from "../http.js";
import { FlagReader, regionChain } from "../safety/flags.js";
import { getPrivacy } from "./privacy.js";

/**
 * Who may start a DM with a person, and how. Teen defaults are protective
 * and cannot be loosened by the teen: a 13 to 17 year old's policy is never
 * looser than the region's `teenDmPolicy` (message requests by default).
 * Nothing here reads message content.
 */

export interface ContactRules {
  policy: schemas.DmPolicy;
  messageRequests: boolean;
}

async function band(db: D1Database, userId: string): Promise<{ band: schemas.AgeBand; country: string | null }> {
  const row = await db.prepare("SELECT age_band, country FROM users WHERE id = ?").bind(userId).first<{ age_band: schemas.AgeBand; country: string | null }>();
  return { band: row?.age_band ?? "unknown", country: row?.country ?? null };
}

const RANK: Record<schemas.DmPolicy, number> = { everyone: 0, requests: 1, nobody: 2 };

/** The policy that applies to a recipient today, after teen defaults. */
export async function contactRules(db: D1Database, flags: FlagReader | undefined, userId: string): Promise<ContactRules> {
  const stored = (await getPrivacy(db, userId)).dmPolicy;
  const { band: ageBand, country } = await band(db, userId);
  const reader = flags ?? new FlagReader(db, Date.now);
  const contact = await reader.get("contact", regionChain(country));
  let policy = stored;
  if (contact.enabled && schemas.isTeenBand(ageBand) && RANK[policy] < RANK[contact.config.teenDmPolicy]) policy = contact.config.teenDmPolicy;
  return { policy, messageRequests: contact.config.messageRequests };
}

/** A teen cannot choose a looser DM policy than the region's teen default. */
export async function assertCanChoosePolicy(db: D1Database, flags: FlagReader | undefined, userId: string, wanted: schemas.DmPolicy): Promise<void> {
  const { band: ageBand, country } = await band(db, userId);
  if (!schemas.isTeenBand(ageBand)) return;
  const reader = flags ?? new FlagReader(db, Date.now);
  const contact = await reader.get("contact", regionChain(country));
  if (contact.enabled && RANK[wanted] < RANK[contact.config.teenDmPolicy]) throw new HttpError(403, "teen_default_locked");
}

/** Whether two people share at least one server. */
export type SharesServer = (a: string, b: string) => Promise<boolean>;
