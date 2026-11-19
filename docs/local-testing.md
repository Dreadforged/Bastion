# Testing Bastion on your own computer

Everything here runs on your PC only. Nothing is sent to the internet. You need Node.js 20 or newer, Rust, and wasm-pack (all already installed on the dev machine).

Use Chrome or Edge. Passkeys on localhost work in both.

## One-time setup

Open Command Prompt, then:

```
cd C:\Users\shayn\Dreadforged\Bastion
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
cd C:\Users\shayn\Dreadforged\Bastion
npm run dev:api
```

Wait for "Ready on http://127.0.0.1:8787".

Window 2 (the web page):

```
cd C:\Users\shayn\Dreadforged\Bastion
npm run dev:web
```

Open http://localhost:5173 in your browser. Use `localhost`, not 127.0.0.1, or passkeys will refuse to work.

If port 8787 or 5173 is busy, close whatever is using it first.

## Where the confirmation email shows up

No real email is sent. When you sign up, look in **Window 1**. A block starting with `[email stub] to=...` appears, and under it is a link like `http://localhost:5173/enroll#token=...`. Copy that whole link into your browser. It expires in 15 minutes.

## Start over with a clean slate

Close both windows, then:

```
cd C:\Users\shayn\Dreadforged\Bastion\workers\api
rmdir /s /q .wrangler\state
npx wrangler d1 migrations apply DB --local
```

Also clear site data for localhost in the browser (and delete the old passkey in your password manager or Windows Hello settings).

## Things to try

- [ ] Sign up with any email, find the link in Window 1, open it, create a passkey.
- [ ] Age screen: confirm it appears and that choosing under 18 is handled as expected.
- [ ] Create a server, then add a text channel or two.
- [ ] Create an invite and open it in a private (incognito) window. Sign up a second account there using a different email, and join the server.
- [ ] Send messages both ways in a channel.
- [ ] Send a direct message between the two accounts. Reload the page and check the history is still there and readable (encryption keys persist).
- [ ] Voice: try joining a voice channel. LiveKit is not available locally, so joining is expected to fail or do nothing. This only checks that the screen does not crash.
- [ ] Privacy: use the export option in settings and open the downloaded file.
- [ ] Staff page: open http://localhost:5173/api/staff and http://127.0.0.1:8787/staff. Both should show "not found" (404).
- [ ] Sign out and sign back in with the passkey.

## Known limits

- Voice and file uploads need LiveKit and R2 and are off locally.
- The web screens have never been clicked through by a person before, so write down anything odd.
- Message history with encryption is only kept in that browser profile; a private window is a separate user.

## Bug reports

Note what you clicked, what you expected, and copy any red text from the browser console (F12) and from Window 1.
