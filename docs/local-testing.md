# Testing Bastion on your own computer

Everything here runs on your PC only. Nothing is sent to the internet. You need Node.js 20 or newer, Rust, and wasm-pack (all already installed on the dev machine).

Use Chrome or Edge. Passkeys on localhost work in both.

## One-time setup

Open Command Prompt, then:

```
cd <repo>
npm install
npm run build:wasm -w @bastion/web
cd workers\api
npx wrangler d1 migrations apply DB --local
cd ..\..
```

The wasm step builds the encryption code the web app needs. Without it, chat will not load.

## Start the app

You need two Command Prompt windows, both left open.

Window 1 (the server side):

```
cd <repo>
npm run dev:api
```

Wait for "Ready on http://127.0.0.1:8787".

Window 2 (the web page):

```
cd <repo>
npm run dev:web
```

Open http://localhost:5173 in your browser. Use `localhost`, not 127.0.0.1, or passkeys will refuse to work.

If port 8787 or 5173 is busy, close whatever is using it first.

## Test accounts (skip passkeys)

Passkeys are awkward to repeat, so the local server has a built in sign-in picker. Nothing to set up: the first time the web page asks for the list, the server creates everything below.

Open http://localhost:5173 and look under the sign-in button for **Local test accounts**. Click **Sign in as ...**. If the box is not there, the API window is still running old settings: close Window 1 and start it again (`npm run dev:api`).

| Name | What it is |
| --- | --- |
| alice | Adult, age verified, terms accepted. Owns the "Bastion Dev" server |
| bob | Adult, moderator in Bastion Dev (kick, timeout, mute, delete messages, audit log) |
| carol | Adult, regular member of Bastion Dev |
| dave | Adult, in no server. Use the invite code shown in the picker to test joining |
| teen | Declared 16 to 17. Restricted (the alpha is 18+), so read only |
| review | Adult band but held in age review |
| staff | Adult. Signing in as staff also unlocks the local staff page at http://localhost:5173/api/staff |

All emails are fake (`alice@bastion.test` and so on). Nothing is sent to them.

The Bastion Dev server has channels dev-chat, off-topic and voice-lounge (plus the default one), a Moderator role and a never-expiring invite. The invite code is printed in the picker.

**Direct messages are not pre-made.** An encrypted conversation needs keys that a browser makes, so it cannot be seeded ahead of time. Alice, bob and carol already share a server, so any of them can start a DM with another straight away. Do that once and it persists.

**Using more than one account at the same time.** Each browser profile keeps its own encryption keys, and signing out wipes them. Use one browser profile or window per account: for example a normal Chrome window for alice, an Incognito window for bob, and a second Chrome profile for carol. Do not sign out of an account you want to keep reading old DMs in. Signing in again later gives a new device that cannot read the earlier encrypted messages. That is how the encryption is meant to work.

### Why the picker is safe

The picker and the `/dev` routes behind it exist only on your computer:

- The web part is left out of production builds of the web app.
- The server part is switched on only by the top-level `[vars]` and `[define]` in `workers/api/wrangler.toml`. The staging and production blocks do not have it, and the staging and production bundles are built without the code.
- Even when present, it refuses unless the environment is exactly `development`, the passkey domain is `localhost`, the request came to localhost, and it did not come from another website.
- Automated tests (`workers/api/test/dev.test.ts`) check that it is off by default and off in the staging and production configs.

## Where the confirmation email shows up

No real email is sent. When you sign up, look in **Window 1**. A block starting with `[email stub] to=...` appears, and under it is a link like `http://localhost:5173/enroll#token=...`. Copy that whole link into your browser. It expires in 15 minutes.

## Start over with a clean slate (reset the local database)

This deletes every local account, server, message and key. Close both windows first (Ctrl+C, then close them), then in Command Prompt:

```
cd <repo>\workers\api
rmdir /s /q .wrangler\state
npx wrangler d1 migrations apply DB --local
cd ..\..
```

Start the two windows again (see "Start the app"). The test accounts come back on their own the first time the picker loads, with a new invite code.

In the browser, clear site data for localhost too: press F12, open the Application tab, choose Storage, and click **Clear site data**. Do this in every browser window or profile you used. Skipping it leaves old encryption keys that no longer match the new database. If you made real passkeys earlier, delete them in your password manager or Windows Hello settings.

## Things to try

- [ ] Sign up with any email, find the link in Window 1, open it, create a passkey.
- [ ] Age screen: confirm it appears and that choosing under 18 is handled as expected.
- [ ] Create a server, then add a text channel or two.
- [ ] Create an invite and open it in a private (incognito) window. Sign up a second account there using a different email, and join the server.
- [ ] Send messages both ways in a channel.
- [ ] Send a direct message between the two accounts. Reload the page and check the history is still there and readable (encryption keys persist).
- [ ] Voice: try joining a voice channel. LiveKit is not available locally, so joining is expected to fail or do nothing. This only checks that the screen does not crash.
- [ ] Privacy: use the export option in settings and open the downloaded file.
- [ ] Test accounts: sign in as alice, then as bob in another window, and DM each other. Try the teen and review accounts and check the age screens and read only behavior.
- [ ] Staff page: without signing in as staff, http://localhost:5173/api/staff should show an unauthorized error (401). After clicking **Sign in as staff** in the picker it should open the admin page, where review should show up in the age review list.
- [ ] Sign out and sign back in with the passkey.

## Known limits

- Voice and file uploads need LiveKit and R2 and are off locally.
- The web screens have never been clicked through by a person before, so write down anything odd.
- Message history with encryption is only kept in that browser profile; a private window is a separate user.

## Bug reports

Note what you clicked, what you expected, and copy any red text from the browser console (F12) and from Window 1.

## Layout and screenshot checks

These open the app in a headless browser at three window sizes, sign in as alice, visit the main screens and fail if any text spills outside its box. Screenshots are saved to `apps/web/e2e/screenshots` so you can look at them.

One-time setup, then run:

```
cd <repo>
npm install
cd apps\web
npx playwright install chromium
npm run test:visual
```

It starts the API and web servers itself if they are not already running.
