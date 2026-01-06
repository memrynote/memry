import { useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FORMSPREE_ID } from '@/lib/constants'

interface WaitlistFormProps {
  variant?: 'hero' | 'inline' | 'centered'
  className?: string
}

export function WaitlistForm({ variant = 'hero', className }: WaitlistFormProps) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email || status === 'loading') return

    setStatus('loading')

    try {
      const response = await fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })

      if (response.ok) {
        setStatus('success')
        setEmail('')
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className={cn(
          'flex items-center gap-3 p-4 rounded-xl bg-success/10 border border-success/20',
          className
        )}
      >
        <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center">
          <Check className="w-5 h-5 text-success" />
        </div>
        <div>
          <p className="font-medium text-foreground">You're on the list!</p>
          <p className="text-sm text-muted">We'll notify you when Memry is ready.</p>
        </div>
      </motion.div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        'flex gap-3',
        variant === 'hero' && 'flex-col sm:flex-row',
        variant === 'inline' && 'flex-row',
        variant === 'centered' && 'flex-col sm:flex-row max-w-md mx-auto',
        className
      )}
    >
      <Input
        type="email"
        placeholder="Enter your email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        disabled={status === 'loading'}
        className={cn(
          'flex-1',
          variant === 'hero' && 'h-12 text-base',
          variant === 'centered' && 'h-12 text-base'
        )}
      />
      <Button
        type="submit"
        disabled={status === 'loading'}
        className={cn(
          'gap-2',
          variant === 'hero' && 'h-12 px-6',
          variant === 'centered' && 'h-12 px-6'
        )}
      >
        {status === 'loading' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            Join Waitlist
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </Button>
      {status === 'error' && (
        <p className="text-sm text-destructive mt-2">Something went wrong. Please try again.</p>
      )}
    </form>
  )
}
