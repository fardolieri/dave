/**
 * Puts a fixed-position popover next to the element it belongs to, always inside the viewport.
 * `beside`: to the right when there is room, else below (the profile card).
 * `above`: over the anchor when there is room, else below, left edges aligned (the emoji picker over the composer).
 * `besideOf`: beside that element instead, at the anchor's height (a row of the sidebar: beside the sidebar).
 */
export function place(card: HTMLElement, anchor: HTMLElement, prefer: 'beside' | 'above' = 'beside', besideOf?: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const right = besideOf ? besideOf.getBoundingClientRect().right : a.right;
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const gap = 8;
  let left: number;
  let top: number;
  if (prefer === 'above') {
    left = a.left;
    top = a.top - gap - h;
    if (top < gap) top = a.bottom + gap;
  } else {
    left = right + gap;
    top = a.top - gap;
    if (left + w > window.innerWidth - gap) { left = a.left; top = a.bottom + gap; }
  }
  left = Math.max(gap, Math.min(left, window.innerWidth - w - gap));
  top = Math.max(gap, Math.min(top, window.innerHeight - h - gap));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}
