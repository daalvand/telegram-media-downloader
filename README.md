# Telegram Media Downloader

Desktop app (Electron) to log into your own Telegram account and download
media (photos, videos, GIFs, voice notes, video notes, documents) from any of
your chats, including private ones.

## Setup

1. `npm install`
2. `npm start`
3. On first launch you'll see a **Setup** screen — click "Open
   my.telegram.org/apps", log in with your Telegram account, create an app
   (any name works), then copy the `api_id`/`api_hash` shown back into the
   app and save. Adjust the proxy host/port there too if needed.

## Usage

1. Enter your phone number (with country code, e.g. `+15551234567`) and tap
   "Send code".
2. Enter the login code Telegram sends you (and your 2FA password if you have
   one set).
3. Pick a chat, filter by media type, select items, and click "Download
   selected". You'll be asked to choose a destination folder the first time.

Your login session is stored encrypted on disk, so you won't need to log in
again next time you open the app (use "Log out" in the chat list to clear it).

## Notes

- API credentials and proxy settings are saved to a local config file in the
  app's user-data directory (not in the project folder, never committed).
- All Telegram API calls happen in Electron's main process; the UI (renderer)
  only talks to it over IPC and never touches your credentials directly.

## Building installers

Packaging is done with `electron-builder` (config lives in `package.json`
under `"build"`), producing multiple package types per platform:

- **macOS**: `.dmg` and `.zip`, for both Intel (x64) and Apple Silicon (arm64)
- **Windows**: NSIS installer (`.exe`) and a portable `.exe`
- **Linux**: `.AppImage`, `.deb`, and `.rpm`

```bash
npm run dist:mac     # build macOS packages (must run on macOS)
npm run dist:win     # build Windows packages (must run on Windows, or macOS/Linux with wine)
npm run dist:linux   # build Linux packages
npm run dist:all     # build everything for the current host's supported targets
```

electron-builder cannot cross-compile every target from every host (notably,
Windows builds are most reliable when built on Windows). The
`.github/workflows/build.yml` GitHub Actions workflow handles this by building
each platform on its native runner (macOS, Windows, and Ubuntu) whenever you
push a `v*` tag, or via manual "Run workflow" dispatch, and attaches all the
resulting installers to a GitHub Release.

Builds are unsigned (no Apple Developer ID / Windows code-signing
certificate configured — that costs $99/year and wasn't set up for this
project).

### macOS: "is damaged and can't be opened"

Because the app isn't notarized by Apple, macOS Gatekeeper blocks it after
it's downloaded from the internet (the download itself sets a "quarantine"
flag, which is what actually triggers the block — not a real corruption).
Ad-hoc signing the build helps for local transfers (AirDrop, USB, LAN) but
does **not** satisfy Gatekeeper for a quarantined download; only Apple's own
notarization does, which requires a paid Developer ID.

**Fix (one-time, per machine):** open Terminal and run:

```bash
xattr -cr "/Applications/Telegram Media Downloader.app"
```

Then open the app normally. Alternatively: right-click the app → "Open" →
confirm in the dialog (works on most macOS versions, though Sequoia removed
this bypass for fully unsigned apps — use the Terminal command in that case).

### Windows: "Windows protected your PC" (SmartScreen)

Same root cause (no code-signing certificate). Click **"More info" → "Run
anyway"** to launch it.
