# File uploads: setup and operations

How files are stored and served, and what must be configured before the file
routes work. Code lives in `workers/api/src/files/`.

## How it works

1. The client asks `POST /files/uploads` for permission to upload a file of an
   exact size. The Worker checks the user can attach files there (the same
   permission checks as messages, so a timeout blocks it), records a pending
   row in the `attachments` table, and returns a pre-signed R2 URL that works
   for **5 minutes**.
2. The client PUTs the bytes straight to R2 at `pending/<id>`. The Worker never
   carries them and never sees the client's address. The URL signs the exact
   length and type, so it cannot be used for a bigger or different file.
3. The client calls `POST /files/uploads/:id/complete`. The Worker reads the
   object and:
   - **Public (server channel) images:** detects the real type from the bytes
     (PNG, JPEG, GIF, WebP only; the claimed type and any file name do not
     count), strips EXIF, XMP, IPTC, comments, thumbnails and trailing data,
     runs the abuse scan hook, then writes `files/<id>`.
   - **Private files** (DMs, encrypted conversations; encrypted on the device
     first): only the size is checked. Bytes are stored as they came, as
     `application/octet-stream`. They are not scanned or modified.
4. Downloads: `GET /files/:id/url` checks access and returns a signed URL (one
   hour) on the **files domain**. That domain serves only `/f/<id>` and never
   sees app cookies.

The pending and final keys differ on purpose: a pre-signed URL that is still
live after completion can only write `pending/<id>`, never replace a checked
file.

## Limits

| What | Limit |
| --- | --- |
| File size (alpha) | 25 MB |
| Upload URL lifetime | 5 minutes |
| Download URL lifetime | 1 hour |
| Unfinished uploads | 10 per user, cleaned up after 1 hour |
| Uploads started | 30 per user per 10 minutes, plus the general per-user limit |
| Public file types | PNG, JPEG, GIF, WebP |

## Things to set up (none of this is done by the code)

### 1. A separate domain for files

Pick a domain that is **not** a subdomain of the app or API, for example
`bastion-usercontent.net`, and point `files.<that domain>` at the same Worker
(a custom domain or route). Set:

```
FILES_ORIGIN = "https://files.bastion-usercontent.net"
```

The Worker answers on that host for `/f/...` only and 404s everything else
there. The API host never serves file bytes. A separate registrable domain,
not just a subdomain, keeps uploaded content away from the app's cookies and
storage even if a browser bug mishandles one.

### 2. R2 S3 credentials and the bucket

Create an R2 API token limited to the one bucket (object read/write), then:

```
wrangler secret put R2_ACCESS_KEY_ID      --env <env>
wrangler secret put R2_SECRET_ACCESS_KEY  --env <env>
wrangler secret put FILE_URL_SECRET       --env <env>   # 32+ random bytes, signs download URLs
```

and under `[vars]`: `R2_ACCOUNT_ID`, `R2_BUCKET_NAME` (matches the `FILES`
binding's bucket).

Bucket settings:

- **CORS:** allow `PUT` from the app origin only, with the `content-type`
  header. Nothing else, and no `GET` (downloads go through the Worker).
- **Lifecycle rule:** delete objects under `pending/` after 1 day. A client can
  still write to `pending/<id>` while its URL is live after completing; those
  leftovers are never served and this rule sweeps them.
- Keep the bucket private and do not enable a public `r2.dev` URL.

Until `FILES_ORIGIN`, `FILE_URL_SECRET` and all four `R2_*` values are set, the
`/files` routes are not mounted.

### 3. Verify the signed upload against real R2

The signer matches AWS's published example (`test/presign.test.ts`), but R2
itself has not been tried yet. On staging, confirm that:

- a PUT with the right body succeeds,
- a PUT with a different `Content-Length` or `Content-Type` is rejected,
- the URL stops working after 5 minutes.

### 4. The abuse scanner

`NoopScanner` in `files/scanner.ts` lets everything through. **Public images
are not scanned in the alpha.** Before public launch, implement `ImageScanner`
for a real service (hash matching such as PhotoDNA or Cloudflare's CSAM
scanning tool) and pass it in `src/index.ts`. The hook runs on the stripped
bytes, before anything is stored for use:

- `clean`: the file goes live.
- `match`: bytes deleted, row marked `blocked`, uploader sees only
  `file_rejected`. Legal reporting duties (for example NCMEC reports in the US)
  and evidence retention are **not built**; get legal advice and add that in
  the match handler.
- `error`: fails closed. The file stays pending and `complete` can be retried.

## Privacy notes

- No IP address, file name or user agent is stored or logged. The Worker does
  not read `cf-connecting-ip` on file routes.
- Download URLs carry only a file id, an expiry and a signature. No user id.
- Messages are encrypted, so the server cannot link a file to a message. A
  message refers to a file from inside its ciphertext. Deleting the message
  does not delete the file; the uploader deletes it with `DELETE /files/:id`.
- Deleting a user's account removes their `attachments` rows, but their R2
  objects need a cleanup job. That job is not written yet.

## Known limits

- Stripping EXIF removes the orientation tag, so a rotated phone photo can show
  sideways. Clients should bake rotation into the pixels before upload.
- Image bytes are read into Worker memory (up to 25 MB, plus the cleaned copy).
  This fits the 128 MB limit but is the reason for the alpha size cap.
- Only images are public files. PDFs and other documents go up as private,
  encrypted files.
