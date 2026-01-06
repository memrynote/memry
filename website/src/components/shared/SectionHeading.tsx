import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface SectionHeadingProps {
  title: string
  subtitle?: string
  align?: 'left' | 'center'
  className?: string
}

export function SectionHeading({
  title,
  subtitle,
  align = 'center',
  className
}: SectionHeadingProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className={cn('mb-16', align === 'center' && 'text-center', className)}
    >
      <h2 className="font-serif text-4xl md:text-5xl font-normal text-ink mb-6 relative inline-block">
        {title}
        <span className="absolute -bottom-2 left-1/4 right-1/4 h-px bg-terracotta/30" />
      </h2>
      {subtitle && (
        <p className="text-xl text-muted font-sans max-w-2xl mx-auto leading-relaxed">{subtitle}</p>
      )}
    </motion.div>
  )
}
