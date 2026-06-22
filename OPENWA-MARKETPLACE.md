# Spec: in-dashboard plugin marketplace for OpenWA

A proposal for OpenWA (the gateway), not this repo. It adds a VS Code-style **catalog + one-click
install/update** to the dashboard, fed by this repo's [`plugins.json`](./plugins.json) and GitHub
Release assets. Written against the verified v0.6.x plugin runtime.

## Why

Today a user installs a plugin by **uploading a `.zip`** (`POST /plugins/install`, `FileInterceptor('file')`,
ADMIN). There is no catalog and no install-from-URL — every install/update is a manual build-or-download
then upload. A curated catalog + install-from-URL turns that into: browse → Install → Configure → Enable.

This repo already publishes the two inputs a marketplace needs:
- **`plugins.json`** — the catalog (id, name, version, description, author, keywords, status, `download`).
- **GitHub Release assets** — `<id>.zip` + `<id>.zip.sha256` at the `download` URL.

## Current state (verified, OpenWA v0.6.1)

- `PluginsService.install(file)` → `parsePluginPackage(buffer)` validates manifest, id safety, type
  (`extension` only), reserved ids, zip-slip, and size (≤ 5 MB / 200 files / 20 MB), then writes the
  package and `loadPlugin`s it. **The only thing missing for remote install is the source of the buffer.**
- OpenWA already has SSRF protections for outbound fetches (DNS-pinned/undici-guarded media + webhook
  paths) — the marketplace download must reuse that guard.
- Plugins run sandboxed in a worker thread; a marketplace changes *how a package arrives*, not the trust
  model. The catalog is curated (this repo), and packages are still validated + sandboxed exactly as today.

## Proposed changes (OpenWA side)

### 1. Backend — install from a catalog URL
`POST /plugins/install-from-url` (ADMIN), body `{ "url": string, "sha256"?: string }`:
1. Reject unless `url` host is in an **allowlist** (default: the GitHub Releases download host of the
   configured catalog). Resolve + fetch through the **existing SSRF-guarded fetch** (same DNS-pin path as
   media/webhook), capped at the 5 MB download limit.
2. If `sha256` is provided (or fetched from the sibling `.sha256` asset), verify it before touching disk.
3. Hand the downloaded buffer to the **existing** `parsePluginPackage` + install pipeline — no new
   validation path, so zip-slip/size/manifest/reserved-id guards are reused verbatim.

Reuse, don't fork: the only new code is "obtain buffer from URL (guarded)"; everything after is the
current install flow.

### 2. Backend — catalog fetch (server-side, to keep SSRF control + avoid CORS)
`GET /plugins/catalog` (ADMIN): fetch the configured catalog JSON (SSRF-guarded), cache briefly, and
return each entry annotated with `installed` (bool) and `updateAvailable` (installed version `<` catalog
version, by semver). Config:
- `PLUGIN_CATALOG_URL` — default `https://raw.githubusercontent.com/rmyndharis/OpenWA-plugins/main/plugins.json`.
- `PLUGIN_DOWNLOAD_ALLOWLIST` — default the GitHub release host; install-from-url rejects anything else.

### 3. Dashboard — a "Catalog/Marketplace" tab
List catalog entries (name, description, version, author, keywords, status badge) with a per-entry action:
- **Install** → `POST /plugins/install-from-url` with the entry's `download` (+ `sha256` if present) →
  then the existing Configure + Enable flow.
- **Update** (when `updateAvailable`) → install-from-url the new version over the old.
- **Installed** (disabled button) when already present at the catalog version.

## Security notes

- ADMIN-only, like every other plugin route.
- Install-from-URL **must** go through the existing SSRF guard and a **host allowlist** — never fetch an
  arbitrary user-supplied URL unguarded (internal-service SSRF risk).
- Prefer **sha256 pinning**: the catalog entry can carry the release's sha256 (published as the
  `<id>.zip.sha256` asset) so the server verifies integrity before install. (This repo currently keeps
  sha256 out of `plugins.json` for determinism and publishes it per-release; the catalog endpoint can read
  it from the release, or we add a `sha256` field to the catalog at release time.)
- The downloaded package still passes `parsePluginPackage` and runs sandboxed — no relaxation of existing
  guards.

## Suggested phasing

1. **MVP:** `POST /plugins/install-from-url` (guarded, allowlisted) + a minimal dashboard "Install from
   catalog URL" action. Unblocks one-click install from our published releases.
2. **Full:** `GET /plugins/catalog` + a browseable Marketplace tab with Install/Update/Installed states
   and sha256 verification.

Happy to open this as an issue and/or send the PR (it is mostly wiring around the existing install
pipeline + SSRF guard).
