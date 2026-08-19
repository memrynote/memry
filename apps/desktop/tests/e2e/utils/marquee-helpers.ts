/**
 * Marquee-selection E2E geometry helpers.
 *
 * Shared by marquee-selection.e2e.ts (note), marquee-selection-journal.e2e.ts
 * (journal) and marquee-selection-block-types.e2e.ts (block-type matrix).
 *
 * A drag that is meant to produce a BLOCK selection must START outside the
 * text column — in the gray margin the marquee zone leaves beside it. A drag
 * that starts at the horizontal centre of a block starts inside text, which is
 * the gesture for selecting text, not blocks.
 *
 * The x is DERIVED, never hardcoded. Both surfaces wrap their scroll area in a
 * `.marquee-zone` that spans the full width (note-layout.tsx, journal.tsx) and
 * centre a narrower text column inside it, so the midpoint of the gap between
 * the zone's leading edge and the block's leading edge is the middle of the
 * margin on either surface, at any window width and any content-width setting.
 */

import type { Page } from '@playwright/test'

const MARQUEE_ZONE_SELECTOR = '.marquee-zone'
const BLOCK_SELECTOR = '.bn-block[data-id]'

// A margin narrower than this leaves nothing to aim at: the midpoint would sit
// a few pixels from the text column and a drag "in the margin" would silently
// start inside text instead — which is exactly the failure mode these helpers
// exist to prevent. Fail loudly so a layout change (padding dropped, column
// widened, zone no longer full-width) is reported as itself.
const MIN_GUTTER_PX = 24

/**
 * X coordinate inside the gray margin beside the text column, measured against
 * the block the drag is meant to start next to.
 */
export async function marqueeGutterX(page: Page, blockIndex = 0): Promise<number> {
  const zone = await page.locator(MARQUEE_ZONE_SELECTOR).first().boundingBox()
  if (!zone) throw new Error(`marquee zone (${MARQUEE_ZONE_SELECTOR}) has no bounding box`)

  const block = await page.locator(BLOCK_SELECTOR).nth(blockIndex).boundingBox()
  if (!block) throw new Error(`block at index ${blockIndex} has no bounding box`)

  const gutter = block.x - zone.x
  if (gutter < MIN_GUTTER_PX) {
    throw new Error(
      `marquee margin is ${gutter.toFixed(1)}px wide ` +
        `(zone.x=${zone.x.toFixed(1)}, block[${blockIndex}].x=${block.x.toFixed(1)}), ` +
        `need at least ${MIN_GUTTER_PX}px to start a drag beside the text column`
    )
  }

  return zone.x + gutter / 2
}
