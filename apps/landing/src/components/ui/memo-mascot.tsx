import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

interface MemoMascotProps {
  className?: string
  style?: CSSProperties
}

/**
 * "Memo" — the one mascot that is a character rather than an object: a folded page with a
 * dog-eared corner, ink eyes and a single terracotta ribbon. Drawn inline (not a PNG under
 * /mascots) because it renders at 84–120px here and has to stay crisp on the ring.
 */
export function MemoMascot({ className, style }: MemoMascotProps) {
  return (
    <svg
      viewBox="0 0 96 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn('block', className)}
      style={style}
    >
      <path d="M42.5 74 L42.5 93.5 L48.4 87.6 L54.2 93.8 L54 74 Z" fill="var(--color-terracotta)" />
      <path
        d="M22.6 18.2 C22.4 16.9 23.4 16 24.8 16.1 L61.4 15.4 L78.2 32.6 L77.4 77.6 C77.6 79.2 76.4 80.3 74.8 80.2 L24.2 80.8 C22.6 80.9 21.8 79.8 21.9 78.3 Z"
        stroke="#2b2a28"
        strokeWidth="3.6"
        strokeLinejoin="round"
      />
      <path
        d="M61.4 15.6 C61.9 21 62.1 26.6 62.2 31.9 C67.4 32.2 72.8 32.4 78.1 32.6"
        stroke="#2b2a28"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="39.2" cy="49.6" rx="3.7" ry="3.9" fill="#2b2a28" />
      <ellipse cx="57.4" cy="49.4" rx="3.7" ry="3.9" fill="#2b2a28" />
      <path
        d="M42.4 60.2 C45.2 63.8 51.4 63.9 54.4 60.4"
        stroke="#2b2a28"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  )
}
