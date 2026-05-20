import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { GITHUB_URL, TWITTER_DEV_URL } from '@/lib/constants'
import { trackLandingEvent } from '@/lib/analytics'
import kaanPhoto from '../../assets/kaan-founder.webp'

export function FounderStory() {
  return (
    <section className="py-24 border-t border-border/40">
      <Container size="md">
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5 }}
          className="relative"
        >
          <div
            className="relative bg-paper-alt ruled-paper rounded-xl p-8 md:p-10 border border-border/40 shadow-card"
            style={{ transform: 'rotate(-0.5deg)' }}
          >
            <svg
              className="absolute top-0 left-0 w-full h-3 -translate-y-full"
              viewBox="0 0 1000 12"
              preserveAspectRatio="none"
              fill="var(--color-paper)"
            >
              <path d="M0,12 Q25,0 50,8 T100,6 T150,10 T200,4 T250,8 T300,6 T350,10 T400,4 T450,8 T500,6 T550,10 T600,4 T650,8 T700,6 T750,10 T800,4 T850,8 T900,6 T950,10 T1000,4 L1000,12 Z" />
            </svg>

            <div className="flex flex-col md:flex-row items-start gap-8 lg:gap-10">
              <div className="mx-auto w-44 shrink-0 sm:w-52 md:mx-0 md:w-52 lg:w-60">
                <div
                  className="overflow-hidden rounded-lg border border-border/70 bg-paper shadow-sm"
                  style={{ transform: 'rotate(1.5deg)' }}
                >
                  <img
                    src={kaanPhoto}
                    alt="Kaan, founder of memrynote"
                    className="aspect-[3/4] w-full object-cover"
                    loading="lazy"
                  />
                </div>
                <p className="mt-3 px-2 text-center text-xs leading-relaxed text-muted/80 font-mono-accent">
                  Yep, that's me. Duck on shoulder.
                </p>
              </div>

              <div className="space-y-4 md:pr-6 lg:pr-12">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="font-serif text-2xl text-ink">Why I'm building memrynote</h3>
                  <span className="text-xs font-mono-accent uppercase tracking-wider text-terracotta bg-terracotta/10 px-2 py-0.5 rounded">
                    Solo dev
                  </span>
                </div>

                <div
                  className="space-y-3 text-muted"
                  style={{ fontSize: '17px', lineHeight: '1.8' }}
                >
                  <p>
                    Hi, I'm Kaan, the developer behind memrynote. I started building this because I
                    wanted a workspace that feels less like managing software and more like
                    continuing a thought.
                  </p>
                  <p>
                    So I'm building the app I wished existed: local-first, privacy by design, with
                    no plugin maze and no cloud lock-in.
                  </p>
                  <p className="text-ink font-medium">
                    memrynote is an indie project built with care, not a VC-funded race to monetize
                    your data.
                  </p>
                </div>

                <div className="flex items-center gap-4 pt-2">
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
                    className="text-sm text-muted hover:text-ink transition-colors"
                    onClick={() => trackLandingEvent('landing_external_click', 'founder:github')}
                  >
                    GitHub
                  </a>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
