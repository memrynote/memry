import { useEffect, useRef, useState } from 'react'
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'

/*
 * Live-feeling vignette of the MemryNote CLI — a light "paper terminal" that auto-plays a
 * looping demo session, then hands the prompt to you the moment you type. Sample data only,
 * never a real shell: `respond()` maps a handful of subcommands to canned output. Colors are
 * fixed literals (a terminal is a terminal), the same way AgentChatWidget hardcodes its
 * source-blue — the paper/slate palette mirrors the reference craft-terminal look.
 */

const MONO = 'ui-monospace, "SF Mono", "Cascadia Code", monospace'

const TERM = {
  chrome: '#f5f2ed',
  chromeBorder: '#e8e3db',
  body: '#faf8f5',
  ink: '#3d3832',
  muted: '#9c958b',
  slate: '#6b8aad', // prompt caret + blinking cursor
  accent: '#c15a2b', // the `memrynote` binary name — terracotta, darkened for paper
  composerBg: '#fbf9f4',
  composerBorder: '#b8c7d8',
  title: '#8c8578'
} as const

const DOT_BG = 'rgba(240,240,240,0.5)'
const DOT_BORDER = 'rgba(0,0,0,0.08)'
const WIDGET_SHADOW =
  '0 0 0 1px rgba(0,0,0,0.06), 0 14px 32px rgba(0,0,0,0.08), 0 28px 70px rgba(0,0,0,0.05)'
const COMPOSER_SHADOW = 'inset 0 1px 0 rgba(255,255,255,0.65), 0 0 0 2px rgba(107,138,173,0.08)'

type Line = { id: number; kind: 'cmd' | 'out'; text: string }

// Scrollback is capped with slice(-MAX_LINES), so a line's index shifts as old lines drop.
// Ids keep each line's React identity stable across that shift.
let lineSeq = 0
const nextLineId = () => lineSeq++

// The auto-play loop — types the whole set, then clears and starts over, until you take
// over the prompt.
const DEMO: { cmd: string; out: string }[] = [
  { cmd: 'task add "Review PR #742" --due today', out: 'Added task · Review PR #742 · due today' },
  { cmd: 'note new "Standup" --tag work', out: 'Created  work/Standup.md' },
  {
    cmd: 'search "istanbul weekend"',
    out: '3 notes · Istanbul Weekend · Packing List · Ferry plan'
  },
  { cmd: 'today', out: '3 tasks due · 6 events · journal started' },
  { cmd: 'link "Atomic Habits" "Deep Work"', out: 'Linked · 2 notes now connected' },
  { cmd: 'sync', out: 'Synced 12 changes · vault up to date' }
]

// Steady session shown when motion is reduced — the same commands, no typing animation.
const SEED: Line[] = DEMO.flatMap((d) => [
  { id: nextLineId(), kind: 'cmd' as const, text: d.cmd },
  { id: nextLineId(), kind: 'out' as const, text: d.out }
])

// Timings run at 5× — a brisk demo that types, answers, and loops fast.
const CHAR_MS = 8 // per-keystroke pace while auto-typing
const HOLD_TYPED = 92 // pause once a command finishes typing, before it "runs"
const HOLD_OUT = 260 // pause on the output before the next command starts
const HOLD_LOOP = 440 // linger on the finished set before wiping and restarting
const START_MS = 140 // beat before the first keystroke
const MAX_LINES = 20 // cap scrollback so the loop never grows unbounded

/** Map a typed subcommand to canned output. Never executes anything. */
function respond(raw: string): string {
  const cmd = raw.trim()
  const quoted = cmd.match(/"([^"]+)"/)?.[1]
  if (cmd === 'help') return 'commands · task add · note new · search · sync'
  if (cmd.startsWith('task add')) return `Added task${quoted ? ` · ${quoted}` : ''}`
  if (cmd.startsWith('note new')) {
    const slug = (quoted ?? 'Untitled').replace(/\s+/g, '-')
    return `Created  ${slug}.md`
  }
  if (cmd.startsWith('search')) return `${quoted ? `matches for “${quoted}” · ` : ''}3 notes`
  if (cmd === 'sync') return 'Synced · vault up to date'
  return `memrynote: ${cmd.split(' ')[0] || 'command'} not found · try help`
}

/** One typed command, `❯ memrynote <args>`, aligned in a 14px prompt gutter. */
function CommandLine({ text }: { text: string }) {
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-1.5">
      <span
        aria-hidden
        className="flex h-[20px] select-none items-center justify-center leading-none"
        style={{ color: TERM.slate }}
      >
        ❯
      </span>
      <span className="whitespace-pre-wrap break-words" style={{ color: TERM.ink }}>
        <span style={{ color: TERM.accent }}>memrynote</span> {text}
      </span>
    </div>
  )
}

export interface CliWidgetProps {
  className?: string
}

