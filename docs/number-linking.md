# Linking real phone numbers to FabriC++ accounts

Status: plan, not built. Written 2026-11-09.

## What we want

Someone can tie their real phone number (the one on their SIM) to their `+name.veil` account. After that:

- When a FabriC++ user dials or texts that number, the app offers an **encrypted FabriC++ call or chat instead**.
  Nothing crosses the phone network, so the carrier never sees it.
- People without FabriC++ still reach the number the ordinary way. That traffic stays unencrypted, and nothing we
  build changes that: once a call or text crosses the phone network, the carrier handles it in the clear.
- Phone history the relay keeps (calls, texts, voicemail on a FABRIC number) is **sealed to the account's devices**,
  so the relay stores ciphertext only.

## The honest limits (to say in the app, too)

1. A call or text between a FabriC++ user and someone on a regular phone is never end-to-end encrypted. The carrier
   (Twilio, and the other person's carrier) sees it.
2. The relay vouches for "this number belongs to this account". A malicious relay could point a number at the wrong
   account. The defense is the one we already have: **safety numbers**. The account key behind a number is the
   account's own key, and a change of key raises the existing "account key changed" warning.
3. Phone numbers are guessable (there are only so many), so discovery has to be rate-limited and opt-in. Hashing
   numbers on the client does not hide them.

## Phase 1: verify, link, discover, upgrade (the main win)

### 1. Verify ownership of a number

- Settings → **Your phone number** → enter a number → the relay texts a 6-digit code → enter it → linked.
- Use **Twilio Verify** (not our own SMS) for the code. It handles code generation, expiry, retries and fraud
  checks (SMS pumping), and we never store the code.
- Limits: 3 code requests per account per hour, 10 a day; 5 wrong codes and the attempt is void; only countries
  in `FABRIC_PHONE_COUNTRIES`; per-number cool-off so nobody can text-bomb a stranger.
- One number belongs to one account. When a number is verified by a new account (numbers get recycled by
  carriers), the old link is dropped and the old owner's devices are told.
- Re-verify every 12 months, or a link quietly lapses (carriers recycle numbers).

### 2. Store the link without keeping raw numbers

New table in the relay store (and its Supabase snapshot, `fabric` schema):

```
phone_links(
  number_mac  TEXT PRIMARY KEY,  -- HMAC-SHA256(FABRIC_NUMBER_PEPPER, E.164 number)
  handle      TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL,
  discoverable INTEGER NOT NULL DEFAULT 0
)
```

- The relay keeps a keyed hash (HMAC), not the number. A leaked database alone doesn't list anyone's number.
  The pepper lives in the relay's environment, like the other secrets, never in the database.
- The account's own devices keep the plain number in the encrypted vault, to show it in Settings.

### 3. Discovery: "is this number on FabriC++?"

- New request `number_lookup { numbers: [...] }` → `{ results: { "+15551234567": "@ana.veil" | null } }`.
- Only numbers whose owner turned on **"Let people find me by my number"** answer. **Off by default** (open
  question below).
- Rate limit per account: 50 lookups at once, 200 a day. That makes walking the number space impractical.
- No contact-book upload in Phase 1. The app looks up a number only when someone types or taps it. Phase 3 adds
  opt-in contact matching.

### 4. Upgrade calls and texts in the app

- **Phone tab dialer and + → Call a phone number:** after a number is typed, look it up. If it belongs to a
  FabriC++ account, show the choice with encrypted as the default:
  - **Call on FabriC++ (end-to-end encrypted)** → the normal FabriC++ voice call to `+ana.veil`.
  - Call over the phone network (not encrypted).
- **Texting a number** works the same: offer an encrypted chat with the account instead of an SMS.
- **New message / search box:** accept a phone number as well as `+name`. Numbers have digits only, so
  `+15551234567` (a phone number) and `+ana.veil` (a handle) can't be confused.
- The contact keeps a local label ("Ana, +1 555 123 4567") in the vault, never sent to the relay.

### 5. Relay and client pieces

| Where | Change |
|---|---|
| `server/phone.js` | `number_verify_start`, `number_verify_check`, `number_unlink`, `number_lookup`, `number_discoverable`; Twilio Verify calls; limits |
| `server/store.js` | `phone_links` table and queries; drop links on unlink, account deletion and re-verification elsewhere |
| `server/relay.js` | route the new messages; include linked-number status in `phone_status` |
| `shared/phone-links.js` (new) | E.164 checks, HMAC helper, rate-limit constants, shared by relay and tests |
| `public/phone.js` | lookup on dial or text, the encrypted-or-phone choice |
| `public/app.js` + `index.html` | Settings card (verify, unlink, discoverable toggle); phone numbers in the search box |
| `test/phone-links.test.js` (new) | verify flow with a fake Twilio Verify, limits, recycling, lookup privacy (non-discoverable reads as null) |

Environment: `FABRIC_NUMBER_PEPPER` (32+ random bytes), `TWILIO_VERIFY_SERVICE_SID`.

## Phase 2: seal phone history on the relay

Today `phone_events` (calls, texts, voicemail metadata) sit in the relay store in plain text for 30 days.

- When a Twilio webhook arrives, the relay builds the event as now, then **seals it to every device of the
  account** with the existing sealed-box code (`shared/sealed.js`, the same path messages use). It stores only
  the sealed copies and drops the plaintext.
- Voicemail audio: fetched from Twilio, sealed the same way, then deleted from Twilio (we already keep it short).
- `phone_log` returns sealed events and the devices open them. A device linked later gets history from another
  device's backup, as with chats.
- What stays visible to the relay: the moment something arrived, and which account it was for. It needs these to
  route. Twilio still sees content in transit; this only closes our side.

## Phase 3 (later): contact matching and polish

- Opt-in "Find friends from my contacts" on Android: send numbers in batches under the same rate limits. Consider
  private set intersection (PSI) if the user base grows, so the relay learns nothing about non-matches.
- Show "on FabriC++" badges in the dialer history.
- Number change flow: move the link to a new number without losing chats (the account key doesn't change).

## Order of work and size

1. Store + verify + unlink + tests: about a day.
2. Lookup + discoverable toggle + limits + tests: half a day.
3. Client: Settings card, dialer and text upgrade, search by number: about a day.
4. Phase 2 sealing: about a day, plus a migration that seals or drops existing plaintext history.

Phase 1 needs a Twilio Verify service; it costs a small fee per verification.

## Questions for you

1. **Discoverable by default?** Off is more private (people must opt in); on makes the upgrade work out of the
   box. Recommendation: off, with a one-tap prompt right after verifying.
2. **Any number, or only numbers the user owns on a SIM?** Verification proves they receive texts there; that
   covers both. Recommendation: any number that can receive the code.
3. **Countries at launch:** `+1` only (as the phone service today), or more?
