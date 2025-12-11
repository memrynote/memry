// AI Agent Composer Types

export interface Attachment {
  id: string
  type: 'pdf' | 'doc' | 'note'
  name: string
  // For files
  file?: File
  // For note references
  noteId?: string
  noteTitle?: string
}

export interface ComposerState {
  message: string
  attachments: Attachment[]
  webSearchEnabled: boolean
  thinkingModeEnabled: boolean
  selectedModel: string
  isStreaming: boolean
}

export interface ComposerData {
  message: string
  attachments: Attachment[]
  options: {
    webSearch: boolean
    thinkingMode: boolean
    model: string
  }
}

export interface ModelOption {
  id: string
  name: string
  description: string
  provider: 'openai' | 'local'
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'gpt-4o', name: 'GPT-4o', description: 'Most capable', provider: 'openai' },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', description: 'Fast & efficient', provider: 'openai' },
  { id: 'gpt-3.5-turbo', name: 'GPT-3.5', description: 'Legacy model', provider: 'openai' },
  { id: 'local-llama', name: 'Llama 3 (Local)', description: 'Runs locally', provider: 'local' },
  { id: 'local-mistral', name: 'Mistral (Local)', description: 'Runs locally', provider: 'local' }
]
