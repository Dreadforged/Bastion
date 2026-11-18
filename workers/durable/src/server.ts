import { DurableObject } from "cloudflare:workers";

/**
 * One per community server. Authoritative for membership, roles, channels
 * and permission overrides. Permission checks use @bastion/shared.
 */
export class Server extends DurableObject {
  override async fetch(_request: Request): Promise<Response> {
    // TODO: membership, roles and channel management.
    return new Response("not implemented", { status: 501 });
  }
}
