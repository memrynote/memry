/**
 * Inbox Zero Empty State
 *
 * Celebration state shown when user has processed all items.
 * Shows stats about today's productivity.
 */
import { useEffect, useState, useMemo } from 'react'
import { Sparkles, FolderCheck, Trash2, Clock, Timer, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// =============================================================================
// TYPES
// =============================================================================

export interface InboxZeroStats {
  processedToday: number
  filedToday: number
  deletedToday: number
  snoozedToday: number
  avgProcessingTime?: number // in seconds
}

export interface InboxZeroProps {
  stats: InboxZeroStats
  onCapture?: () => void
  className?: string
}

// =============================================================================
// CONFETTI PARTICLE
// =============================================================================

interface Particle {
  id: number
  x: number
  y: number
  size: number
  color: string
  delay: number
  duration: number
}

function generateParticles(count: number): Particle[] {
  const colors = [
    'bg-amber-400',
    'bg-orange-400',
    'bg-yellow-400',
    'bg-primary',
    'bg-emerald-400',
  ]

  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    y: Math.random() * 100,
    size: 4 + Math.random() * 6,
    color: colors[Math.floor(Math.random() * colors.length)],
    delay: Math.random() * 500,
    duration: 1000 + Math.random() * 1000,
  }))
}

// =============================================================================
// STAT ITEM
// =============================================================================

interface StatItemProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number
  color: string
  delay: number
  isVisible: boolean
}

function StatItem({
  icon: Icon,
  label,
  value,
  color,
  delay,
  isVisible,
}: StatItemProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2',
        'transition-all duration-300',
        isVisible ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2'
      )}
      style={{ transitionDelay: `${delay}ms` }}
    >
      <div className={cn('flex size-8 items-center justify-center rounded-md', color)}>
        <Icon className="size-4 text-white" />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums text-foreground">
          {value}
        </span>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
    </div>
  )
}

// =============================================================================
// COMPONENT
// =============================================================================

export function InboxZero({
  stats,
  onCapture,
  className,
}: InboxZeroProps): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(false)
  const [showConfetti, setShowConfetti] = useState(false)

  // Generate confetti particles
  const particles = useMemo(() => generateParticles(20), [])

  // Animate in on mount
  useEffect(() => {
    const timer1 = setTimeout(() => setIsVisible(true), 50)
    const timer2 = setTimeout(() => setShowConfetti(true), 200)
    const timer3 = setTimeout(() => setShowConfetti(false), 2500)

    return () => {
      clearTimeout(timer1)
      clearTimeout(timer2)
      clearTimeout(timer3)
    }
  }, [])

  // Format average time
  const formatAvgTime = (seconds?: number): string => {
    if (!seconds) return '--'
    if (seconds < 60) return `${Math.round(seconds)}s`
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  }

  return (
    <div
      className={cn(
        'relative flex min-h-[500px] flex-col items-center justify-center px-6 py-12',
        'overflow-hidden',
        className
      )}
    >
      {/* Confetti Animation */}
      {showConfetti && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {particles.map((particle) => (
            <div
              key={particle.id}
              className={cn(
                'absolute rounded-full',
                particle.color,
                'animate-confetti'
              )}
              style={{
                left: `${particle.x}%`,
                top: '-10px',
                width: particle.size,
                height: particle.size,
                animationDelay: `${particle.delay}ms`,
                animationDuration: `${particle.duration}ms`,
              }}
            />
          ))}
        </div>
      )}

      {/* Celebration Icon */}
      <div
        className={cn(
          'relative flex size-20 items-center justify-center',
          'transition-all duration-500',
          isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-75'
        )}
      >
        {/* Glow ring */}
        <div
          className={cn(
            'absolute inset-0 rounded-full',
            'bg-gradient-to-br from-amber-200 to-orange-200',
            'animate-pulse opacity-50 blur-lg'
          )}
        />
        {/* Icon container */}
        <div
          className={cn(
            'relative flex size-16 items-center justify-center rounded-full',
            'bg-gradient-to-br from-amber-400 to-orange-500',
            'shadow-lg shadow-orange-200/50'
          )}
        >
          <Sparkles className="size-8 text-white" />
        </div>
      </div>

      {/* Headline */}
      <h2
        className={cn(
          'mt-6 text-3xl font-bold tracking-tight text-foreground',
          'transition-all duration-500 delay-100',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        Inbox Zero!
      </h2>

      {/* Subtext */}
      <p
        className={cn(
          'mt-2 text-muted-foreground',
          'transition-all duration-500 delay-150',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        You've processed all {stats.processedToday} items today.
      </p>

      {/* Stats Card */}
      <div
        className={cn(
          'mt-8 w-full max-w-xs rounded-xl border border-border/60 bg-card/80 p-4',
          'shadow-sm',
          'transition-all duration-500 delay-200',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        )}
      >
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Timer className="size-4" />
          Today's Stats
        </div>

        <div className="space-y-1">
          <StatItem
            icon={FolderCheck}
            label="items filed"
            value={stats.filedToday}
            color="bg-emerald-500"
            delay={300}
            isVisible={isVisible}
          />
          <StatItem
            icon={Trash2}
            label="items deleted"
            value={stats.deletedToday}
            color="bg-rose-500"
            delay={350}
            isVisible={isVisible}
          />
          <StatItem
            icon={Clock}
            label="items snoozed"
            value={stats.snoozedToday}
            color="bg-violet-500"
            delay={400}
            isVisible={isVisible}
          />
        </div>

        {/* Average time */}
        {stats.avgProcessingTime && (
          <div
            className={cn(
              'mt-4 flex items-center justify-between border-t border-border/50 pt-3',
              'transition-all duration-300 delay-450',
              isVisible ? 'opacity-100' : 'opacity-0'
            )}
          >
            <span className="text-xs text-muted-foreground">Avg time per item</span>
            <span className="text-sm font-medium tabular-nums text-foreground">
              {formatAvgTime(stats.avgProcessingTime)}
            </span>
          </div>
        )}
      </div>

      {/* Reassurance */}
      <p
        className={cn(
          'mt-6 text-sm text-muted-foreground/70',
          'transition-all duration-500 delay-500',
          isVisible ? 'opacity-100' : 'opacity-0'
        )}
      >
        New items will appear here automatically.
      </p>

      {/* CTA */}
      <Button
        variant="outline"
        onClick={onCapture}
        className={cn(
          'mt-4 gap-2',
          'transition-all duration-500 delay-550',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        <Plus className="size-4" />
        Capture Something New
      </Button>

      {/* CSS for confetti animation */}
      <style>{`
        @keyframes confetti {
          0% {
            transform: translateY(0) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(400px) rotate(720deg);
            opacity: 0;
          }
        }
        .animate-confetti {
          animation: confetti linear forwards;
        }
      `}</style>
    </div>
  )
}
