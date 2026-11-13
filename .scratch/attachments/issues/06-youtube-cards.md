# 06 · A YouTube link's card, with its player a tap away

Status: in review
Raised by: the owner, 2026-11-13

**Why:** a YouTube link in the chat is a bare link. Friends want to see what it is, and play it in place.

**What was decided** (with the owner, in the conversation of 2026-11-13):
- A YouTube link coming into the composer's text stages its card above it, as a pasted picture is staged: the
  thumbnail, the title, the channel, and ✕ to take it off, which sends the plain link. However the link comes: a paste,
  a phone keyboard's clipboard (Gboard's pastes with no paste event, so watching pastes alone missed every link on the
  owner's phone, 2026-11-13), or typed out. A link already in the text does not bring back a card taken off.
- The card is a real picture, YouTube's thumbnail, sent and pulled like any other: friends' browsers never ask YouTube
  for anything until they press play. Its announcement names the video, with its title and channel (`youtube`).
- Above the text, as pictures go. The file's name is `youtube-<id>.jpg`.
- The thumbnail is the 1280 px one, else the 480 px one every video has (cropped to 16:9). A deleted video shows
  YouTube's grey placeholder; no other rules.
- An app from before shows the thumbnail as a plain picture under the link.

**Not verified here:** the player playing. YouTube asks this dev box (a datacenter address, headless) to sign in; a
real browser at home should play it.
