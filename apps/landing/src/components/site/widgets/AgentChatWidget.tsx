import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ChevronDown, FileText, Globe, Send, Shield, Sparkles, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

/* Interactive replica of the desktop Agent Chat — canned sample data, no live AI. */

const SOURCE_BLUE = '#81B4E5' // hardcoded memry-link blue, same literal as the desktop app

interface ChatSource {
  title: string
}

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  source?: ChatSource
  complete: boolean
  appended: boolean
}

interface CannedReply {
  text: string
  source: ChatSource
}

const CANNED_REPLIES: CannedReply[] = [
  {
    text: 'You wrote about it on Thu, Jul 9 — three neighborhoods to stay in (Alfama, Baixa and Príncipe Real), plus a reminder to book the fado night early because it sold out last time.',
    source: { title: 'Trip planning — Lisbon' }
  },
  {
    text: 'Two books are still unread on your list: “The Design of Everyday Things” and the novel your sister recommended in June. You marked both “start before the trip.”',
    source: { title: 'Reading list 2026' }
  }
]

const SEED_MESSAGES: ChatMessage[] = [
  {
    id: 1,
    role: 'user',
    text: 'Where did I put the ideas for mom’s birthday?',
    complete: true,
    appended: false
  },
  {
    id: 2,
    role: 'assistant',
    text: 'They’re in your gift-ideas note from last week — a ceramics class you’d take together, and the linen apron from the market in İzmir.',
    source: { title: 'Gift ideas — Mom’s 60th' },
    complete: true,
    appended: false
  }
]

const THINK_MS = 500
const TYPE_MS = 1200
const TYPE_TICKS = 12

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1" aria-label="Assistant is thinking">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-2 w-2 animate-pulse rounded-full bg-ink/60"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  )
}

interface SourcesDisclosureProps {
  source: ChatSource
  open: boolean
  animate: boolean
  onToggle: () => void
}

