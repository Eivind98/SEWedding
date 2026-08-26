# WeddingProject

Wedding info site, plus a photo/video upload page that relays guest uploads
straight into a private OneDrive folder. Guests need no account and no sign-in.

The site is served by `server.js`, a small Node app with no dependencies. It
serves the static files and exposes a single endpoint, `POST /api/upload-session`.
Guest browsers upload their files **directly to Microsoft** in 10 MiB chunks, so
the file bytes never pass through the server.

## Local preview

```bash
npm run serve
```

Then open http://localhost:3000. This picks up `.env` automatically once you
have run the setup below; without it the page still serves and the server warns
at startup that uploads are disabled.

The local server binds to `127.0.0.1` only, so `.env` and `.refresh_token` in
the working directory are not reachable from the network. It also serves just
the site's own files — `index.html`, the two stylesheets, `script.js` and
`assets/` — and returns 404 for everything else in the repo.

To try the page from a phone on the same wifi, opt in explicitly:

```bash
HOST=0.0.0.0 npm run serve
```

Only do that on a network you trust.

## OneDrive upload relay setup

### 1. Decide the destination folder

Pick where uploads should land, for example `Brudleyp/Myndir`. You do not need
to create it by hand — `npm run check` in step 3a creates it for you.

### 2. Register an app in Microsoft Entra

Go to https://entra.microsoft.com and sign in with **the same personal Microsoft
account that owns the OneDrive**. A free default directory is created for you on
first use; no paid Azure subscription is needed.

Navigate to **Identity → Applications → App registrations → New registration**,
or use the direct link:

```
https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
```

Fill in the registration form:

| Field | Value |
| --- | --- |
| Name | anything, e.g. `wedding-upload` |
| Supported account types | **Personal Microsoft accounts only** |
| Redirect URI | platform **Web**, value `http://localhost:3000/callback` |

Both of these matter.

The account type must not be a single-tenant option, or the `/consumers`
sign-in endpoint used by this app rejects the login with `unauthorized_client`.
"Personal Microsoft accounts only" maps exactly to that endpoint. The
"any organizational directory and personal Microsoft accounts" option also
works, but grants a wider audience than this needs.

The platform must be **Web**, not **Single-page application**. Web means a
confidential client, which is what lets the relay authenticate with a client
secret. SPA registrations require PKCE and reject the secret outright.

Then create a secret under **Manage → Certificates & secrets → Client secrets →
New client secret**. Any description and expiry will do.

Copy the **Value** column, not the Secret ID. The Value is roughly 40 random
characters and usually contains a `~`; the Secret ID is a GUID. The Value is
shown only on the screen that appears right after you click Add — navigate away
or refresh and it is masked permanently. If you lose it, delete that secret and
create a new one; nothing else needs changing.

From the app's **Overview** page, note the **Application (client) ID**.

### 3. Get a refresh token

Personal OneDrive does not support app-only authentication, so the relay acts on
your behalf using a refresh token you generate once:

```bash
node get-refresh-token.js
```

It prompts for the client ID, the secret, and the destination folder, prints a
sign-in URL, and waits on `http://localhost:3000/callback` for the redirect.
Sign in and approve. This runs on your own machine — it does not need the
CapRover host.

It then writes a `.env` file with everything the relay needs, and prints the
same values for pasting into CapRover.

`.env` holds your client secret in plaintext and is listed in `.gitignore`.
Keep it that way — do not commit it.

### 3a. Test it locally before deploying

First check the credentials without involving a browser:

```bash
npm run check
```

This refreshes the token, prints which OneDrive account it reached and how much
space is free, and creates the destination folder if it is missing. If this
passes, the credentials are good and anything that fails afterwards is a
browser or upload problem rather than an authentication one.

Then run the site:

```bash
npm run serve
```

This loads `.env` automatically if it is present, and warns at startup if the
credentials are missing rather than failing later on the first upload. Open
http://localhost:3000 and
upload a photo; it should appear in your OneDrive folder within seconds. Doing
this before deploying is worth it, because the CapRover redeploy loop is slow
and the failures here are much easier to read — the terminal prints the exact
Microsoft error.

