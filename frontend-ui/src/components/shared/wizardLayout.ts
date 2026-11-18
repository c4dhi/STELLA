/**
 * Sizes shared by the deploy wizards (session "Deploy agent" and the public
 * project setup). A short step's dialog is only as tall as its content; a
 * longer step grows up to the cap below, and only scrolls past that.
 *
 * Width: 672px on a laptop, 768px from 1536px (full HD), 896px on a 4K
 * screen at 100% scaling. A 4K screen at 200% scaling has the
 * CSS size of full HD and gets the full-HD box.
 *
 * Height cap: 62% of the window, at least 520px and at most 860px, never
 * taller than the window minus a margin.
 *
 * Card grids have two columns.
 *
 * Tailwind's JIT scanner needs each class written out in full in the source
 * it scans — building one from a shared piece at runtime means the class
 * never appears literally and no CSS gets generated for it. So the height
 * cap below is duplicated into WIZARD_OVERLAY_ALIGN's padding formula rather
 * than shared; keep the two in sync by hand.
 */
export const WIZARD_MODAL_SIZE =
  'max-w-2xl 2xl:max-w-3xl min-[2560px]:max-w-4xl max-h-[min(calc(100dvh-2rem),clamp(520px,62dvh,860px))]'

/**
 * Classes for the wizard's overlay (replacing `items-center`). A dialog
 * shorter than the cap would otherwise still be centered, moving its top
 * edge — and the header and step bar in it — up and down as steps differ in
 * height. This anchors the top where a capped-height dialog's top would sit
 * when centered, so only the bottom edge moves; a shorter step just leaves
 * more gap underneath. The cap inside this formula must match
 * WIZARD_MODAL_SIZE's max-height above.
 */
export const WIZARD_OVERLAY_ALIGN =
  'items-start pt-[max(1rem,calc((100dvh-min(calc(100dvh-2rem),clamp(520px,62dvh,860px)))/2))]'

export const WIZARD_CARD_GRID = 'grid grid-cols-2 gap-3'
