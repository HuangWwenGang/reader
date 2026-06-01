// Screen-space rectangle of a selection/highlight range, used to anchor popups.
export interface AnchorRect {
  centerX: number
  top: number
  bottom: number
}

// Map a Range inside a book iframe to main-window screen coordinates.
// foliate renders each section in an <iframe>; range rects are relative to that
// iframe's viewport, so we offset by the iframe element's own bounding rect.
export function rangeToAnchor(doc: Document, range: Range): AnchorRect | null {
  const rect = range.getBoundingClientRect()
  const frameEl = doc.defaultView?.frameElement as HTMLElement | null
  if (!frameEl) return null
  const frame = frameEl.getBoundingClientRect()
  const top = frame.top + rect.top
  const bottom = frame.top + rect.bottom
  const centerX = frame.left + rect.left + rect.width / 2
  return { centerX, top, bottom }
}

// Clamp a popup of given size to the viewport, preferring placement below the
// anchor and flipping above when it would overflow the bottom.
export function placePopup(
  anchor: AnchorRect,
  width: number,
  height: number,
  margin = 12,
): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = anchor.centerX - width / 2
  left = Math.max(margin, Math.min(left, vw - width - margin))
  let top = anchor.bottom + 8
  if (top + height > vh - margin) {
    const above = anchor.top - height - 8
    top = above >= margin ? above : Math.max(margin, vh - height - margin)
  }
  return { left, top }
}
