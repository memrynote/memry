import type { FC } from 'react'

interface MarqueeRect {
  left: number
  top: number
  width: number
  height: number
}

interface BlockHighlightRect {
  id: string
  left: number
  top: number
  width: number
  height: number
}

interface BlockMarqueeOverlayProps {
  rect: MarqueeRect | null
  highlights: ReadonlyArray<BlockHighlightRect>
}

export const BlockMarqueeOverlay: FC<BlockMarqueeOverlayProps> = ({ rect, highlights }) => {
  if (!rect && highlights.length === 0) return null
  return (
    <>
      {highlights.map((h) => (
        <div
          key={h.id}
          className="marquee-block-highlight"
          data-marquee-block-id={h.id}
          aria-hidden="true"
          style={{
            left: `${h.left}px`,
            top: `${h.top}px`,
            width: `${h.width}px`,
            height: `${h.height}px`
          }}
        />
      ))}
      {rect && (
        <div
          className="marquee-overlay"
          aria-hidden="true"
          style={{
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`
          }}
        />
      )}
    </>
  )
}
