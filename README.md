# Just Us — Same space. Two hearts.

A private, two-person static web app. No backend, no database — every
device talks directly to its partner over WebRTC, and everything you
create is stored only in that device's own IndexedDB.

## File structure

```
/index.html
/css/style.css
/js/
  utils.js      shared helpers (ids, dates, toast, modal, sample content generators)
  db.js         IndexedDB wrapper (the only "database"), with in-memory fallback
  webrtc.js     peer connection, manual serverless signaling, and voice/video calls
  sync.js       packet router + last-write-wins conflict resolution
  chat.js       chat screen logic (text, photos, video, voice notes, reactions, location)
  notes.js      notes screen logic
  tasks.js      to-do screen logic
  memories.js   photos/files screen logic
  missyou.js    one-tap "thinking of you" ping with heart-burst feedback
  location.js   Share Location (current/live pin) + combined "Our Location" radar view
  call.js       voice/video call UI (ringing, incoming, connected, controls)
  settings.js   profile, App Lock, export/import/clear, leave space
  app.js        router + boot sequence, ties every module together
/manifest.json  PWA manifest
/service-worker.js  offline app-shell caching
/assets/            icon-32.png, icon-180.png, icon-192.png, icon-512.png
```

## 1. How to run locally

This is plain HTML/CSS/JS — no build step, no Node required. Because
it uses a service worker, open it through a local web server rather
than double-clicking the file:

```bash
cd just-us
python3 -m http.server 8080
# then open http://localhost:8080 on your phone or desktop browser
```

Any static server works (`npx serve`, VS Code's Live Server, etc).

## 2. How to deploy to GitHub Pages

1. Push this folder's contents to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Set **Source** to the branch containing these files (root folder).
4. GitHub gives you a URL like `https://username.github.io/repo-name/`.

Every path in the app is written relative (`./css/...`, `./js/...`),
so it works whether the site sits at the domain root or under a
repository subpath — no changes needed either way.

## 3. How the two-device pairing works

There are exactly two roles:

- **Create Space** (host): generates a WebRTC offer and turns it into
  a single copyable text code.
- **Join Space** (guest): pastes that code, generates a WebRTC
  answer, and gets back its own code to send to the host.
- The host pastes the guest's answer code back in, and the direct
  connection opens.

Two codes have to move between the phones once, by whatever channel
you already trust — text message, AirDrop, reading it aloud. After
that one exchange, the DataChannel is open and nothing else needs a
network intermediary — including, notably, voice/video calls: since
the same connection is already live, a call is just that connection
carrying audio/video too, renegotiated through the open DataChannel.
No second pairing step, ever.

## 4. How WebRTC signaling works (and why it's manual)

WebRTC always needs *some* way for two browsers to swap their initial
connection details (an SDP offer and answer) before they can talk
directly. Normally an app runs a small signaling server for this.
This app has no server and must run as static files on GitHub Pages,
so there's nothing available to relay that first handshake.

The closest valid backend-free approach is **manual signaling**: the
app waits for ICE candidate gathering to finish (non-trickle ICE),
bundles the complete offer/answer into one Base64 text blob, and lets
the two people move that blob themselves. It's not as seamless as
scanning a QR code against a server, but it needs zero infrastructure
and keeps the "no backend, no database" requirement intact end to end.

Because there's no signaling server sitting in the middle, there's
also no server-enforced "room" — `MAX_PEERS = 2` is enforced by the
UI/UX (one offer, one answer, one connection), not by a central
authority. A used code is also explicitly retired: completing a space
locks its "Copy Code" button and rejects any second answer against
the same offer with a clear message. See the comment block at the top
of `js/webrtc.js` for the full reasoning.

## 5. What requires internet

- The **first connection** between two devices needs internet so
  WebRTC's STUN servers can help find a direct path (and so the two
  of you can send each other the pairing codes at all).
- If you're both on the same local network, you may connect even
  without wider internet access, since STUN is just used to discover
  reachable addresses.
- **Sharing your real location** needs the device's location
  permission, which browsers only grant on HTTPS or `localhost` — see
  `js/location.js`'s header comment for the "sample pin" fallback used
  when that's unavailable.
- **Voice/video calls** need camera/microphone permission, same
  HTTPS/localhost requirement as location.
- Loading Google Fonts on first visit needs internet; after that the
  service worker's cached fonts/files keep the UI looking right
  offline (fonts fall back to system fonts if never cached).

## 6. What works offline

- Reading and editing your own **notes, tasks, chat history, and
  memories** already stored on your device — all of it lives in
  IndexedDB and needs no network at all.
- The app shell itself (HTML/CSS/JS) loads offline once visited, via
  the service worker.
- Anything you create while your partner is offline is queued
  locally (`syncQueue` in IndexedDB) and sent automatically the next
  time the DataChannel reopens.

## 7. Where data is stored

- **Notes, messages, tasks, memories, settings**: IndexedDB,
  store-per-feature, entirely on-device (`js/db.js`).
- **Device id, App Lock PIN hash, "have I paired before" flag,
  last Miss You ping timestamp**: `localStorage`, since these are a
  few bytes of app state rather than user content.
- **Nothing** is ever written to a server, because there is no
  server. Peer-to-peer traffic — including chat, files, location
  updates, and call audio/video — goes directly between the two
  browsers over WebRTC's encrypted transport (DTLS/SRTP) once
  connected.

## 8. Known browser limitations

- **No persistent signaling channel** means that if the app is fully
  closed and reopened, the previous RTCPeerConnection is gone — the
  two of you will need to redo the one-time code exchange to
  reconnect (tap the "Waiting to connect" status on Home to get back
  to that flow). Data created while apart is never lost; it's just
  waiting locally until you reconnect.
- **Voice messages, calls, and location** all need real device
  permissions (microphone, camera, location) that only work on a
  real HTTPS deployment or `localhost` — not from a `file://` path,
  and not inside most embedded preview/sandboxed frames.
- **Large file transfers** are chunked at 16KB per DataChannel
  message and read fully into memory as they arrive on the receiving
  side, so very large files (well beyond typical photos/voice notes)
  will use noticeably more memory on lower-end devices.
- **"Our Location"** shows relative direction/distance as a custom
  radar view rather than an embedded map, by design — see the header
  comment in `js/location.js`.
- **App Lock** is a local UI gate only (PIN hashed with SHA-256
  before storage, or a simple non-cryptographic fallback if
  `crypto.subtle` is unavailable) — it does not encrypt IndexedDB
  contents and isn't a substitute for your device's own lock screen.
