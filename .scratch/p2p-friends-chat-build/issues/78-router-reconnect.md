# 78 · After a router reconnect, dave could not reconnect

Status: reproducing
Type: bug (reported by the owner: "Couldn't reconnect after a router reconnect")

## The report
The owner's FRITZ!Box 7490 reconnects to the internet ("Neu verbinden" under Internet > Online-Monitor). The line drops
for a short time and comes back with a new public IPv4 address and, on Telekom, a new IPv6 prefix. dave did not
reconnect afterwards.

## How it is reproduced
On the dev box, which sits behind that router: this PR's preview open in browser tabs, in its room, then "Neu verbinden"
clicked on the router. A timeline of the page (room status, call states, console) and of the box's network (addresses,
reachability) is kept through the outage and read afterwards.
