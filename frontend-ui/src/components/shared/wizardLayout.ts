/**
 * Sizes shared by the deploy wizards (session "Deploy agent" and the public
 * project setup). The dialog is sized by the screen, not by the step: every
 * step gets the same box, and what doesn't fit scrolls inside it.
 *
 * Width: 672px on a laptop, 768px from 1536px (full HD), 896px on a 4K
 * screen at 100% scaling. A 4K screen at 200% scaling has the
 * CSS size of full HD and gets the full-HD box.
 *
 * Height: 62% of the window, at least 520px and at most 860px, never taller
 * than the window minus a margin.
 *
 * Card grids have two columns.
 */
export const WIZARD_MODAL_SIZE =
  'max-w-2xl 2xl:max-w-3xl min-[2560px]:max-w-4xl h-[min(calc(100dvh-2rem),clamp(520px,62dvh,860px))]'
export const WIZARD_CARD_GRID = 'grid grid-cols-2 gap-3'
