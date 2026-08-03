/**
 * Agent-written cards must be indistinguishable from user-drawn ones.
 *
 * WHAT THIS PROVES: the agent write path hands `convertToExcalidrawElements`
 * exactly the skeleton contract the UI drop/picker path does, and the refs
 * re-derive from the result. `planCardPlacements` delegates every skeleton to
 * `makeCardSkeleton` — the same factory `canvas-card-overlay.tsx` uses — so the
 * two paths cannot drift without failing here.
 *
 * WHAT IT DOES NOT PROVE: that Excalidraw accepts the minted elements. The real
 * `@excalidraw/excalidraw` barrel cannot initialize under jsdom (its dev bundle
 * bare-imports open-color JSON, and ImageExportDialog throws at module scope),
 * which is why every unit suite in this directory mocks it. Real element
 * minting is exercised through the same converter by the canvas E2E specs in
 * real Electron, plus the manual verification in the #916 plan.
 */

import { describe, expect, it } from 'vitest'

import { planCardPlacements } from './canvas-scene-edit'
import { extractEntityRefs, makeCardSkeleton, type CardElement } from './canvas-cards'

describe('agent-written card skeletons match the UI path', () => {
  it('produces exactly what makeCardSkeleton produces, differing only in placement', () => {
    const [planned] = planCardPlacements(
      [],
      [{ entityType: 'note', entityId: 'n1', width: 260, height: 168 }]
    )
    const reference = makeCardSkeleton({
      entityType: 'note',
      entityId: 'n1',
      centerX: planned.x + planned.width / 2,
      centerY: planned.y + planned.height / 2,
      width: 260,
      height: 168
    })

    expect(planned).toEqual(reference)
  })

  it('carries the customData the card contract is keyed on', () => {
    const skeletons = planCardPlacements(
      [],
      [
        { entityType: 'note', entityId: 'n1' },
        { entityType: 'calendar_event', entityId: 'e1' }
      ]
    )

    expect(skeletons.map((s) => s.customData)).toEqual([
      { entityType: 'note', entityId: 'n1' },
      { entityType: 'calendar_event', entityId: 'e1' }
    ])
    expect(skeletons.every((s) => s.type === 'rectangle')).toBe(true)
    // Opaque fill is what makes the whole card interior a binding + selection
    // target (canvas-cards.ts:334); a transparent card would only hit-test on
    // its outline.
    expect(skeletons.every((s) => s.fillStyle === 'solid')).toBe(true)
  })

  it('re-derives the same entity refs once the elements carry ids', () => {
    // Stands in for convertToExcalidrawElements, which only adds identity and
    // version fields — customData passes through untouched.
    const elements = planCardPlacements(
      [],
      [
        { entityType: 'note', entityId: 'n1' },
        { entityType: 'task', entityId: 't1' }
      ]
    ).map((skeleton, index) => ({ ...skeleton, id: `minted-${index}`, angle: 0 }))

    expect(extractEntityRefs(elements as unknown as CardElement[])).toEqual([
      { entityType: 'note', entityId: 'n1' },
      { entityType: 'task', entityId: 't1' }
    ])
  })
})
