import { Id, schemas } from "@bastion/shared";
import type { z } from "zod";

/** A client error with a stable code, turned into `{ error: code }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Reads and validates a JSON body no larger than `maxBytes`. */
export async function body<T extends z.ZodType>(
  request: Request,
  schema: T,
  maxBytes: number = schemas.LIMITS.maxBodyBytes,
): Promise<z.output<T>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError(413, "body_too_large");
  let value: unknown;
  try {
    value = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "invalid_request");
  return result.data;
}

/** A path segment that must be an id; anything else is a 404. */
export function id(value: string | undefined): string {
  const result = Id.safeParse(value);
  if (!result.success) throw new HttpError(404, "not_found");
  return result.data;
}

export function query<T extends z.ZodType>(request: Request, schema: T): z.output<T> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const result = schema.safeParse(params);
  if (!result.success) throw new HttpError(400, "invalid_request");
  return result.data;
}
