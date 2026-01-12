/**
 * Drop Target Utilities
 *
 * Helper functions for finding drop targets in the BlockNote editor.
 * Separated from components to comply with React Fast Refresh requirements.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface DropTarget {
  /** The block ID where the file will be inserted */
  blockId: string
  /** Position relative to the block - before or after */
  position: 'before' | 'after'
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Find the nearest block and determine before/after position based on cursor Y coordinate.
 * Used during drag-over to show the drop indicator at the correct position.
 *
 * @param clientY - The Y coordinate of the cursor (from mouse event)
 * @param containerRef - Reference to the editor container
 * @returns The drop target with block ID and position, or null if no blocks found
 */
export function findDropTarget(
  clientY: number,
  containerRef: React.RefObject<HTMLElement | null>
): DropTarget | null {
  const container = containerRef.current
  if (!container) return null

  // Query all block elements - BlockNote adds data-id to each block when setIdAttribute is true
  const blockElements = container.querySelectorAll('[data-id]')

  if (blockElements.length === 0) {
    return null // Empty document
  }

  // Find the block where the cursor is positioned
  for (const el of blockElements) {
    const rect = el.getBoundingClientRect()

    // Check if cursor Y is above this block's bottom
    if (clientY < rect.bottom) {
      const blockId = el.getAttribute('data-id')
      if (!blockId) continue

      // If cursor is in top half of block, insert before; otherwise after
      const midpoint = rect.top + rect.height / 2
      const position = clientY < midpoint ? 'before' : 'after'
      return { blockId, position }
    }
  }

  // If cursor is past all blocks, insert after the last block
  const lastBlock = blockElements[blockElements.length - 1]
  if (lastBlock) {
    const blockId = lastBlock.getAttribute('data-id')
    if (blockId) {
      return { blockId, position: 'after' }
    }
  }

  return null
}

/**
 * Calculate the position of the drop indicator relative to a container.
 *
 * @param dropTarget - The target block and position
 * @param containerRef - Reference to the container element
 * @returns CSS properties for positioning the indicator, or null if position cannot be calculated
 */
export function calculateIndicatorPosition(
  dropTarget: DropTarget,
  containerRef: React.RefObject<HTMLElement | null>
): React.CSSProperties | null {
  const container = containerRef.current
  if (!container) return null

  // Find the target block element using data-id attribute
  const blockElement = container.querySelector(`[data-id="${dropTarget.blockId}"]`)
  if (!blockElement) return null

  const containerRect = container.getBoundingClientRect()
  const blockRect = blockElement.getBoundingClientRect()

  // Calculate position relative to container
  const top =
    dropTarget.position === 'before'
      ? blockRect.top - containerRect.top - 2
      : blockRect.bottom - containerRect.top + 2

  return {
    top: `${top}px`,
    left: '0',
    right: '0'
  }
}
