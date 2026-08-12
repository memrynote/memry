import { Link } from 'react-router'
import { motion } from 'motion/react'
import { Home } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { Button } from '@/components/ui/button'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

export function NotFound() {
  return (
    <main className="pt-24">
      <Container>
        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
          className="min-h-[60vh] flex flex-col items-center justify-center text-center"
        >
          <span className="text-8xl mb-6">🤔</span>
          <h1 className="font-display text-4xl font-semibold text-foreground mb-4">
            Page not found
          </h1>
          <p className="text-lg text-muted mb-8 max-w-md">
            The page you're looking for doesn't exist or has been moved.
          </p>
          <Button asChild>
            <Link to="/">
              <Home className="w-4 h-4 mr-2" />
              Back to home
            </Link>
          </Button>
        </motion.div>
      </Container>
    </main>
  )
}
