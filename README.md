# dave

A single-room chat for a few friends: text, voice, and screen share over a peer-to-peer WebRTC mesh, brokered by a small Cloudflare Worker that never touches the media and cannot insert itself into a call: each WebRTC handshake is signed by the sender's identity key and checked by the receiver. Spec: `.scratch/p2p-friends-chat/spec.md`. Glossary: `CONTEXT.md`. Decisions: `docs/adr/`.

## Using it

Friends enter through an **invite link**: the app URL with the shared secret after `#`, for example `https://dave.example.workers.dev/#the-passphrase`. The secret is stored in the browser on first visit and stripped from the address bar. Each browser gets its own identity key. A friend you have not seen before wears a "new" badge and a six-character fingerprint until you click them; after that the fingerprint only returns when two friends show the same name. Click an avatar for the profile card: fingerprint, since when you know them, and a nickname only your browser shows. Your own card changes the name everyone sees.

Open the page to see who is online and who is in the call, chat as a visitor, then **Join** for voice. The smiley next to the message box opens an emoji picker: search by name, browse by category, or paste one; Enter takes the first match. **Share screen** publishes one share; nobody receives it until they click its tile. The gear next to Share screen tunes frame rate, resolution, and bandwidth live; the gear next to Mute picks devices and toggles audio processing.

To rotate the secret: change the `ROOM_SECRET` GitHub repository secret, push to redeploy, send everyone a new link.

## Developing

    pnpm install
    cp .dev.vars.example .dev.vars   # local ROOM_SECRET
    pnpm dev                          # SPA with HMR plus the Worker in workerd, one server at http://localhost:5173
    pnpm test                         # core isolation check, then vitest inside workerd
    pnpm typecheck
    pnpm build                        # dist/client and dist/dave

`node scripts/drive.mjs --join --share <url> <secret> Alice Bob Carol` drives real headless Chromium profiles through join, mute, share, subscribe, and leave, and reports what each browser shows. Use `localhost`, not `127.0.0.1`, for the dev server.

Deploys run from GitHub Actions on push to master. Secrets live in GitHub repository secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TURN_KEY_API_TOKEN`, `ROOM_SECRET`) and are pushed to the Worker by the workflow; nothing secret is in this repo.
