# 07 · `/yt rick roll`: the first video YouTube finds, sent after the text

Status: in review
Raised by: the owner, 2026-11-17

**Why:** fun. Typing `/yt rick roll` sends whatever YouTube finds first for "rick roll", and nobody knows what that is
until it comes, the sender neither: a little gamble (owner).

**What was decided** (with the owner, in the conversation of 2026-11-17):
- No preview: `/yt rick roll` sends as it is, at once, a text like any other. Then the sender's app asks for the first
  video and sends it after the text as its card, the same card a pasted YouTube link makes (ticket 06). The server only
  connects friends, so it is the sender's app that sends the card: a page closed before the answer sends none.
- The first video of YouTube's results, videos only (no channels, playlists or shelves of Shorts; a Short can still
  come, and comes upright). Not one of the first few at random: the owner may want that later.
- None found, or YouTube out of reach: the sender's own log says "No video sent: …", which of the two; friends see the
  text alone. Two sent at once bring their cards in the order of their texts; a text written meanwhile can come between
  a `/yt` and its card.
- The search is the Worker's (`/yt-search`, worker/ytsearch.ts), which reads YouTube's results page as a browser with no
  cookies would. Looked for first (2026-11-17): no open API a browser can ask. YouTube's Data API wants a key and allows
  about 100 searches a day; the public Invidious instances had their API off or answered 403; Piped's main API did not
  answer. A browser cannot read YouTube's page itself (no CORS).
- The Worker asks no Durable Object for it: a search costs one Worker request and none of the day's Durable Object time
  (ticket 84). Per IP under the same limit as sockets, counted apart. The words go in the POST's body: Cloudflare's logs
  of the Worker keep request addresses, and the words are a sealed text's. YouTube sees them, as it would in a browser.

**Two layouts:** on 2026-11-17 YouTube served about one results page in eight in a newer layout (`lockupViewModel`), the
same search in either from one request to the next: both are read. Seen on PR #155's preview, where 4 of 30 searches
said "YouTube did not answer" before.

**Fragile by nature:** the page is YouTube's, not an API. Should YouTube change it, or refuse Cloudflare's addresses,
`/yt` says "No video sent" every time; the Data API with a key is the way out then.

**Results are not anyone's own:** no cookies, from wherever Cloudflare runs the Worker, in the sender's browser language.
