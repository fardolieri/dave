# 08 · `/gif rick roll`: the first GIF Tenor finds, sent after the text

Status: in review
Raised by: the owner, 2026-11-18

**Why:** as `/yt` (ticket 07), for GIFs: "a /gif command similar to the /yt command where we do a giphy or tenor gif
search (whichever is easier to implement) and the dice rolling loading spinner" (owner).

**What was decided** (by the agent, the owner left the choice to it):
- **Tenor, not Giphy.** Both serve their search page to a request with no key or cookies, and both let any page read
  their media (CORS). Tenor's page carries its results as one JSON blob, in the shape of its API (`store-cache`, each
  result's files with their sizes); Giphy's are escaped inside a React stream, harder to read and likelier to change. The
  APIs of both want a key, Giphy's a key per app with 100 searches an hour until approved.
- Everything else as `/yt`: the text sends as it is, the sender's app asks our Worker (`/gif-search`, worker/gifsearch.ts),
  which reads Tenor's search page, then fetches the GIF from Tenor itself and sends it after the text as a picture. The
  same "🎲 rolling…" under the text for everyone while it is on the way (core/roll.ts), the same "No GIF sent: …" for the
  sender alone when Tenor found none or did not answer. No Durable Object is asked for the search.
- **The first animated result**: Tenor's results mix in stickers and still memes, which are passed over.
- **Animated WebP before GIF:** Tenor has every result as an animated WebP too, a tenth of the GIF's weight (346 kB for
  the GIF of 5.8 MB). Pictures are pulled by friends and kept in the Room for those away, so the lighter one goes, then
  Tenor's small WebP (200 px); the GIF only when Tenor has neither within 4 MB. Every browser the app runs in shows an
  animated WebP.
- The picture's announcement carries `gif: true`, so that a `/gif` stops rolling only on a GIF from its writer, not on any
  picture she sends meanwhile. Apps from before drop the mark and show the picture, with no rolling.

**Known slips:** those of `/yt` (ticket 07): a GIF answers the oldest `/gif` of its writer still rolling, so of two quick
ones where the first sends none, the second's GIF stops the first's rolling, for friends, and the second rolls on until
its 25 s are up. And a friend whose open tab still runs the app from before sends `/gif cats` as a text alone, which the
updated apps show rolling for its 25 s, until the tab is reloaded.

**Fragile by nature:** the page is Tenor's, not an API. Should Tenor change it, or refuse Cloudflare's addresses, `/gif`
says "No GIF sent: Tenor did not answer" every time. Giphy's page, or an API key, is the way out then.
