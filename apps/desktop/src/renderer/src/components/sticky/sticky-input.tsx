import { useEffect } from 'react'
import { useT } from '@memry/i18n/renderer'

const MAX_TEXTAREA_HEIGHT = 240

interface StickyInputProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

/** The sticky's writing area; grows with its text up to a cap, then scrolls. */
export function StickyInput({
  value,
  onChange,
  placeholder,
  disabled,
  textareaRef
}: StickyInputProps): React.JSX.Element {
  const { t } = useT('inbox')

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- value re-triggers the textarea auto-grow
  }, [value, textareaRef])

  return (
    <div className="px-4 py-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
        aria-label={t('sticky.inputLabel')}
        className="min-h-[66px] max-h-[240px] w-full resize-none bg-transparent font-sans text-[15px]/[22px] text-inherit placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-50"
      />
    </div>
  )
}
