import { cn } from '@/lib/utils'

/**
 * Soft terracotta radial halo painted behind page content near the top.
 * Purely decorative. Requires a positioned ancestor (the page's `<main>` is
 * `relative`); sits at `-z-10` so it glows over the paper background but
 * behind everything else, and scrolls away with the page.
 *
 * `opacity` is applied via inline style (not a Tailwind arbitrary value) so it
 * can be tuned per page without tripping Tailwind's build-time class scan.
 * Override size/position with `className` (twMerge wins on conflicts).
 */
export function PageGlow({ className, opacity = 0.2 }: { className?: string; opacity?: number }) {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 -z-10 mx-auto h-[32rem] max-w-3xl',
        className
      )}
      style={{
        backgroundImage: `radial-gradient(ellipse at top, rgba(255, 103, 26, ${opacity}), transparent 70%)`
      }}
    />
  )
}
