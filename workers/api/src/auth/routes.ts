import { Id, schemas } from "@bastion/shared";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { z } from "zod";
import type { AuthDeps } from "./deps.js";
import { listDevices, revokeDevice } from "./devices.js";
import {
  approveDeviceRequest,
  denyDeviceRequest,
  listDeviceRequests,
  redeemRecoveryCode,
  registerPasskey,
  registrationOptions,
  requestDeviceApproval,
  sendDeviceLink,
  startSignup,
} from "./enrollment.js";
import { AuthError } from "./errors.js";
import { limitIp } from "./rate-limit.js";
import { authenticate, refresh, signOut } from "./sessions.js";
import { signIn, signInOptions } from "./signin.js";

const MAX_BODY = 32 * 1024;

export function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function parse<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new AuthError(413, "body_too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AuthError(400, "invalid_json");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new AuthError(400, "invalid_request");
  return result.data;
}

function idParam(value: string | undefined): string {
  const result = Id.safeParse(value);
  if (!result.success) throw new AuthError(404, "not_found");
  return result.data;
}

/**
 * Routes under /auth. Returns null for paths it doesn't own.
 * `ipLimit` is the Workers rate limit binding for unauthenticated endpoints.
 */
export async function handleAuth(request: Request, deps: AuthDeps, ipLimit?: RateLimit): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/auth/")) return null;
  const route = `${request.method} ${pathname}`;

  try {
    // ------------------------------------------------ unauthenticated
    switch (route) {
      case "POST /auth/signup": {
        await limitIp(ipLimit, request);
        const { email } = await parse(request, schemas.SignupStartRequest);
        await startSignup(deps, email);
        return json(null, 202);
      }
      case "POST /auth/devices/link": {
        await limitIp(ipLimit, request);
        const { email } = await parse(request, schemas.DeviceLinkRequest);
        await sendDeviceLink(deps, email);
        return json(null, 202);
      }
      case "POST /auth/devices/requests": {
        await limitIp(ipLimit, request);
        const { email, deviceName } = await parse(request, schemas.DeviceApprovalRequest);
        return json(await requestDeviceApproval(deps, email, deviceName), 202);
      }
      case "POST /auth/recover": {
        await limitIp(ipLimit, request);
        const { email, code } = await parse(request, schemas.RecoverRequest);
        return json(await redeemRecoveryCode(deps, email, code));
      }
      case "POST /auth/passkeys/register/options": {
        await limitIp(ipLimit, request);
        const { token } = await parse(request, schemas.RegisterOptionsRequest);
        return json(await registrationOptions(deps, token));
      }
      case "POST /auth/passkeys/register": {
        await limitIp(ipLimit, request);
        const body = await parse(request, schemas.RegisterVerifyRequest);
        const response = body.response as unknown as RegistrationResponseJSON;
        return json(await registerPasskey(deps, body.token, body.deviceName, response), 201);
      }
      case "POST /auth/signin/options": {
        await limitIp(ipLimit, request);
        return json(await signInOptions(deps));
      }
      case "POST /auth/signin": {
        await limitIp(ipLimit, request);
        const body = await parse(request, schemas.SignInVerifyRequest);
        return json(await signIn(deps, body.challengeId, body.response as unknown as AuthenticationResponseJSON));
      }
      case "POST /auth/refresh": {
        await limitIp(ipLimit, request);
        const { refreshToken } = await parse(request, schemas.RefreshRequest);
        return json(await refresh(deps.db, refreshToken, deps.now()));
      }
    }

    // ------------------------------------------------ authenticated
    const principal = await authenticate(deps.db, request, deps.now());
    if (route === "POST /auth/signout") {
      await signOut(deps.db, principal);
      return json(null, 204);
    }
    if (route === "GET /auth/devices") return json(await listDevices(deps, principal));
    if (route === "GET /auth/devices/requests") return json(await listDeviceRequests(deps, principal));

    const device = pathname.match(/^\/auth\/devices\/([^/]+)$/);
    if (device && request.method === "DELETE") {
      await revokeDevice(deps, principal, idParam(device[1]));
      return json(null, 204);
    }
    const decision = pathname.match(/^\/auth\/devices\/requests\/([^/]+)\/(approve|deny)$/);
    if (decision && request.method === "POST") {
      const id = idParam(decision[1]);
      if (decision[2] === "approve") await approveDeviceRequest(deps, principal, id);
      else await denyDeviceRequest(deps, principal, id);
      return json(null, 204);
    }
    return json({ error: "not_found" }, 404);
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.code }, err.status);
    throw err;
  }
}
