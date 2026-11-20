import { json } from "../auth/routes.js";
import type { StaffAuth } from "../safety/staff-auth.js";
import { DEV_STAFF_COOKIE, DEV_STAFF_EMAIL, PERSONAS, personaByHandle } from "./personas.js";
import { devSession, seedDevData, type SeedDeps } from "./seed.js";

/**
 * Local development only. The caller (index.ts) has already checked the gate
 * in gate.ts; this module assumes it and never runs otherwise.
 *
 *   GET  /dev/users    the test accounts and the seeded server's invite code (seeds on first use)
 *   POST /dev/signin   { handle } -> session tokens for that account, on a fresh device
 */
export async function handleDev(request: Request, deps: SeedDeps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/dev/")) return null;
  const route = `${request.method} ${pathname}`;

  if (route === "GET /dev/users") {
    await seedDevData(deps);
    const invite = await deps.db
      .prepare("SELECT code FROM invite_codes WHERE expires_at IS NULL ORDER BY code LIMIT 1")
      .first<{ code: string }>();
    return json({
      users: PERSONAS.map((p) => ({ handle: p.handle, email: p.email, blurb: p.blurb })),
      serverName: "Bastion Dev",
      inviteCode: invite?.code ?? null,
    });
  }

  if (route === "POST /dev/signin") {
    let handle: unknown;
    try {
      handle = ((await request.json()) as { handle?: unknown }).handle;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const persona = personaByHandle(handle);
    if (!persona) return json({ error: "unknown_user" }, 404);
    await seedDevData(deps);
    const row = await deps.db.prepare("SELECT id FROM users WHERE email = ?").bind(persona.email).first<{ id: string }>();
    if (!row) return json({ error: "unknown_user" }, 404);
    const tokens = await devSession(deps.db, row.id, `Dev sign-in (${persona.handle})`, deps.now());
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    // Lets the browser open the local /staff page as the staff persona. Cleared by any other sign-in.
    headers.append(
      "set-cookie",
      persona.staff ? `${DEV_STAFF_COOKIE}=1; Path=/; HttpOnly; SameSite=Strict` : `${DEV_STAFF_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`,
    );
    return new Response(JSON.stringify(tokens), { status: 200, headers });
  }

  return json({ error: "not_found" }, 404);
}

/** Staff page access for the local staff persona. Only ever built when the gate is open. */
export function devStaffAuth(): StaffAuth {
  return {
    async authenticate(request) {
      const cookies = request.headers.get("cookie") ?? "";
      return cookies.split(/;\s*/).includes(`${DEV_STAFF_COOKIE}=1`) ? DEV_STAFF_EMAIL : null;
    },
  };
}
