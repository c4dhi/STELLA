/**
 * Where a full-screen panel has to sit so it covers exactly what the user can
 * see (#206).
 *
 * On a phone the layout viewport doesn't shrink when the on-screen keyboard
 * opens, but the visual viewport does, and iOS Safari often scrolls it as
 * well (`offsetTop > 0`). A panel that follows only the height still starts
 * at the top of the page, above the visible area, and its bottom (the
 * composer) ends up behind the keyboard. Following both keeps it in view.
 */
export interface ViewportLike {
  height: number
  offsetTop: number
}

export interface ViewportBox {
  top: number
  height: number
}

export function visualViewportBox(vv: ViewportLike | null | undefined): ViewportBox | undefined {
  if (!vv) return undefined
  return { top: Math.max(0, vv.offsetTop), height: vv.height }
}
