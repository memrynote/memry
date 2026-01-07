import { Globe, FileText, Mic } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CaptureMethod {
  icon: React.ReactNode
  label: string
  sublabel?: string
}

const captureMethods: CaptureMethod[] = [
  {
    icon: <Globe className="size-6" aria-hidden="true" />,
    label: 'Browser',
    sublabel: 'Extension'
  },
  {
    icon: <FileText className="size-6" aria-hidden="true" />,
    label: 'Quick Note'
  },
  {
    icon: <Mic className="size-6" aria-hidden="true" />,
    label: 'Voice Memo'
  }
]

interface CaptureMethodCardProps {
  method: CaptureMethod
  delay: number
}

const CaptureMethodCard = ({ method, delay }: CaptureMethodCardProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 p-4',
        'empty-state-entrance',
        'motion-reduce:animate-none'
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="text-muted-foreground">{method.icon}</div>
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">{method.label}</p>
        {method.sublabel && <p className="text-xs text-muted-foreground">{method.sublabel}</p>}
      </div>
    </div>
  )
}

/**
 * Horizontal grid showing the different ways to capture content
 * Browser Extension, Quick Note, Voice Memo
 */
const CaptureMethodsGrid = (): React.JSX.Element => {
  return (
    <div className="w-full max-w-md">
      <p
        className={cn(
          'text-xs font-medium text-muted-foreground text-center mb-4',
          'empty-state-entrance stagger-delay-3',
          'motion-reduce:animate-none'
        )}
      >
        Ways to capture:
      </p>
      <div className="flex items-start justify-center gap-8">
        {captureMethods.map((method, index) => (
          <CaptureMethodCard key={method.label} method={method} delay={350 + index * 100} />
        ))}
      </div>
    </div>
  )
}

export { CaptureMethodsGrid }
