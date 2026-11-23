/** The face preview's size: 520 px, or the screen's width less a 16 px margin each side (#184). */
export function previewFaceSize(viewportWidth: number, max = 520): number {
  return Math.max(160, Math.min(max, viewportWidth - 32))
}
