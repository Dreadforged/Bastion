/**
 * The admin page: one static document that calls the /staff JSON routes with
 * the staff member's Cloudflare Access session. No third party scripts, no
 * inline handlers, a nonce for the single script, and nothing cached.
 */
export function staffPage(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response(PAGE.replace("__NONCE__", nonce), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Bastion staff</title><meta name="robots" content="noindex">
<style>
body{font:14px system-ui,sans-serif;margin:1.5rem;max-width:70rem}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:.3rem .5rem;text-align:left}
button{margin:.1rem}pre{background:#f3f3f3;padding:.5rem;overflow:auto}.err{color:#b00}
</style></head><body>
<h1>Bastion staff</h1>
<p>Every view and change here is written to the staff access log with your name. Do not share what you see outside the process.</p>
<h2>Accounts</h2>
<label>State <select id="state"><option value="">flagged</option><option>pending_age_review</option><option>restricted</option><option>suspended</option><option>underage_removed</option></select></label>
<button id="load">Load</button> <span id="msg" class="err"></span>
<table id="accounts"></table>
<h2>Account</h2><div id="detail"></div>
<h2>Region flags</h2><button id="loadFlags">Load flags</button><pre id="flags"></pre>
<script nonce="__NONCE__">
const $ = (id) => document.getElementById(id);
const msg = (t) => { $("msg").textContent = t || ""; };
async function api(method, path, body) {
  const res = await fetch("/staff" + path, { method, headers: { "x-staff-request": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || String(res.status));
  return data;
}
function cell(tr, text) { const td = document.createElement("td"); td.textContent = text == null ? "" : String(text); tr.appendChild(td); return td; }
function button(label, fn) { const b = document.createElement("button"); b.textContent = label; b.onclick = () => fn().catch((e) => msg(e.message)); return b; }
async function loadAccounts() {
  msg("");
  const state = $("state").value;
  const rows = await api("GET", "/accounts" + (state ? "?state=" + state : ""));
  const t = $("accounts"); t.textContent = "";
  const head = document.createElement("tr");
  for (const h of ["id","state","reason","band","method","country","signals",""]) { const th = document.createElement("th"); th.textContent = h; head.appendChild(th); }
  t.appendChild(head);
  for (const r of rows) {
    const tr = document.createElement("tr");
    [r.id, r.accountState, r.stateReason, r.ageBand, r.ageMethod, r.country, r.signalWeight].forEach((v) => cell(tr, v));
    cell(tr, "").appendChild(button("Open", () => openAccount(r.id)));
    t.appendChild(tr);
  }
}
async function openAccount(id) {
  const a = await api("GET", "/accounts/" + id);
  const d = $("detail"); d.textContent = "";
  const pre = document.createElement("pre"); pre.textContent = JSON.stringify(a, null, 2); d.appendChild(pre);
  if (a.accountState === "pending_age_review") {
    d.appendChild(button("Clear: 18 or over", () => review(id, { outcome: "cleared" })));
    d.appendChild(button("Restrict", () => review(id, { outcome: "restrict" })));
    d.appendChild(button("Remove (under 13)", () => review(id, { outcome: "remove" })));
  }
  const reason = document.createElement("select");
  for (const c of ["underage","child_safety","illegal_content","harassment","spam","impersonation","ban_evasion","other"]) { const o = document.createElement("option"); o.textContent = c; reason.appendChild(o); }
  d.appendChild(reason);
  for (const s of ["active","suspended","restricted"]) d.appendChild(button("Set " + s, async () => { await api("PUT", "/accounts/" + id + "/state", { state: s, reasonCode: reason.value }); await openAccount(id); }));
}
async function review(id, body) { await api("POST", "/accounts/" + id + "/age-review", body); await openAccount(id); }
$("load").onclick = () => loadAccounts().catch((e) => msg(e.message));
$("loadFlags").onclick = () => api("GET", "/flags").then((f) => { $("flags").textContent = JSON.stringify(f, null, 2); }).catch((e) => msg(e.message));
</script></body></html>`;
