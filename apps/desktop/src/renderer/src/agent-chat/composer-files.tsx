import { type DragEvent, useRef, useState } from 'react'

import { useT } from '@memry/i18n/renderer'

import { FileText, Paperclip, X } from '@/lib/icons'
import { formatBytes } from '@/lib/format'

import {
  PROMPT_FILE_EXTENSIONS,
  type PromptFile,
  type PromptFileRefusal,
  readPromptFile
} from './memry-file-block'

const REFUSAL_KEYS = {
  unsupported_type: 'agentChat.composer.files.refused.unsupportedType',
  not_text: 'agentChat.composer.files.refused.notText',
  too_large: 'agentChat.composer.files.refused.tooLarge'
} as const satisfies Record<PromptFileRefusal, string>

interface Refusal {
  name: string
  reason: PromptFileRefusal
}

export interface ComposerFiles {
  files: PromptFile[]
  refusal: Refusal | null
  add: (incoming: Iterable<File>) => Promise<void>
  remove: (index: number) => void
  clear: () => void
  dropHandlers: {
    onDragOver: (event: DragEvent) => void
    onDropCapture: (event: DragEvent) => void
  }
}

const hasFiles = (event: DragEvent): boolean =>
  event.dataTransfer?.types?.includes('Files') ?? false

export function useComposerFiles(disabled: boolean): ComposerFiles {
  const [files, setFiles] = useState<PromptFile[]>([])
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  // `add` awaits file reads, so it measures the running total from here, not a stale render.
  const filesRef = useRef<PromptFile[]>([])
  const replaceFiles = (next: PromptFile[]): void => {
    filesRef.current = next
    setFiles(next)
  }

  const add = async (incoming: Iterable<File>): Promise<void> => {
    const accepted = [...filesRef.current]
    let lastRefusal: Refusal | null = null
    for (const file of incoming) {
      const used = accepted.reduce((total, current) => total + current.bytes, 0)
      const result = await readPromptFile(file, used)
      if (result.ok) accepted.push(result.file)
      else lastRefusal = { name: file.name, reason: result.reason }
    }
    replaceFiles(accepted)
    setRefusal(lastRefusal)
  }

  return {
    files,
    refusal,
    add,
    remove: (index) => {
      replaceFiles(filesRef.current.filter((_, position) => position !== index))
      setRefusal(null)
    },
    clear: () => {
      replaceFiles([])
      setRefusal(null)
    },
    dropHandlers: {
      onDragOver: (event) => {
        if (disabled || !hasFiles(event)) return
        event.preventDefault()
      },
      // Capture phase, so the prompt editor never sees a dropped file.
      onDropCapture: (event) => {
        if (disabled || !event.dataTransfer?.files?.length) return
        event.preventDefault()
        event.stopPropagation()
        void add(Array.from(event.dataTransfer.files))
      }
    }
  }
}

export function AttachFileButton({
  disabled,
  onFiles
}: {
  disabled: boolean
  onFiles: (files: File[]) => void
}): React.JSX.Element {
  const { t } = useT('common')
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={PROMPT_FILE_EXTENSIONS.join(',')}
        data-testid="agent-file-input"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (picked.length > 0) onFiles(picked)
        }}
      />
      <button
        type="button"
        aria-label={t('agentChat.composer.files.attach')}
        title={t('agentChat.composer.files.attach')}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Paperclip className="size-3.5" aria-hidden="true" />
      </button>
    </>
  )
}

export function ComposerFileChips({
  files,
  refusal,
  onRemove
}: Pick<ComposerFiles, 'files' | 'refusal'> & {
  onRemove: (index: number) => void
}): React.JSX.Element | null {
  const { t } = useT('common')
  if (files.length === 0 && !refusal) return null
  return (
    <div className="flex flex-col gap-1.5">
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/50 py-0.5 ps-1.5 pe-0.5 text-xs"
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 truncate font-medium">{file.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatBytes(file.bytes)}
              </span>
              <button
                type="button"
                aria-label={t('agentChat.composer.removeAttachment', { label: file.name })}
                onClick={() => onRemove(index)}
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {refusal && (
        <p role="alert" className="text-xs text-destructive">
          {t(REFUSAL_KEYS[refusal.reason], { name: refusal.name })}
        </p>
      )}
    </div>
  )
}
