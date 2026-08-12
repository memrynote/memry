import { motion } from 'motion/react'
import { Link } from 'react-router'
import { Container } from '@/components/layout/Container'
import { GITHUB_URL, TWITTER_DEV_URL } from '@/lib/constants'
import { trackLandingEvent } from '@/lib/analytics'
import kaanPhoto from '../../assets/kaan-founder.webp'

export function FounderStory() {
  return (
    <section className="border-t border-border/40 py-24 md:py-28">
      <Container size="md">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="grid items-start gap-10 md:grid-cols-[220px_1fr] md:gap-14"
        >
          <div className="mx-auto w-48 md:mx-0 md:w-full">
            <div className="overflow-hidden rounded-lg border border-border/70 bg-paper-alt shadow-card">
              <img
                src={kaanPhoto}
                alt="Kaan, founder of memrynote"
                className="aspect-[3/4] w-full object-cover"
                loading="lazy"
              />
            </div>
            <p className="mt-3 text-center font-mono-accent text-xs leading-relaxed text-muted/80 md:text-start">
              Yep, that's me. Duck on shoulder.
            </p>
          </div>

          <div>
            <p className="font-mono-accent text-[11px] uppercase tracking-[0.2em] text-terracotta">
              A note from the maker
            </p>
            <h2 className="mt-4 font-serif text-3xl text-ink">Why I'm building MemryNote</h2>

            <div className="mt-6 space-y-4 text-[17px] leading-[1.8] text-muted">
              <p>
                Hi, I'm Kaan, the developer behind memrynote. I started building this because I
                wanted a workspace that feels less like managing software and more like continuing a
                thought.
              </p>
              <p>
                So I'm building the app I wished existed: local-first, privacy by design, with no
                plugin maze and no cloud lock-in.
              </p>
              <p className="font-medium text-ink">
                It's an indie project built with care — not a VC-funded race to monetize your data.
                I ship in the open, and the{' '}
                <Link
                  to="/roadmap"
                  className="text-terracotta underline decoration-terracotta/40 underline-offset-4 transition-colors hover:decoration-terracotta"
                  onClick={() => trackLandingEvent('landing_nav_click', 'founder:roadmap')}
                >
                  roadmap is public
                </Link>
                .
              </p>
              <p className="font-serif text-2xl italic text-ink">— Kaan</p>
            </div>

            <div className="mt-6 flex items-center gap-5">
              <a
                href={TWITTER_DEV_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-terracotta hover:underline"
                onClick={() => trackLandingEvent('landing_external_click', 'founder:twitter')}
              >
                Follow me on 𝕏
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted transition-colors hover:text-ink"
                onClick={() => trackLandingEvent('landing_external_click', 'founder:github')}
              >
                GitHub
              </a>
            </div>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
