# 0005. File uploads: pre-signed R2 URLs, checked in the Worker, served from another domain

- Status: accepted
- Date: 2026-11-19

## Context

Files should not pass through the Worker, should not be stored with identifying
data, and must not be able to harm the app that displays them. Public images
need metadata stripped and an abuse scan; private files are encrypted on the
device and are opaque.

## Decision

- **Pre-signed URLs.** The client uploads straight to R2 with a URL that
  expires in 5 minutes and signs the exact size and type. 25 MB cap in the
  alpha.
- **Two keys.** Uploads land at `pending/<id>`. The Worker reads, checks and
  writes `files/<id>`. A still-live upload URL cannot replace a checked file.
- **Real type check.** Public files are identified from their bytes (PNG, JPEG,
  GIF, WebP). The claimed type is compared to it and a mismatch is rejected.
  File names are never stored or trusted.
- **EXIF stripping.** The Worker rewrites public images, keeping only what draws
  the picture, and rejects files that do not parse. Private files are never
  touched.
- **Scan hook.** An `ImageScanner` interface runs on stripped public images
  before they go live; it fails closed. A stub that allows everything ships
  until a service is chosen.
- **Separate domain.** Files are served only from `FILES_ORIGIN`, a different
  registrable domain, through signed 1 hour URLs, with `nosniff`, a sandboxing
  CSP, `attachment` disposition for anything but checked images, no cookies and
  no referrer.
- **Attachments table.** One D1 row per file: owner, scope (channel or
  conversation), visibility, status, size, detected type, hash. No names, no
  addresses, no link to messages.
- **Access follows the place.** Anyone who can view the channel (or is in the
  conversation) gets a download URL, checked each time, so losing access loses
  the file.

## Consequences

- Cheap, simple uploads; the Worker's memory limit is the reason for the cap.
- Public images are not scanned until a real scanner replaces the stub.
- Orientation is lost when EXIF goes; clients should bake it in first.
- Only images are public. Everything else is a private, encrypted file.
- Account deletion needs a job to remove R2 objects; not written yet.