function SourcesDisclosure({ source, open, animate, onToggle }: SourcesDisclosureProps) {
  return (
    <div className="mt-1 px-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{ color: SOURCE_BLUE }}
        className="inline-flex items-center gap-1 rounded text-xs font-medium decoration-dotted underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
      >
        Used 1 source
        <ChevronDown
          aria-hidden
          className={cn('h-4 w-4 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>
      {open && (
        <motion.div
          initial={animate ? { opacity: 0, y: -8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="mt-3 flex flex-col gap-2"
        >
          <span
            style={{ color: SOURCE_BLUE }}
            className="inline-flex items-center gap-2 text-xs font-medium"
          >
            <FileText aria-hidden className="h-3.5 w-3.5 shrink-0" />
            {source.title}
          </span>
        </motion.div>
      )}
    </div>
  )
}

export interface AgentChatWidgetProps {
  className?: string
}

/**
 * Interactive replica of the desktop Agent Chat panel: quiet user bubbles, document-style
 * assistant replies with a "Used 1 source" disclosure, and the real composer anatomy
 * (provider pill, permissions circle, model pill, ink send/stop circle). Sending appends
 * your message, then a canned reply "types" in over ~1.2s. Sample data only — never live AI.
 */
export function AgentChatWidget({ className }: AgentChatWidgetProps) {
  const prefersReducedMotion = useReducedMotion()
  const [messages, setMessages] = useState<ChatMessage[]>(SEED_MESSAGES)
  const [input, setInput] = useState('')
  const [isReplying, setIsReplying] = useState(false)
  const [webSearch, setWebSearch] = useState(false)
  const [openSources, setOpenSources] = useState<Record<number, boolean>>({})

  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const nextIdRef = useRef(3)
  const replyIndexRef = useRef(0)
  const thinkTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const typeTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const activeReplyRef = useRef<{ id: number; reply: CannedReply } | null>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight // instant, like the app — no smooth scroll
  }, [messages])

  useEffect(() => {
    return () => {
      clearTimeout(thinkTimerRef.current)
      clearInterval(typeTimerRef.current)
    }
  }, [])

  const completeReply = (id: number, reply: CannedReply) => {
    clearTimeout(thinkTimerRef.current)
    clearInterval(typeTimerRef.current)
    activeReplyRef.current = null
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, text: reply.text, complete: true } : m))
    )
    setIsReplying(false)
  }

  const stopReply = () => {
    const active = activeReplyRef.current
    if (active) completeReply(active.id, active.reply)
  }

  const startReply = () => {
    const reply = CANNED_REPLIES[replyIndexRef.current % CANNED_REPLIES.length]
    replyIndexRef.current += 1
    const id = nextIdRef.current++
    activeReplyRef.current = { id, reply }
    setMessages((prev) => [
      ...prev,
      { id, role: 'assistant', text: '', source: reply.source, complete: false, appended: true }
    ])

    if (prefersReducedMotion) {
      completeReply(id, reply)
      return
    }

    setIsReplying(true)
    thinkTimerRef.current = setTimeout(() => {
      const words = reply.text.split(' ')
      const step = Math.max(1, Math.ceil(words.length / TYPE_TICKS))
      let shown = 0
      typeTimerRef.current = setInterval(() => {
        shown += step
        if (shown >= words.length) {
          completeReply(id, reply)
        } else {
          const text = words.slice(0, shown).join(' ')
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)))
        }
      }, TYPE_MS / TYPE_TICKS)
    }, THINK_MS)
  }

  const sendMessage = () => {
    const text = input.trim()
    if (!text || isReplying) return
    setInput('')
    const id = nextIdRef.current++
    setMessages((prev) => [...prev, { id, role: 'user', text, complete: true, appended: true }])
    startReply()
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    sendMessage()
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && isReplying) {
      event.preventDefault()
      stopReply()
    }
  }

  const focusComposer = (event: ReactPointerEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement
    if (!target.closest('button')) inputRef.current?.focus()
  }

  const canSend = input.trim().length > 0

  return (
    <div
      className={cn(
        'flex w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-paper-alt',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
        <p className="truncate text-sm font-semibold text-ink">Agent</p>
        <span className="ms-auto shrink-0 text-[10px] text-muted/70">Sample conversation</span>
      </div>

      {/* Message stream */}
      <div
        ref={logRef}
        role="log"
        aria-label="Agent conversation"
        className="flex h-56 flex-col gap-3 overflow-y-auto px-2 py-3 sm:h-64"
      >
        {messages.map((message) =>
          message.role === 'user' ? (
            <motion.div
              key={message.id}
              initial={message.appended && !prefersReducedMotion ? { opacity: 0, y: 6 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="ms-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-paper-deep px-3 py-2 text-sm text-ink"
            >
              {message.text}
            </motion.div>
          ) : (
            <div key={message.id} className="w-full">
              {!message.complete && message.text === '' ? (
                <ThinkingDots />
              ) : (
                <p className="px-3 text-sm leading-6 text-ink">{message.text}</p>
              )}
              {message.complete && message.source && (
                <SourcesDisclosure
                  source={message.source}
                  open={Boolean(openSources[message.id])}
                  animate={!prefersReducedMotion}
                  onToggle={() =>
                    setOpenSources((prev) => ({ ...prev, [message.id]: !prev[message.id] }))
                  }
                />
              )}
            </div>
          )
        )}
      </div>

      {/* Composer */}
      <div className="p-2">
        <form
          onSubmit={handleSubmit}
          onPointerDown={focusComposer}
          className="flex min-h-[120px] cursor-text flex-col rounded-2xl border border-border bg-card shadow-elevated transition-shadow focus-within:ring-2 focus-within:ring-terracotta/40"
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Ask memrynote anything. @ to use mention file"
            aria-label="Message the agent"
            className="w-full bg-transparent p-3 text-[16px] text-ink outline-none placeholder:text-sm placeholder:text-muted"
          />

          {/* Bottom toolbar */}
          <div className="mt-auto flex min-h-[40px] items-center gap-2 p-2 pb-1.5">
            <span
              aria-hidden
              className="flex h-8 items-center gap-1.5 rounded-full px-1.5 text-xs text-muted"
            >
              <Sparkles className="h-4 w-4" />
              Claude
              <ChevronDown className="h-3 w-3" />
            </span>

            <button
              type="button"
              onClick={() => setWebSearch((on) => !on)}
              aria-pressed={webSearch}
              aria-label="Toggle web search permission"
              className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper-deep text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
            >
              <Shield aria-hidden className="h-4 w-4" />
              {webSearch && (
                <span className="absolute -end-0.5 -top-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-card ring-1 ring-border">
                  <Globe aria-hidden className="h-2 w-2 text-muted" />
                </span>
              )}
            </button>

            <span
              aria-hidden
              className="flex h-8 max-w-36 items-center gap-1 truncate rounded-full bg-paper-deep px-2 text-xs text-muted"
            >
              <span className="truncate">Opus · Extra high</span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </span>

            {isReplying ? (
              <button
                key="stop"
                type="button"
                onClick={stopReply}
                aria-label="Stop reply"
                className="ms-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-ink-inverted transition-colors hover:bg-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
              >
                <Square aria-hidden className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                key="send"
                type="submit"
                onPointerDown={(event) => {
                  // Fire on pointerdown — a mid-click disabled swap would swallow the click
                  if (event.button === 0) {
                    event.preventDefault()
                    sendMessage()
                  }
                }}
                disabled={!canSend}
                aria-label="Send message"
                className="ms-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-ink-inverted transition-colors hover:bg-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send aria-hidden className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