Common failures at this point:

| Symptom | Cause |
| --- | --- |
| `AADSTS7000012` | `.env` saved with Windows CRLF line endings — see below |
| `unauthorized_client` | App registered as single-tenant; see step 2 |
| `invalid_client` | Wrong secret, or the Secret ID was copied instead of the Value |
| `invalid_grant` | Refresh token stale or issued for a different registration; rerun this step |
| `itemNotFound` | `ONEDRIVE_FOLDER` missing; rerun `npm run check` |

`AADSTS7000012` deserves a note, because the message it carries ("the grant was
obtained for a different tenant") is misleading. It is what Microsoft returns
for any refresh token it cannot match, including one that is merely malformed.

The usual cause is a `.env` written or edited by a Windows editor: CRLF line
endings leave a trailing carriage return on every value, Node's `--env-file`
parser does not strip it, and the secret and refresh token then go to Microsoft
with a stray character appended. Let `get-refresh-token.js` write the file, or
save it with LF endings. Both `server.js` and `check-onedrive.js` now trim their
env values, so this specific trap is defused, but the same symptom appears for
any stale or truncated token.

### 4. Configure CapRover

In the CapRover dashboard, open the app and go to **App Configs**.

Under **Environmental Variables**, use **Bulk Edit** (refresh tokens are long
and awkward to paste into the single-line field):

```
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
MS_REFRESH_TOKEN=...
```

Only those three are required. The rest have defaults:

| Variable | Default | Set it when |
| --- | --- | --- |
| `ONEDRIVE_FOLDER` | `Brudleyp/Myndir` | uploads should land somewhere else |
| `TOKEN_FILE` | `/data/refresh_token` | never on CapRover — the default is the volume |
| `PORT` | `3000` | never — the Dockerfile sets 80 |
| `HOST` | `127.0.0.1` | never — the Dockerfile sets 0.0.0.0 |

Do not set `TOKEN_FILE` on CapRover. A relative path would put the rotated
token inside the container instead of on the volume, and it would be lost on
the next deploy.

Under **Persistent Directories**, add the path `/data`, and keep the app at one
instance. Microsoft rotates the refresh token every time it is used, and every
deploy or "Save & Update" restarts the container — `/data/refresh_token` is
where the current token survives that. Without it the app falls back to the
now-stale seed value in `MS_REFRESH_TOKEN`.

Under **HTTP Settings**, enable HTTPS.

Then click **Save & Update**.

### Turning it off

Deleting the app registration in Entra revokes the refresh token immediately and
stops all uploads. That is the clean off-switch once the photos are collected.

Note that CapRover stores environment variables in plaintext on the server, so
do not reuse this client secret anywhere else.

## Deploying on CapRover

The repo contains a `Dockerfile` based on `node:20-alpine` that listens on
port 80.

The container starts with `node server.js` from the Dockerfile's `CMD` — not
`npm run serve`, which is a local convenience only (`package.json` is not even
copied into the image). Configuration therefore comes entirely from the CapRover
environment variables, never from `.env`, which `.dockerignore` keeps out of the
image so the secret is not baked into a layer. `TOKEN_FILE` is left unset in
CapRover so it falls back to its `/data/refresh_token` default on the volume.

If a variable is missing, the container still serves the site and logs a warning
naming what is absent; check the app logs in CapRover.

Install the CapRover CLI if you haven't:

```bash
npm install -g caprover
```

Login and deploy:

```bash
caprover login -n <your-caprover-domain>
```

```bash
caprover deploy -t . -a <app-name>
```

Alternatively, push to the CapRover git remote created during app setup.

## Customization

Edit `index.html`, `style.css`, and `script.js` as needed. The site is
bilingual: every translatable element carries `data-fo` and `data-da`
attributes, and `LanguageSwitcher` in `script.js` swaps them.

The original wedding info sections (programme, maps, dress code, contact, and
the rest) are commented out in `index.html` rather than deleted — uncomment any
block to bring it back, along with its matching link in the nav list.
