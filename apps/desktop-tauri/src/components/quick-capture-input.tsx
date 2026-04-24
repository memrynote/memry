import { useEffect, useCallback, useRef } from 'react'
import { Plus, Link, Mic, Image, FileIcon, Paperclip, Globe } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { invoke } from '@/lib/ipc/invoke'

type DetectedType = 'note' | 'link' | 'image' | 'voice' | 'pdf' | 'social'

const TYPE_ICONS: Record<DetectedType, typeof Plus> = {
  note: Plus,
  link: Link,
  image: Image,
  voice: Mic,
  pdf: FileIcon,
  social: Globe
}

const MAX_TEXTAREA_HEIGHT = 200

interface QuickCaptureInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onStartRecording: () => void
  onPaste: (e: React.ClipboardEvent) => void
  detectedType: DetectedType
  isCapturing: boolean
  hasAttachment: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

export function QuickCaptureInput({
  value,
  onChange,
  onSubmit,
  onStartRecording,
  onPaste,
  detectedType,
  isCapturing,
  hasAttachment,
  textareaRef
}: QuickCaptureInputProps): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const TypeIcon = TYPE_ICONS[detectedType]

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    const scrollHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)
    textarea.style.height = `${scrollHeight}px`
  }, [value, textareaRef])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void invoke('quick_capture_close')
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        onSubmit()
      }
    },
    [onSubmit]
  )

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const event = new CustomEvent('quick-capture:file-selected', { detail: file })
      window.dispatchEvent(event)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  return (
    <div className="flex items-start gap-2.5 px-4 py-3.5">
      <div className="mt-[3px] shrink-0 text-accent-orange transition-colors duration-150">
        <TypeIcon className="size-[18px]" aria-hidden="true" />
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        placeholder={hasAttachment ? 'Add a note (optional)...' : 'Capture anything...'}
        disabled={isCapturing}
        rows={1}
        className={cn(
          'flex-1 min-h-[24px] max-h-[200px]',
          'resize-none bg-transparent',
          'text-[15px]/[22px] text-foreground font-sans',
          'placeholder:text-foreground/[0.28]',
          'focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50'
        )}
        aria-label="Quick capture input"
      />

      <div className="flex items-center gap-0.5 mt-[2px]">
        <button
          onClick={onStartRecording}
          disabled={isCapturing}
          className={cn(
            'flex items-center justify-center size-8 rounded-lg',
            'bg-foreground/[0.04] text-muted-foreground/40',
            'transition-colors duration-150',
            'hover:text-foreground/60 hover:bg-foreground/[0.07]',
            'disabled:cursor-not-allowed disabled:opacity-30'
          )}
          aria-label="Record voice memo"
        >
          <Mic className="size-[15px]" />
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isCapturing}
          className={cn(
            'flex items-center justify-center size-8 rounded-lg',
            'bg-foreground/[0.04] text-muted-foreground/40',
            'transition-colors duration-150',
            'hover:text-foreground/60 hover:bg-foreground/[0.07]',
            'disabled:cursor-not-allowed disabled:opacity-30'
          )}
          aria-label="Attach file"
        >
          <Paperclip className="size-[15px]" />
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,audio/*,application/pdf"
        onChange={handleFileSelect}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  )
}
