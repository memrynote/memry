import { useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface WaitlistFormProps {
  variant?: 'hero' | 'inline' | 'centered'
  className?: string
}

export function WaitlistForm({ variant = 'hero', className }: WaitlistFormProps) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email || status === 'loading') return

    setStatus('loading')
    setErrorMessage('')

    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email })
      })

      const data = await response.json()

      if (response.ok && data.success) {
        setStatus('success')
        setEmail('')
      } else {
        setErrorMessage(data.error || 'Something went wrong')
        setStatus('error')
      }
    } catch {
      setErrorMessage('Network error. Please try again.')
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className={cn(
          'flex items-center gap-3 p-4 rounded-lg bg-sage/10 border border-sage/20 text-sage-dark',
          className
        )}
      >
        <div className="w-8 h-8 rounded-full bg-sage/20 flex items-center justify-center shrink-0">
          <Check className="w-4 h-4 text-sage" />
        </div>
        <div>
          <p className="font-serif font-medium text-ink">You're on the list!</p>
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
      <div className="flex-1 relative">
        <Input
          type="email"
          placeholder="Enter your email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            if (status === 'error') setStatus('idle')
          }}
          required
          disabled={status === 'loading'}
          className={cn(
            'w-full bg-white/50 backdrop-blur-sm focus:bg-white',
            variant === 'hero' && 'h-12 text-base shadow-sm',
            variant === 'centered' && 'h-12 text-base',
            status === 'error' && 'border-red-500 focus:ring-red-500'
          )}
        />
        {status === 'error' && (
          <p className="text-sm text-red-600 mt-2 absolute -bottom-6 left-0">{errorMessage}</p>
        )}
      </div>
      <Button
        type="submit"
        disabled={status === 'loading'}
        className={cn(
          'gap-2 font-medium shrink-0',
          variant === 'hero' && 'h-12 px-8 shadow-sm',
          variant === 'centered' && 'h-12 px-8'
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
    </form>
  )
}
