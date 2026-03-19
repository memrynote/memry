import { useState, useRef, useCallback, type KeyboardEvent, type ChangeEvent } from 'react'
import { Paperclip, Send, Square } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AttachmentList } from './AttachmentList'
import { ModeToggle } from './ModeToggle'
import { ModelSelector } from './ModelSelector'
import type { Attachment, ComposerData } from './types'

interface AIAgentComposerProps {
  onSend: (data: ComposerData) => void
  onCancel: () => void
  isStreaming: boolean
  placeholder?: string
}

export function AIAgentComposer({
  onSend,
  onCancel,
  isStreaming,
  placeholder = 'Ask about this note...'
}: AIAgentComposerProps) {
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [thinkingModeEnabled, setThinkingModeEnabled] = useState(false)
  const [selectedModel, setSelectedModel] = useState('gpt-4o')

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const canSend = message.trim().length > 0 || attachments.length > 0

  const handleSend = useCallback(() => {
    if (!canSend || isStreaming) return

    onSend({
      message: message.trim(),
      attachments,
      options: {
        webSearch: webSearchEnabled,
        thinkingMode: thinkingModeEnabled,
        model: selectedModel
      }
    })

    // Clear message and attachments, but keep mode toggles
    setMessage('')
    setAttachments([])
  }, [
    message,
    attachments,
    webSearchEnabled,
    thinkingModeEnabled,
    selectedModel,
    canSend,
    isStreaming,
    onSend
  ])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter (without shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    // Clear on Escape
    if (e.key === 'Escape') {
      setMessage('')
    }
  }

  const handleTextareaChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value)
    // Auto-grow textarea
    const textarea = e.target
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
  }

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    const newAttachments: Attachment[] = Array.from(files).map((file) => {
      const type = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'doc'
      return {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type,
        name: file.name,
        file
      }
    })

    setAttachments((prev) => [...prev, ...newAttachments])

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const handleUploadClick = () => {
    fileInputRef.current?.click()
  }

  return (
    <div
      className={cn(
        'bg-white border border-stone-200 rounded-2xl',
        'transition-all duration-200',
        'focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/10'
      )}
    >
      {/* Attachment Chips Area */}
      {attachments.length > 0 && (
        <div className="px-4 pt-3">
          <AttachmentList attachments={attachments} onRemove={handleRemoveAttachment} />
        </div>
      )}

      {/* Text Input Area */}
      <div className="px-4 py-3">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isStreaming}
          rows={1}
          className={cn(
            'w-full resize-none bg-transparent',
            'text-sm text-stone-900 placeholder:text-stone-400',
            'focus:outline-none',
            'min-h-[22px] max-h-[120px]',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        />
      </div>

      {/* Toolbar Row */}
      <div className="flex items-center justify-between px-3 pb-3">
        {/* Left Section: Action Buttons */}
        <div className="flex items-center gap-1">
          <TooltipProvider delayDuration={300}>
            {/* Upload Button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleUploadClick}
                  className={cn(
                    'h-8 w-8 rounded-full flex items-center justify-center',
                    'bg-stone-100 hover:bg-stone-200',
                    'transition-colors duration-150',
                    'focus:outline-none focus:ring-1 focus:ring-stone-400 focus:ring-offset-1'
                  )}
                  aria-label="Add attachment"
                >
                  <Paperclip className="h-4 w-4 text-stone-600" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                Add attachment
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx"
            onChange={handleFileSelect}
            className="hidden"
            multiple
          />

          {/* Web Search Toggle */}
          <ModeToggle
            mode="web"
            enabled={webSearchEnabled}
            onToggle={() => setWebSearchEnabled(!webSearchEnabled)}
          />

          {/* Thinking Mode Toggle */}
          <ModeToggle
            mode="thinking"
            enabled={thinkingModeEnabled}
            onToggle={() => setThinkingModeEnabled(!thinkingModeEnabled)}
          />
        </div>

        {/* Center Section: Model Selector */}
        <ModelSelector selectedModel={selectedModel} onModelChange={setSelectedModel} />

        {/* Right Section: Send/Stop Button */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              {isStreaming ? (
                <button
                  type="button"
                  onClick={onCancel}
                  className={cn(
                    'h-9 w-9 rounded-full flex items-center justify-center',
                    'bg-stone-600 text-white',
                    'hover:bg-stone-700',
                    'transition-all duration-150',
                    'hover:scale-105',
                    'focus:outline-none focus:ring-1 focus:ring-stone-400 focus:ring-offset-1'
                  )}
                  aria-label="Stop generation"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSend}
                  className={cn(
                    'h-9 w-9 rounded-full flex items-center justify-center',
                    'transition-all duration-150',
                    'focus:outline-none focus:ring-1 focus:ring-blue-400 focus:ring-offset-1',
                    canSend
                      ? 'bg-blue-600 text-white hover:bg-blue-700 hover:scale-105'
                      : 'bg-stone-200 text-stone-400 cursor-not-allowed'
                  )}
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {isStreaming ? 'Stop generation' : 'Send message'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}
