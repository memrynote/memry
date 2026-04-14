import type { HintTarget } from '@/contexts/hint-mode'

interface HintBadgeProps {
  hint: HintTarget
  typedChars: string
}

export const HintBadge = ({ hint, typedChars }: HintBadgeProps): React.JSX.Element => {
  const isMatching = hint.label.startsWith(typedChars)
  const matchedLength = typedChars.length

  return (
    <span
      style={{
        position: 'fixed',
        top: hint.rect.top - 6,
        left: hint.rect.left - 6,
        zIndex: 2147483647,
        background: '#f59e0b',
        color: '#000',
        fontSize: '11px',
        fontWeight: 700,
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
        padding: '1px 5px',
        borderRadius: '3px',
        lineHeight: 1.3,
        letterSpacing: '0.5px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        pointerEvents: 'none',
        opacity: isMatching ? 1 : 0.3,
        transition: 'opacity 100ms ease'
      }}
    >
      {hint.label.split('').map((char, i) => (
        <span key={i} style={{ opacity: i < matchedLength && isMatching ? 0.4 : 1 }}>
          {char}
        </span>
      ))}
    </span>
  )
}
