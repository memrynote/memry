import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'

/**
 * AICSS Orbs, S3 ("Working") variant only: a 3x3 dot lattice whose perimeter
 * carries one comet head with a decaying tail, running clockwise. The centre
 * cell sits the choreography out so the ring reads as a ring.
 *
 * Geometry is authored on a 28px stage and scaled by `--orb-k`, so dot size and
 * pitch hold at any rendered size. Styles live in base.css (`.aicss-orb*`).
 * Source: https://www.aicss.dev/components/orbs
 */

const STAGE = 28
const N = 3
const PITCH = 6
const MID = (N - 1) / 2
const CYCLE_MS = 1700

/** Clockwise walk of the lattice perimeter: the track the comet runs on. */
const RING: Array<[number, number]> = (() => {
  const ring: Array<[number, number]> = []
  for (let x = 0; x < N; x++) ring.push([x, 0])
  for (let y = 1; y < N; y++) ring.push([N - 1, y])
  for (let x = N - 2; x >= 0; x--) ring.push([x, N - 1])
  for (let y = N - 2; y >= 1; y--) ring.push([0, y])
  return ring
})()

const RING_INDEX = new Map(RING.map(([x, y], index) => [`${x},${y}`, index]))

interface Cell {
  key: string
  left: number
  top: number
  /** Negative delay seeds each ring cell partway into its cycle, forming one comet. */
  delay: number
  still: boolean
  mid: boolean
}

const CELLS: Cell[] = Array.from({ length: N * N }, (_, index) => {
  const x = index % N
  const y = Math.floor(index / N)
  const ringIndex = RING_INDEX.get(`${x},${y}`)
  return {
    key: `${x},${y}`,
    left: x * PITCH,
    top: y * PITCH,
    delay:
      ringIndex === undefined
        ? 0
        : -(((RING.length - ringIndex) % RING.length) / RING.length) * CYCLE_MS,
    still: ringIndex === undefined,
    mid: x === MID && y === MID
  }
})

export interface OrbProps {
  /** Rendered edge length in px. */
  size?: number
  /** Accessible name. Omit when a visible label beside the orb already says it. */
  label?: string
  className?: string
}

export function Orb({ size = 20, label, className }: OrbProps): React.JSX.Element {
  return (
    <span
      className={cn('aicss-orb', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <span
        className="aicss-orb-glyph"
        style={{ width: size, height: size, '--orb-k': size / STAGE } as CSSProperties}
      >
        <span className="aicss-orb-lattice">
          {CELLS.map((cell) => (
            <span
              key={cell.key}
              className="aicss-orb-cell"
              data-still={cell.still ? '' : undefined}
              data-mid={cell.mid ? '' : undefined}
              style={{ left: cell.left, top: cell.top, animationDelay: `${cell.delay}ms` }}
            />
          ))}
        </span>
      </span>
    </span>
  )
}
