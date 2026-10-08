import type { LanguageModelMiddleware } from 'ai'

type TransformParams = NonNullable<LanguageModelMiddleware['transformParams']>
export type ModelCallOptions = Parameters<TransformParams>[0]['params']
export type ModelPrompt = ModelCallOptions['prompt']
type ModelMessage = ModelPrompt[number]
type ToolPart = Extract<ModelMessage, { role: 'tool' }>['content'][number]
type UserPart = Extract<ModelMessage, { role: 'user' }>['content'][number]

/** Said in place of a tool image to a model that does not take images (FB-002 Decision 3). */
export const TOOL_IMAGE_NOT_SENT =
  'The image was not sent: this model does not take images. vault_read_note returns the ' +
  'text read from the file.'

interface ImageData {
  data: string
  mediaType: string
}

function toolImages(part: ToolPart): ImageData[] {
  if (part.type !== 'tool-result' || part.output.type !== 'content') return []
  return part.output.value.flatMap((item) =>
    item.type === 'image-data' ? [{ data: item.data, mediaType: item.mediaType }] : []
  )
}

function hasToolImages(message: ModelMessage): boolean {
  return message.role === 'tool' && message.content.some((part) => toolImages(part).length > 0)
}

/** The tool result as text only, and the user-message parts that show its images. */
function splitToolPart(part: ToolPart, acceptsImages: boolean): [ToolPart, UserPart[]] {
  const images = toolImages(part)
  if (images.length === 0 || part.type !== 'tool-result' || part.output.type !== 'content') {
    return [part, []]
  }
  const text = part.output.value
    .flatMap((item) => (item.type === 'text' ? [item.text] : []))
    .join('\n')
  if (!acceptsImages) {
    return [{ ...part, output: { type: 'text', value: `${text}\n${TOOL_IMAGE_NOT_SENT}` } }, []]
  }
  return [
    { ...part, output: { type: 'text', value: text } },
    [
      { type: 'text', text: `Image returned by ${part.toolName} (call ${part.toolCallId}):` },
      ...images.map((image) => ({
        type: 'file' as const,
        data: image.data,
        mediaType: image.mediaType
      }))
    ]
  ]
}

/**
 * Chat Completions tool messages carry text only, and the provider would send
 * an image part as base64 inside the JSON text. So each tool image moves into
 * a user message right after the run of tool messages, or, for a model that
 * does not take images, becomes TOOL_IMAGE_NOT_SENT. `acceptsImages` is asked
 * only when the prompt holds a tool image.
 */
export function toolImageMiddleware(
  acceptsImages: () => Promise<boolean>
): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      if (!params.prompt.some(hasToolImages)) return params
      const accepts = await acceptsImages()

      const prompt: ModelPrompt = []
      let shown: UserPart[] = []
      for (const message of params.prompt) {
        if (message.role !== 'tool' && shown.length > 0) {
          prompt.push({ role: 'user', content: shown })
          shown = []
        }
        if (message.role !== 'tool' || !hasToolImages(message)) {
          prompt.push(message)
          continue
        }
        const content = message.content.map((part) => {
          const [toolPart, userParts] = splitToolPart(part, accepts)
          shown.push(...userParts)
          return toolPart
        })
        prompt.push({ ...message, content })
      }
      if (shown.length > 0) prompt.push({ role: 'user', content: shown })
      return { ...params, prompt }
    }
  }
}
