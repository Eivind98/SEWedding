# WeddingProject

Wedding info site, plus a page where guests upload photos and video. Uploads
are saved to a folder on the server itself. Guests need no account and no
sign-in — just a passcode from the invitation.

The site is served by `server.js`, a small Node app with no dependencies. There
is no cloud storage, no Microsoft account, no OAuth and nothing that expires:
the server takes the bytes and writes them to disk.

## Local preview

```bash
npm run serve
```

Then open http://localhost:3000. Without configuration it still serves the
site; uploads go to `/data/uploads`, which on a normal machine will not be
writable, so set somewhere else while developing:

```bash
UPLOAD_DIR=./uploads UPLOAD_PASSCODE=test npm run serve
```

The local server binds to `127.0.0.1` only. It serves just the site's own
files — `index.html`, the two stylesheets, `script.js` and `assets/` — and
returns 404 for everything else, including every uploaded photo.

To try the page from a phone on the same wifi, opt in explicitly:

```bash
HOST=0.0.0.0 npm run serve
```

Only do that on a network you trust.

## Where the photos go

Uploads land in `UPLOAD_DIR`, which defaults to `/data/uploads`. On CapRover,
`/data` must be a **Persistent Directory** or everything is wiped on the next
deploy — see step 2 below.

Uploaded files are never served back out. The static handler answers only from
a fixed allowlist and has no route into the upload folder at all, so nothing a
guest sends can be fetched off the site afterwards.

To collect the photos when it is all over, copy the folder off the server:

```bash
ssh <your-server> "tar czf - -C /var/lib/docker/volumes/<volume>/_data ." > wedding-photos.tar.gz
```

CapRover shows the exact host path for the volume under the app's **Persistent
Directories**. Or open a terminal into the container from the CapRover
dashboard and copy from `/data/uploads`.

## Setting it up

### 1. Environment variables

None are required — the site serves without any. In practice you want two:

```
UPLOAD_PASSCODE=<pick-your-own>
```

Everything else has a default:

| Variable | Default | Set it when |
| --- | --- | --- |
| `UPLOAD_DIR` | `/data/uploads` | photos should be written somewhere else |
| `UPLOAD_PASSCODE` | unset (open to all) | guests should need a passcode |
| `MAX_FILE_MB` | `512` | a single file may be larger or smaller |
| `MAX_TOTAL_GB` | `20` | the server has more or less room to spare |
| `MAX_TOTAL_MB` | unset | a whole gigabyte is too coarse; wins over the above |
| `ALLOWED_ORIGINS` | unset (any origin) | pinning uploads to the real domain |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | the default window is too tight or too loose |
| `RATE_LIMIT_WINDOW_MS` | `60000` | as above |
| `PASSCODE_MAX_FAILURES` | `5` | wrong guesses lock guests out too easily |
| `PASSCODE_LOCKOUT_MINUTES` | `5` | that lockout should be shorter or longer |
| `TRUST_PROXY` | unset | never — the Dockerfile sets 1 |
| `PORT` | `3000` | never — the Dockerfile sets 80 |
| `HOST` | `127.0.0.1` | never — the Dockerfile sets 0.0.0.0 |

`MAX_TOTAL_GB` matters more than it looks. The CapRover box runs other apps,
and a full disk takes all of them down, not just this one. Once the budget is
reached, uploads are refused politely rather than filling the disk.

### 2. CapRover

In the app's **App Configs**:

- Add `UPLOAD_PASSCODE` under **Environmental Variables**
- Under **Persistent Directories**, add the path `/data`
- Keep **Instance Count** at 1 — two containers would not share the folder
- Under **HTTP Settings**, enable HTTPS

Then **Save & Update**.

### 3. Deploying

Deploys are manual. Either run the CapRover CLI yourself:

```bash
caprover deploy -a se-wedding -b master --appToken <token> -u https://captain.caprover.vormadal.com/
```

…or use the GitHub Actions workflow, which does the same thing and then tells
you whether the app actually came up.

