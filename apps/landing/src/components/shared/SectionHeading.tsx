import { motion } from 'framer-motion'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'
import { cn } from '@/lib/utils'

interface SectionHeadingProps {
  title: string
  subtitle?: string
  align?: 'left' | 'center'
  className?: string
  titleClassName?: string
}

export function SectionHeading({
  title,
  subtitle,
  align = 'center',
  className,
  titleClassName
}: SectionHeadingProps) {
  return (
    <motion.div
      initial={BLUR_REVEAL_INITIAL}
      whileInView={BLUR_REVEAL_ANIMATE}
      viewport={{ once: true, margin: '-100px' }}
      transition={BLUR_REVEAL_TRANSITION}
      className={cn('mb-16', align === 'center' && 'text-center', className)}
    >
      <h2
        className={cn(
          'font-serif text-4xl md:text-5xl text-ink mb-6 relative inline-block',
          titleClassName ?? 'font-normal'
        )}
      >
        {title}
        <span className="absolute -bottom-2 left-1/4 right-1/4 h-px bg-terracotta/30" />
      </h2>
      {subtitle && (
        <p className="text-xl text-muted font-sans max-w-2xl mx-auto leading-relaxed">{subtitle}</p>
      )}
    </motion.div>
  )
}
