/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BlockNoteEditor } from '@blocknote/core'
import {
  AIExtension,
  aiDocumentFormats,
  type AIMenuSuggestionItem,
  type StreamToolsProvider
} from '@blocknote/xl-ai'
import {
  Sparkles,
  TextCursorInput,
  CheckSquare,
  Languages,
  Eraser,
  Expand,
  Shrink,
  PenLine
} from '@/lib/icons'

type CommandFactory = (editor: BlockNoteEditor<any, any, any>) => AIMenuSuggestionItem

const updateOnly = aiDocumentFormats.html.getStreamToolsProvider({
  defaultStreamTools: { add: false, delete: false, update: true }
})

const addOnly = aiDocumentFormats.html.getStreamToolsProvider({
  defaultStreamTools: { add: true, delete: false, update: false }
})

function makeCommand(
  key: string,
  title: string,
  aliases: string[],
  icon: React.JSX.Element,
  userPrompt: string,
  opts: {
    useSelection?: boolean
    streamToolsProvider?: StreamToolsProvider<any, any>
  } = {}
): CommandFactory {
  return (editor) => ({
    key,
    title,
    aliases,
    icon,
    onItemClick: async () => {
      await editor.getExtension(AIExtension)?.invokeAI({
        userPrompt,
        useSelection: opts.useSelection ?? true,
        streamToolsProvider: opts.streamToolsProvider ?? updateOnly
      })
    },
    size: 'small' as const
  })
}

export const summarize = makeCommand(
  'summarize',
  'Summarize',
  ['summarize', 'tldr', 'brief'],
  <Shrink size={18} />,
  'Summarize the selected text into a concise version, keeping the key points.'
)

export const expand = makeCommand(
  'expand',
  'Expand',
  ['expand', 'elaborate', 'more detail'],
  <Expand size={18} />,
  'Expand on the selected text with more detail and explanation.'
)

export const fixGrammar = makeCommand(
  'fix_grammar',
  'Fix Grammar',
  ['grammar', 'spelling', 'proofread', 'fix'],
  <Eraser size={18} />,
  'Fix all grammar, spelling, and punctuation errors in the selected text. Keep the original meaning and tone.'
)

export const simplify = makeCommand(
  'simplify',
  'Simplify',
  ['simplify', 'simpler', 'plain'],
  <TextCursorInput size={18} />,
  'Simplify the selected text to make it clearer and easier to understand. Use shorter sentences and simpler words.'
)

export const continueWriting = makeCommand(
  'continue_writing',
  'Continue Writing',
  ['continue', 'write more', 'keep going'],
  <PenLine size={18} />,
  'Continue writing from where the text ends. Match the existing tone and style.',
  { useSelection: false, streamToolsProvider: addOnly }
)

export const actionItems = makeCommand(
  'action_items',
  'Extract Action Items',
  ['actions', 'tasks', 'todos', 'checklist'],
  <CheckSquare size={18} />,
  'Extract action items from the selected text and format them as a checklist with checkbox items.',
  { streamToolsProvider: addOnly }
)

export const translate: (language: string) => CommandFactory = (language) => (editor) => ({
  key: `translate_${language.toLowerCase()}`,
  title: `Translate to ${language}`,
  aliases: ['translate', language.toLowerCase()],
  icon: <Languages size={18} />,
  onItemClick: async () => {
    await editor.getExtension(AIExtension)?.invokeAI({
      userPrompt: `Translate the selected text to ${language}. Only output the translation, no explanations.`,
      useSelection: true,
      streamToolsProvider: updateOnly
    })
  },
  size: 'small' as const
})

export const improveWriting = makeCommand(
  'improve_writing',
  'Improve Writing',
  ['improve', 'better', 'enhance', 'rewrite'],
  <Sparkles size={18} />,
  'Improve the selected text to be more clear, engaging, and well-structured. Fix any issues while preserving the original meaning.'
)

export const SELECTION_COMMANDS: CommandFactory[] = [
  improveWriting,
  fixGrammar,
  simplify,
  expand,
  summarize,
  actionItems,
  translate('English'),
  translate('Turkish')
]

export const NO_SELECTION_COMMANDS: CommandFactory[] = [continueWriting]
