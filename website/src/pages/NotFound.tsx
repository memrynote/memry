import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Home } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { Button } from '@/components/ui/button'

export function NotFound() {
  return (
    <main className="pt-24">
      <Container>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
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
