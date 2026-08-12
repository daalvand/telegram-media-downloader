# Telegram Media Downloader — Design Spec

Date: 2026-08-12

## Purpose

A personal desktop app that logs into the user's own Telegram account (not a bot),
browses their chats, and lets them select and download media (photos, videos,
GIFs/animations, voice notes, video notes, documents, stickers) — including from
private chats — to a local folder.

## Non-goals

- Not a multi-user product. Single account, single machine, personal use.
- No automated background sync/scraping — downloads are user-initiated per selection.
- No automated tests against the live Telegram API; testing is manual against the
  user's real account (see Testing section).

## Tech stack

- **Electron** desktop app (macOS primary target).
- **GramJS** (`telegram` npm package) for MTProto user-account access — required
  because the Bot API cannot read arbitrary private chats/media.
- Vanilla HTML/CSS/JS for the renderer UI — no frontend framework, to keep this
  simple and match the scope of the app.

## Credentials & config

- `api_id` / `api_hash` (obtained by the user from my.telegram.org) are stored in a
  local `.env` file, gitignored, loaded by the main process only. Never sent to the
  renderer, never hardcoded in source.
- Proxy: SOCKS5 at `127.0.0.1:10801` (user's local proxy). Configured on the GramJS
  `TelegramClient` via `{socks: 5, ip: '127.0.0.1', port: 10801}`, used for every
  connection attempt including login. Host/port are user-editable in Settings in
  case the proxy port changes later.

## Architecture

Two Electron processes, communicating over `ipcMain`/`contextBridge` (no
`nodeIntegration` in the renderer):

- **Main process (Node.js)**: owns the single GramJS `TelegramClient` instance for
  the app's lifetime. Handles login, session persistence, chat listing, media
  listing (paginated), and downloads. All Telegram API calls happen here — the
  renderer never talks to Telegram directly.
- **Renderer process**: UI only — login screen, chat list, media browser, download
  panel, settings. Talks to main via a small set of IPC channels.

### Session persistence

After successful login, GramJS's session string is encrypted with Electron's
`safeStorage` API (OS keychain-backed) and written to a local file in the app's
user-data directory. On startup, main process attempts to decrypt and restore the
session; if valid, the user goes straight to the chat list, skipping login.

## IPC contract (main <-> renderer)

- `login:sendCode(phone)` → `{ok}` | `{error}`
- `login:verify(code, password?)` → `{ok}` | `{error: 'wrong_code'|'wrong_password'|'2fa_required'|...}`
- `session:restore()` → `{loggedIn: bool}` (called on app start)
- `session:logout()` → clears encrypted session file, disconnects client
- `chats:list()` → `[{id, name, type, unreadCount}]`
- `media:list(chatId, {filter, offsetId})` → streamed via `media:batch` events,
  `{items: [{id, type, filename, size, date, thumbnail?}], done: bool}`
- `media:download(chatId, messageIds[], destFolder)` → progress via
  `download:progress` events `{messageId, percent}` and `download:done`
  `{messageId, ok, error?}` per file
- `settings:get()` / `settings:set({downloadFolder?, proxy?})`

## UI flow

1. **Login screen**: phone input → "Send code" → code input (+ 2FA password field
   shown only if Telegram requests it) → "Verify". Inline error messages for wrong
   code/password, flood-wait, or connection failure (see Error handling).
2. **Chat list screen**: scrollable list of dialogs (name, avatar initial, last
   activity), search box to filter by name, click to open a chat.
3. **Media browser screen**: for the open chat, media items grouped by type via
   filter chips (Photos, Videos, GIFs, Voice, Video notes, Documents, Stickers).
   Each item: thumbnail (if available), filename, size, date, checkbox. "Select all
   in view" control and a running selected-count/total-size indicator. Infinite
   scroll triggers `media:list` pagination (batches of ~50) rather than loading
   full history upfront.
4. **Download panel**: "Download selected" → folder picker on first use (remembered
   thereafter, changeable in Settings) → per-file progress bars + overall progress
   + a log line per completed/failed file. Failed files show a retry button and
   don't block the rest of the batch.
5. **Settings**: download folder, proxy host/port, log out.

## Error handling

- Login errors (wrong code, wrong 2FA password, flood-wait, network/proxy failure)
  are caught in main, mapped to a small set of typed error codes, and rendered as
  inline UI messages — never raw stack traces.
- Connection/proxy failures during any Telegram call surface a clear banner:
  "Can't reach Telegram — check your proxy is running on 127.0.0.1:10801."
- Downloads: each file is downloaded independently; a failure (network drop, media
  deleted server-side, disk write error) marks that file as failed with a retry
  button, without aborting the rest of the batch.

## Testing

No automated integration tests against the live Telegram API (requires a real
account and phone-based 2FA, not suitable for CI). Manual verification checklist
covering: login (fresh + restored session), chat list load, media browse +
pagination across each media type, multi-select download, download failure/retry,
proxy-down error banner, logout.

Pure logic with no Telegram dependency (media-type filter mapping, file-size
formatting, IPC message shape validation) gets plain unit tests (e.g. Vitest).

## Security notes

- `.env` (api_id/api_hash) and the encrypted session file are gitignored.
- Renderer has no direct Node/Telegram access (`contextIsolation: true`,
  `nodeIntegration: false`) — all sensitive operations are mediated through the
  main process via a minimal, explicit IPC surface.
