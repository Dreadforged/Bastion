import { ulid } from "ulid";
import { z } from "zod";

/** All entity ids are ULIDs: 26 chars, Crockford base32, time-sortable. */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const Id = z.string().regex(ULID_REGEX, "invalid ULID");
export type Id = z.infer<typeof Id>;

export function newId(): Id {
  return ulid();
}
