// Builds the Cloudflare Pages `_headers` file for the web app.
//
// The app holds an encrypted vault in the browser, so any script that runs in this origin can ask
// the browser to decrypt it. The policy is therefore as tight as the app allows: scripts only from
// our own origin, no inline scripts, no eval (only the WASM compile permission the crypto module
// needs), no framing, no plugins.
//
// Origins that are not known yet are read from the environment at build time. Unset, they fall back
// to 'self', which is right when the API is served from the same domain.
//   WEB_API_ORIGIN    https origin of the API Worker, if it is not the same domain
//   WEB_FILES_ORIGIN  https origin that serves uploaded files (the Worker's FILES_ORIGIN)
//   WEB_LIVEKIT_URL   wss/https URL of the LiveKit server, for calls and streams

function origin(value, name) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") throw new Error(`${name} must be https or wss`);
  return url.origin;
}

export function buildCsp(env = {}) {
  const api = origin(env.WEB_API_ORIGIN, "WEB_API_ORIGIN");
  const files = origin(env.WEB_FILES_ORIGIN, "WEB_FILES_ORIGIN");
  const livekit = origin(env.WEB_LIVEKIT_URL, "WEB_LIVEKIT_URL");
  const connect = ["'self'"];
  if (api) connect.push(api, api.replace(/^https:/, "wss:"));
  if (files) connect.push(files);
  if (livekit) connect.push(livekit.replace(/^https:/, "wss:"), livekit.replace(/^wss:/, "https:"));
  const media = ["'self'", "blob:"];
  if (files) media.push(files);
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    `connect-src ${connect.join(" ")}`,
    `img-src ${media.join(" ")} data:`,
    `media-src ${media.join(" ")}`,
    // LiveKit's frame encryption worker is bundled with the app; blob: covers its fallback.
    "worker-src 'self' blob:",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function buildHeaders(env = {}) {
  return `/*
  Content-Security-Policy: ${buildCsp(env)}
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), interest-cohort=()

/index.html
  Cache-Control: no-cache

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
}
