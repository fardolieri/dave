# dave

Rooms for a few friends: text, voice, and screen share over a peer-to-peer WebRTC mesh, brokered by a small Cloudflare Worker that never touches the media and cannot insert itself into a call: each WebRTC handshake is signed by the sender's identity key and checked by the receiver. Spec: `.scratch/p2p-friends-chat/spec.md`. Glossary: `CONTEXT.md`. Decisions: `docs/adr/`.

## Using it

Without an invite link the site shows nothing but a notice: only friends get in, and only friends can invite. Anyone already in a room can start another: **New room** in the sidebar names it and shows its **invite link**, the app URL with the room's secret and name after `#`, for example `https://dave.example.workers.dev/#Qm3v…/Game%20night`. A friend who opens the link lands in that room; it is added under their other rooms and the secret is stripped from the address bar. A link can also be pasted in, on the front page or under **Join by link** in the sidebar: an app added to an iPhone or iPad home screen never receives a tapped link (Safari opens it, with storage of its own), so pasting is the only way a room reaches it. The server stores nothing but a hash of the secret, so a link is all a room is (`docs/adr/0004`). Old links without a name still work.

Each browser gets its own identity key. A friend you have not seen before wears a "new" badge and a six-character fingerprint until you click them; after that the fingerprint only returns when two friends show the same name. Click an avatar for the profile card: fingerprint, since when you know them, and a nickname only your browser shows. Your own card changes the name everyone sees, and clicking your own big avatar picks an emoji as your profile picture.

The sidebar lists everyone online across your rooms, then each room by name with its call under it. Click a room's name to read and write there; the smiley next to the message box opens an emoji picker (search by name, browse by category, or paste one; Enter takes the first match); a count beside the name is messages that arrived while you were elsewhere. **Join** in a room enters its call (leaving any other call first); the call stays up while you read another room, and its shares stay on screen. **Share screen** publishes one share; nobody receives it until they click its tile. The gear next to Share screen tunes frame rate, resolution, and bandwidth live; the gear next to Mute picks devices and toggles audio processing. **Leave <room>** at the bottom forgets a room in this browser; the link gets you back in.

To rotate a room's secret: start a new room and send everyone its link.

## Developing

    pnpm install
    cp .dev.vars.example .dev.vars   # local TURN placeholder
    pnpm dev                          # SPA with HMR plus the Worker in workerd, one server at http://localhost:5173
    pnpm test                         # core isolation check, then vitest inside workerd
    pnpm typecheck
    pnpm build                        # dist/client and dist/dave

`node scripts/drive.mjs --join --share <url> <secret> Alice Bob Carol` drives real headless Chromium profiles through join, mute, share, subscribe, and leave, and reports what each browser shows. Use `localhost`, not `127.0.0.1`, for the dev server. `BROWSER_BOB="flatpak run --filesystem=$HOME/.cache/dave-drive com.brave.Browser" PROFILE_DIR=$HOME/.cache/dave-drive AUTOPLAY_BLOCK=Bob BLACK_CHECK=1` runs one browser in Brave with autoplay blocked and probes whether the share tile actually paints (ticket 16). Firefox has no CDP;  runs the same viewer check through Playwright (see its header).

Deploys run from GitHub Actions. A push to `master` deploys the **nightly** Worker, `dave-nightly`, a second copy of the app with its own rooms for trying things out; a push to `prod` deploys the live site, `dave`. Releasing is a fast-forward of `prod` to `master`: `git push origin master:prod`. The nightly Worker is a Wrangler environment in `wrangler.jsonc`, chosen at build time through `CLOUDFLARE_ENV`; `CLOUDFLARE_ENV=nightly pnpm build && pnpm exec wrangler deploy` does the same by hand. Secrets live in GitHub repository secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TURN_KEY_API_TOKEN`) and are pushed to whichever Worker is deployed; nothing secret is in this repo. The `ROOM_SECRET` secret from before rooms is unused and can be deleted.
