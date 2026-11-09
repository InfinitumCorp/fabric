# FabriC++ and the big desktop messengers: feature parity

The ask: everything Telegram Desktop gives its users, in FabriC++. This table lists Telegram
Desktop's user-facing features and marks each against FabriC++ (web client in `public/`, the
Windows/macOS shell in `desktop/`, the Android shell in `android/`). FabriC++ builds its own
versions in the Infinitum house style; nothing here copies Telegram's look, names or art.

Status, as of 2026-11-09 on `feat/relay-pq`:

- **Had** — FabriC++ already did this before this pass (checked in the code).
- **Built** — added in this pass (see "Built in this pass" below).
- **Tier 2 / Tier 3** — not built yet. Tier 2 needs a new message type in the encrypted protocol
  (old clients must ignore it safely) or relay work. Tier 3 is large, or needs original art.
- **Other session** — being built in parallel by another session; not touched here.
- **N/A** — doesn't apply to an end-to-end encrypted, keys-on-device design (reason given).

## Chats and messages

| Feature | Status | FabriC++ |
|---|---|---|
| 1:1 chats | Had | X3DH + Double Ratchet, post-quantum, sealed sender |
| Groups | Had | Up to 64 people, rename, add, leave |
| Reply with quote, jump to the original | Had | `msg-reply`, `jumpTo` |
| Edit sent message | Had | `edit` action, "edited" mark |
| Delete for me / for everyone | Had | `delete` action |
| Forward | Had | Forward dialog, "Forwarded" label |
| Reactions | Had | Six quick reactions, one per person |
| Read receipts, typing indicator | Had | Both switchable in Settings |
| Voice messages | Had | Up to 60 s, Opus |
| Photos and files | Had | Up to 140 KB each, inside the encryption |
| Paste and drag-and-drop of files | Had → **Built** | Was: one file onto the message list. Now: several files, anywhere on the chat, with a drop overlay |
| Pin chats, archive, mute | Had | Up to 5 pinned |
| Mute for a time (1 h, 8 h, 1 day, 1 week, always) | **Built** | Mute picker; unmutes itself |
| Mark as read / unread | Had | Chat menu |
| Chat folders (Unread, Personal, Groups, your own) | **Built** | Folder bar over the chat list, folder editor |
| Saved messages (notes to self) | **Built** | "Saved messages" chat; forward anything into it |
| Drafts kept per chat | **Built** | Kept when you switch chats or restart; "Draft:" in the list |
| Scheduled messages | **Built** | Send-button menu → Schedule; sent by this device when due |
| Send without sound | **Built** | Send-button menu → Send silently; the other side gets no alert |
| Message formatting (bold, italic, code, strike, hidden text) | **Built** | `**bold**`, `__italic__`, `` `code` ``, ```` ``` ```` blocks, `~~strike~~`, `\|\|hidden\|\|` |
| Clickable links | **Built** | http(s) links open outside the app |
| Pin a message inside a chat | Tier 2 | Needs a `pin` action all devices understand |
| Polls and quizzes | Tier 2 | Needs a poll message type and vote actions |
| Auto-delete timer | Tier 2 | Needs a timer field honoured by every device |
| Link previews | Tier 3 | A preview fetched by the sender's device would leak what you open to that site; needs design |
| Stickers, GIFs, custom emoji | Tier 3 | Only with original FabriC++ art; GIF search would leak queries to a third party |
| Topics in large groups, channels | Other session | Channels are being built elsewhere |
| Bots and inline bots | Other session | Bot platform session |
| Translation | Had | On device (built-in model or Opus-MT) |
| Secret chats | N/A | Every FabriC++ chat is end-to-end encrypted already |

## Search and navigation

| Feature | Status | FabriC++ |
|---|---|---|
| Global search (chats and messages) | Had | Sidebar search box |
| Search in a chat | Had | Thread menu → Search in chat |
| Jump to date | **Built** | Thread menu → Jump to date |
| Shared media, files, voice and links per chat | **Built** | Thread menu → Shared media and files |
| Media viewer (zoom, previous/next, save) | Had → **Built** | Was: one photo, click to close. Now: gallery with arrows, zoom, save, counter |
| Keyboard shortcuts and a shortcuts sheet | **Built** | `Ctrl+/` shows them; see the sheet |
| Global "show/hide app" hotkey | **Built** (desktop) | `Ctrl+Alt+F` (`⌘⌥F`), can be switched off |

## Calls

| Feature | Status | FabriC++ |
|---|---|---|
| Voice and video calls | Had | Frame-level E2EE on top of DTLS-SRTP |
| Group calls, screen sharing | Had | Mesh to 8, SFU to 50 |
| Picture-in-picture video | **Built** | Call screen → Pop out (web and desktop) |
| Calls to ordinary phones | Had | FabriC++ Phone (not E2EE, says so) |

## Settings, privacy and security

| Feature | Status | FabriC++ |
|---|---|---|
| Night mode, follow the system | Had | Settings → Theme |
| Text size | **Built** | Settings → Appearance |
| Chat background | **Built** | Plain, hairline grid, dot grid, diagonal rule |
| Compact chat list | **Built** | Settings → Appearance |
| Notification on/off | Had | Settings → Chats |
| Notification sound, message preview (full / name only / nothing) | **Built** | Settings → Notifications |
| Per-chat notifications | Had → **Built** | Mute per chat, now with a duration |
| Local passcode | Had | Passphrase on the vault (PBKDF2, 600k) |
| Auto-lock after inactivity | **Built** | 1, 5, 15 or 60 minutes; needs a passphrase |
| Lock now from anywhere | **Built** | `Ctrl+L`, and the tray menu on desktop |
| Active sessions / devices, sign out others | Had | Security → Devices (signed device list, removal revokes) |
| Two-step verification | Had | Account key on the primary + passphrase + recovery key |
| Multiple accounts | **Built** | Settings → Accounts on this device (separate vaults) |
| Export chat history to a file | **Built** | Thread menu → Export chat (HTML, text or JSON) |
| Hide last seen / online | N/A | FabriC++ doesn't publish presence at all |
| Cloud history on every device | N/A | Keys and history stay on devices; linking copies recent history, backups are encrypted |
| Proxy setting | N/A (by design) | The desktop app uses the system proxy. There's no in-app proxy field, so nothing typed into the app can point it at another relay |
| Language packs for the UI | Tier 3 | Interface is English only |

## Desktop app

| Feature | Status | FabriC++ |
|---|---|---|
| Native app for Windows and macOS | Had | Electron shell, locked to the relay |
| Tray icon with unread marker | Had | Accent square on the F |
| Close to tray | Had → **Built** | Now a setting (on by default) |
| Start at login, start minimized | **Built** | Settings → Desktop app |
| Tray menu: lock, mute all, start at login | **Built** | |
| Taskbar flash on new messages | **Built** | Windows; setting |
| Spellcheck with chosen languages | **Built** | Settings → Desktop app; suggestions in the right-click menu |
| Save files and exports with a native dialog | Had | `will-download` save dialog |
| Single instance | Had | |
| Auto-update | Tier 3 | Needs signed builds and an update feed first |

## Android

New web features run in the Android app too (it loads the same page). Desktop-only items
(start at login, global hotkey, spellcheck languages, taskbar flash) are hidden there; keyboard
shortcuts are harmless on touch screens and work with a hardware keyboard.

## Built in this pass

Client (`public/desk.js`, `shared/desk.js`, hooks in `public/app.js`), desktop
(`desktop/main.js`, `desktop/ui/app-preload.js`). Tested by `test/desk.test.js` (helpers) and
`desktop/test/smoke.js` (end to end in the desktop app with a second device in Edge).

## Next, if wanted

Tier 2 in this order: pinned messages, polls, auto-delete timer. Each needs one new payload or
action that older clients ignore, plus tests in `test/actions.test.js`.