Go to the repo's **Actions** tab → **Deploy** → **Run workflow**. It needs two
repository secrets under Settings → Secrets and variables → Actions:

| Secret | Where to find it |
| --- | --- |
| `CAPROVER_APP_TOKEN` | CapRover → the app → Deployment tab → App Token |
| `CAPROVER_PASSWORD` | your CapRover dashboard password |

The workflow does not stop at "image handed over", which is all CapRover
guarantees. It waits for the app to answer on `/health`, and if it never does,
it prints the CapRover build logs **and** the live container logs into the
workflow output — so a container that builds fine but crashes on startup is
diagnosable without logging into CapRover.

## The upload passcode

Set `UPLOAD_PASSCODE` and print it on the invitation. Without it, anyone who
finds the site can fill the folder.

Guests see a passcode box with a **Log ind** button and nothing else — the drop
zone only appears once the passcode is accepted, along with a green "logged in"
line, so it is never unclear whether the page is ready. The browser remembers
the passcode and logs them straight back in next visit.

It is one shared passcode, not a per-guest login: anyone who has the invitation
can pass it on. It raises the bar from "anyone who finds the URL" to "anyone who
was invited", which is the level a wedding needs. Some specifics:

- Compared in constant time against a hash of both sides, so neither the
  passcode nor its length leaks through response timing.
- Five wrong guesses lock that client out for five minutes. A correct entry
  clears the counter. The count is per IP; a locked-out client is refused even
  with the right passcode, so raise `PASSCODE_MAX_FAILURES` if guests are ever
  likely to share an address.
- Sent in an `X-Upload-Passcode` header, never a query string, so it stays out
  of proxy logs and browser history. Checked on every chunk, not just at login.

Leave it unset and uploads are open to everyone; the startup log says so in
capitals either way.

## What the upload endpoint will and will not accept

- **Only media extensions.** `jpg jpeg png webp gif avif heic heif mp4 mov m4v
  3gp`. Everything else is refused before a single byte is accepted, which
  covers executables, installers, scripts, shortcuts, archives, macro-enabled
  documents, HTML and SVG.
- **The bytes must match the extension.** As soon as twelve bytes have arrived,
  the file's signature is checked against what its name claims. An executable
  renamed to `holiday.jpg` is dropped mid-upload, and the partial file deleted.
- **The stored name is rebuilt, never passed through.** Interior dots are
  flattened, so `photo.jpg.exe` cannot be stored still carrying a second
  extension. Direction-override and zero-width characters — the trick that makes
  a file render as `sumar.jpg` while ending in `.exe` — are stripped before the
  extension is read. Path separators are dropped, so a name cannot walk out of
  the folder. Colliding names get `-2`, `-3` and so on, claimed atomically so
  two guests uploading `IMG_1234.jpg` at once cannot overwrite each other.
- **Size is capped** per file and in total, and the total is reserved when an
  upload starts, so parallel uploads cannot together overshoot the budget.
- **Chunks are strictly sequential.** The server tells the client where to
  resume from rather than trusting an offset, so a chunk cannot land in the
  wrong place, and a client that sends more than it declared has its connection
  dropped and its partial file deleted.
- **Rate limited per client** on starting an upload and on logging in.

Uploads are resumable: files go up in 8 MiB chunks and a dropped chunk restarts
from the offset the server reports, not from the beginning.

## Customization

Edit `index.html`, `style.css`, and `script.js` as needed. The site is
bilingual: every translatable element carries `data-fo` and `data-da`
attributes, and `LanguageSwitcher` in `script.js` swaps them.

`style.css` is built from Tailwind (`npm run build:css`) and is purged, so a
new Tailwind utility class in `index.html` needs a rebuild. Hand-written rules
live in `custom.css`, which is not purged.

The original wedding info sections (programme, maps, dress code, contact, and
the rest) are commented out in `index.html` rather than deleted — uncomment any
block to bring it back, along with its matching link in the nav list.
