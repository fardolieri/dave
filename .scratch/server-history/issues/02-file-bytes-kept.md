# 02 · File bytes kept on the server, encrypted, in the same window

Status: open
Blocked by: 01

**Why:** the server keeps a file's announcement (01), but its bytes still come only from a friend who is online and has
it. A picture sent while everyone else was away cannot be seen until the sender is back.

**What to build:** the sender also uploads a file of up to 16 MB (what pulls by itself today) to the Store, in 1 MB
pieces, each encrypted with the text key and bound to the room and the file's hash, like a sealed text. The Store keeps
them in the same window as the texts (one ledger, oldest first). A puller with no friend online who has the file asks
the Store, decrypts, and checks the hash as it does a friend's bytes. Larger files stay friend to friend.

## Open questions

- Upload through the Room's socket (frames of 1 MB hold up everything behind them on the sender's socket, ADR 0006) or
  a Worker path of its own with the room's auth.
- A Durable Object row holds 2 MB at most: a piece per row.