export function CliWidget({ className }: CliWidgetProps) {
  const prefersReducedMotion = useReducedMotion()
  const [history, setHistory] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [live, setLive] = useState(true) // true while the auto-play owns the prompt
  const [focused, setFocused] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const demoRef = useRef(0)
  const charRef = useRef(0)

  // Keep the newest line in view, like a real terminal (instant, never smooth).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history, input])

  // The auto-play loop. Tears down on unmount or the moment `live` flips to false.
  useEffect(() => {
    if (!live) return
    let cancelled = false

    // Reduced motion: no typing — settle straight to a finished session (deferred so the
    // first render still matches SSR), and leave the prompt yours.
    if (prefersReducedMotion) {
      timerRef.current = setTimeout(() => {
        if (cancelled) return
        setHistory(SEED)
        setLive(false)
      }, 0)
      return () => {
        cancelled = true
        clearTimeout(timerRef.current)
      }
    }

    const type = () => {
      if (cancelled) return
      const { cmd } = DEMO[demoRef.current]
      if (charRef.current <= cmd.length) {
        setInput(cmd.slice(0, charRef.current))
        charRef.current += 1
        timerRef.current = setTimeout(type, CHAR_MS + Math.random() * 9)
      } else {
        timerRef.current = setTimeout(run, HOLD_TYPED)
      }
    }

    const run = () => {
      if (cancelled) return
      const { cmd, out } = DEMO[demoRef.current]
      const wasLast = demoRef.current === DEMO.length - 1
      setInput('')
      const cmdLine: Line = { id: nextLineId(), kind: 'cmd', text: cmd }
      const outLine: Line = { id: nextLineId(), kind: 'out', text: out }
      setHistory((h) => [...h, cmdLine, outLine].slice(-MAX_LINES))
      demoRef.current = (demoRef.current + 1) % DEMO.length
      charRef.current = 0
      if (wasLast) {
        // Whole set done — linger on it, wipe the screen, then start the loop fresh.
        timerRef.current = setTimeout(() => {
          if (cancelled) return
          setHistory([])
          timerRef.current = setTimeout(type, START_MS)
        }, HOLD_LOOP)
      } else {
        timerRef.current = setTimeout(type, HOLD_OUT)
      }
    }

    timerRef.current = setTimeout(type, START_MS)
    return () => {
      cancelled = true
      clearTimeout(timerRef.current)
    }
  }, [prefersReducedMotion, live])

  const takeOver = () => {
    if (!live) return
    clearTimeout(timerRef.current)
    setLive(false) // triggers the auto-play effect cleanup
    setInput('') // drop whatever the demo was half-typing
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cmd = input.trim()
    if (!cmd) return
    const cmdLine: Line = { id: nextLineId(), kind: 'cmd', text: cmd }
    const outLine: Line = { id: nextLineId(), kind: 'out', text: respond(cmd) }
    setHistory((h) => [...h, cmdLine, outLine].slice(-MAX_LINES))
    setInput('')
  }

  const focusPrompt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!target.closest('input')) inputRef.current?.focus()
  }

  const showFakeCursor = !focused

  return (
    <div
      aria-label="MemryNote CLI: try a command"
      onPointerDown={focusPrompt}
      className={cn(
        'flex h-full min-h-[400px] w-full cursor-text flex-col overflow-hidden rounded-[12px]',
        className
      )}
      style={{ boxShadow: WIDGET_SHADOW }}
    >
      {/* Window chrome — translucent dots leading, title centered */}
      <div
        className="relative flex h-9 shrink-0 items-center border-b px-3"
        style={{ backgroundColor: TERM.chrome, borderColor: TERM.chromeBorder }}
      >
        <div aria-hidden className="flex items-center gap-2">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: DOT_BG, border: `0.5px solid ${DOT_BORDER}` }}
            />
          ))}
        </div>
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[12px] font-medium"
          style={{ color: TERM.title }}
        >
          memrynote · zsh
        </span>
      </div>

      {/* Scrollback — grows with the session */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        style={{ backgroundColor: TERM.body, fontFamily: MONO, fontSize: 11.5, lineHeight: 1.65 }}
      >
        {history.map((line) =>
          line.kind === 'cmd' ? (
            <CommandLine key={line.id} text={line.text} />
          ) : (
            <div key={line.id} className="pl-[22px]" style={{ color: TERM.muted }}>
              → {line.text}
            </div>
          )
        )}
      </div>

      {/* Composer — the demo types here, then it's yours */}
      <div className="shrink-0 px-3 pt-2 pb-3" style={{ backgroundColor: TERM.body }}>
        <form onSubmit={handleSubmit}>
          <div
            className="grid min-h-[34px] grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-[3px] border px-3 py-2"
            style={{
              backgroundColor: TERM.composerBg,
              borderColor: TERM.composerBorder,
              boxShadow: COMPOSER_SHADOW,
              fontFamily: MONO,
              fontSize: 11.5,
              lineHeight: 1.5
            }}
          >
            <span
              aria-hidden
              className="h-[20px] select-none leading-[20px]"
              style={{ color: TERM.slate }}
            >
              ❯
            </span>
            <span className="flex min-w-0 items-center leading-[20px]" style={{ color: TERM.ink }}>
              <span aria-hidden style={{ color: TERM.accent }}>
                memrynote
              </span>
              &nbsp;
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(event) => {
                  takeOver()
                  setInput(event.target.value)
                }}
                onFocus={() => {
                  setFocused(true)
                  takeOver()
                }}
                onBlur={() => setFocused(false)}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                aria-label="Type a memrynote command"
                className="min-w-0 bg-transparent outline-none"
                style={{
                  width: `${Math.max(input.length, 1) + 1}ch`,
                  color: TERM.ink,
                  fontFamily: MONO
                }}
              />
              {showFakeCursor && (
                <span
                  aria-hidden
                  className="ml-0.5 inline-block h-[13px] w-[6px] translate-y-[2px] animate-blink"
                  style={{ backgroundColor: TERM.slate }}
                />
              )}
            </span>
          </div>
        </form>
      </div>
    </div>
  )
}
