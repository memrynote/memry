import { useState } from 'react'
import { AIAgentComposer } from './AIAgentComposer'
import type { ComposerData } from './types'

export function AIAgentTab() {
  const [isStreaming, setIsStreaming] = useState(false)
  const [messages, setMessages] = useState<
    Array<{
      id: string
      role: 'user' | 'assistant'
      content: string
      attachments?: ComposerData['attachments']
    }>
  >([])

  const handleSend = (data: ComposerData) => {
    // Add user message to conversation
    const userMessage = {
      id: `msg-${Date.now()}`,
      role: 'user' as const,
      content: data.message,
      attachments: data.attachments
    }

    setMessages((prev) => [...prev, userMessage])

    // Simulate streaming (UI only - backend integration later)
    setIsStreaming(true)

    // Simulate AI response after a brief delay
    setTimeout(() => {
      const assistantMessage = {
        id: `msg-${Date.now()}`,
        role: 'assistant' as const,
        content: `This is a simulated response. In a future update, I will process your message: "${data.message || 'No text provided'}"\n\nOptions selected:\n- Model: ${data.options.model}\n- Web Search: ${data.options.webSearch ? 'Enabled' : 'Disabled'}\n- Thinking Mode: ${data.options.thinkingMode ? 'Enabled' : 'Disabled'}\n- Attachments: ${data.attachments.length > 0 ? data.attachments.map((a) => a.name).join(', ') : 'None'}`
      }

      setMessages((prev) => [...prev, assistantMessage])
      setIsStreaming(false)
    }, 1500)
  }

  const handleCancel = () => {
    setIsStreaming(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <div className="text-stone-400 mb-2">
              <svg
                className="h-12 w-12 mx-auto"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                />
              </svg>
            </div>
            <h3 className="text-sm font-medium text-stone-900 mb-1">Start a conversation</h3>
            <p className="text-xs text-stone-500 max-w-[200px]">
              Ask questions about this note or get AI-powered suggestions.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                  msg.role === 'user'
                    ? 'bg-tint text-tint-foreground'
                    : 'bg-stone-100 text-stone-900'
                }`}
              >
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mb-2 text-xs opacity-75">
                    Attachments: {msg.attachments.map((a) => a.name).join(', ')}
                  </div>
                )}
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          ))
        )}

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex justify-start">
            <div className="bg-stone-100 rounded-2xl px-4 py-2.5">
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 bg-stone-400 rounded-full animate-bounce" />
                <span
                  className="h-2 w-2 bg-stone-400 rounded-full animate-bounce"
                  style={{ animationDelay: '0.1s' }}
                />
                <span
                  className="h-2 w-2 bg-stone-400 rounded-full animate-bounce"
                  style={{ animationDelay: '0.2s' }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="p-4 border-t border-stone-200/60">
        <AIAgentComposer onSend={handleSend} onCancel={handleCancel} isStreaming={isStreaming} />
      </div>
    </div>
  )
}
