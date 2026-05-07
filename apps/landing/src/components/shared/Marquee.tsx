const WORDS = ['capture', 'reflect', 'connect', 'execute'] as const
const REPEATS = 8

function MarqueeTrack() {
  return (
    <div className="flex shrink-0 items-center">
      {Array.from({ length: REPEATS }).map((_, ri) =>
        WORDS.map((word) => (
          <span key={`${ri}-${word}`} className="flex items-center">
            <span className="font-mono-accent uppercase tracking-widest text-sm text-muted/40 whitespace-nowrap px-4">
              {word}
            </span>
            <span className="w-1.5 h-1.5 rounded-full bg-terracotta/40 shrink-0" />
          </span>
        ))
      )}
    </div>
  )
}

export function Marquee() {
  return (
    <div className="w-full overflow-hidden py-8 border-y border-border/30">
      <div className="flex animate-marquee" style={{ width: 'max-content' }}>
        <MarqueeTrack />
        <MarqueeTrack />
      </div>
    </div>
  )
}
