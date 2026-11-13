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
- A Short's card is upright (owner, 2026-11-13): its thumbnail is YouTube's upright one, 1080 by 1920, which only a
  Short has, and a card is upright when its picture is (the announcement's `width` and `height`). oEmbed's size will not
  do: it is wide or upright by the form of the link asked about. An app from before shows a Short's card wide, its
  upright picture cropped.
- An upright card is up to 300 px wide (owner, 2026-11-13): at 240 px YouTube's player dropped its fullscreen button
  from its control bar, on a phone and on a computer; somewhere between 250 and 300 px it keeps it, depending on the video.
- Big picture, not fullscreen (owner, 2026-11-14): for a Short, YouTube picks between two players at the same size, its
  Shorts player, which has no fullscreen button (as on youtube.com), and its usual one, which has. A fullscreen button of
  the card's own was tried first, and dropped: YouTube's button inside it went one fullscreen deeper, two to get out of
  (owner: a double fullscreen is unacceptable). Instead every YouTube card (⤢ beside its title) and every video file
  (⤢ in its corner) goes big over the page: as big as the window lets it be at its shape, at least 40 px of the dimmed
  page above and below it. Back, Esc, or a click on the page around it takes it back; no close button, to keep it lean
  (owner). It goes over the page where it is, so a playing video plays on. YouTube's own fullscreen, pressed in there,
  is the only fullscreen, and leaving it is back to big picture. Esc does nothing once a click put the keys in
  YouTube's player, a page of YouTube's own; Back and a click beside it still do. Over the page, the figure is the
  dimmed page itself: a popover's own backdrop let the click that closed it through to what was under it (review). Pictures keep their click to open full size (owner:
  everyone knows that one).

**Not verified here:** the player playing: YouTube asks this dev box (a datacenter address, headless) to sign in; a
real browser at home should play it. Nor Back on a real phone: in the e2e tests Back is the browser's history going
back, as an iPhone's swipe and Firefox's Back do; Chrome on Android also closes a popover by itself on Back.
