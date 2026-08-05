import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

import type { AttachmentInput } from '@memry/contracts/ipc-agent'
import type { InboxItemType } from '@memry/contracts/inbox-api'
import { Node, mergeAttributes, type Editor, type JSONContent } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type ReactNodeViewProps
} from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'

import {
  MentionIcon,
  mentionColorForKind,
  type MentionAttachment,
  type MentionIconSpec
} from './mention-icons'
import { cn } from '@/lib/utils'

export interface AgentPromptValue {
  text: string
  attachments: AttachmentInput[]
}

interface MentionQuery {
  query: string
  range: {
    from: number
    to: number
  }
}

export type AgentPromptSeedPart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; attachment: MentionAttachment }

export interface AgentPromptEditorHandle {
  clear: () => void
  focus: () => void
  getValue: () => AgentPromptValue
  insertText: (text: string) => void
  /**
   * Insert an `@` that is guaranteed to open the mention picker: prepends a
   * space when the caret sits right after a non-whitespace character, so the
   * `findMentionQuery` regex (which requires start-or-whitespace) still matches.
   */
  insertMentionTrigger: () => void
  insertMention: (attachment: MentionAttachment) => void
  seed: (parts: AgentPromptSeedPart[]) => void
}

interface AgentPromptEditorProps {
  disabled: boolean
  placeholder: string
  /** Extra classes merged onto the ProseMirror element; wins over the defaults. */
  editorClassName?: string
  onEscape: () => void
  onMentionKeyDown: (event: KeyboardEvent) => boolean
  onMentionQueryChange: (query: string | null) => void
  onSubmit: () => void
  onValueChange: (value: AgentPromptValue) => void
}

const attachmentKinds = new Set<AttachmentInput['kind']>([
  'note',
  'folder',
  'task',
  'project',
  'journal',
  'current_note',
  'inbox',
  'calendar_event'
])

function isAttachmentKind(kind: unknown): kind is AttachmentInput['kind'] {
  return typeof kind === 'string' && attachmentKinds.has(kind as AttachmentInput['kind'])
}

function attachmentKindFrom(kind: unknown): AttachmentInput['kind'] {
  return isAttachmentKind(kind) ? kind : 'note'
}

function mentionIconFromAttrs(attrs: Record<string, unknown>): MentionIconSpec {
  const kind = attachmentKindFrom(attrs.kind)
  switch (kind) {
    case 'note':
      return {
        kind: 'note',
        emoji: typeof attrs.emoji === 'string' ? attrs.emoji : null
      }
    case 'current_note':
      return { kind: 'current_note' }
    case 'task':
      return { kind: 'task' }
    case 'journal':
      return { kind: 'journal' }
    case 'inbox':
      return {
        kind: 'inbox',
        itemType: typeof attrs.itemType === 'string' ? (attrs.itemType as InboxItemType) : null
      }
    case 'calendar_event':
      return { kind: 'calendar_event' }
    case 'folder':
      return { kind: 'folder' }
    case 'project':
      return { kind: 'project' }
  }
}

function mentionAttrs(attachment: MentionAttachment): Record<string, string | null> {
  const attrs: Record<string, string | null> = {
    kind: attachment.kind,
    refId: attachment.ref_id,
    label: attachment.label,
    emoji: null,
    itemType: null
  }

  if (attachment.icon.kind === 'note') {
    attrs.emoji = attachment.icon.emoji ?? null
  }
  if (attachment.icon.kind === 'inbox') {
    attrs.itemType = attachment.icon.itemType ?? null
  }

  return attrs
}

function AgentMentionNodeView({ editor, getPos, node }: ReactNodeViewProps): React.JSX.Element {
  const kind = attachmentKindFrom(node.attrs.kind)
  const refId = String(node.attrs.refId ?? '')
  const label = String(node.attrs.label ?? '')
  const icon = mentionIconFromAttrs(node.attrs)

  return (
    <NodeViewWrapper
      as="span"
      data-agent-mention=""
      data-testid={`agent-mention-${kind}-${refId}`}
      contentEditable={false}
      className={cn(
        'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.9em] font-medium leading-none ring-1',
        mentionColorForKind(kind)
      )}
      onMouseDown={(event) => {
        event.preventDefault()
        const position = getPos()
        if (typeof position === 'number') editor.commands.setNodeSelection(position)
      }}
    >
      <MentionIcon icon={icon} className="size-3 text-current" />
      <span className="truncate">@{label}</span>
    </NodeViewWrapper>
  )
}

const AgentMention = Node.create({
  name: 'agentMention',

  group: 'inline',

  inline: true,

  selectable: true,

  atom: true,

  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (element) => element.getAttribute('data-kind'),
        renderHTML: (attributes) => ({ 'data-kind': attributes.kind })
      },
      refId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-ref-id'),
        renderHTML: (attributes) => ({ 'data-ref-id': attributes.refId })
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-label'),
        renderHTML: (attributes) => ({ 'data-label': attributes.label })
      },
      emoji: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-emoji'),
        renderHTML: (attributes) => (attributes.emoji ? { 'data-emoji': attributes.emoji } : {})
      },
      itemType: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-item-type'),
        renderHTML: (attributes) =>
          attributes.itemType ? { 'data-item-type': attributes.itemType } : {}
      }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-agent-mention]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-agent-mention': ''
      }),
      `@${HTMLAttributes.label ?? ''}`
    ]
  },

  renderText({ node }) {
    return `@${node.attrs.label ?? ''}`
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () =>
        this.editor.commands.command(({ state, tr }) => {
          const { selection } = state
          if (!selection.empty || selection.anchor <= 0) return false

          let deletedMention = false
          state.doc.nodesBetween(selection.anchor - 1, selection.anchor, (node, pos) => {
            if (node.type.name !== this.name) return true
            tr.delete(pos, pos + node.nodeSize)
            deletedMention = true
            return false
          })
          return deletedMention
        }),
      Delete: () =>
        this.editor.commands.command(({ state, tr }) => {
          const { selection } = state
          if (!selection.empty || selection.anchor >= state.doc.content.size) return false

          let deletedMention = false
          state.doc.nodesBetween(selection.anchor, selection.anchor + 1, (node, pos) => {
            if (node.type.name !== this.name) return true
            tr.delete(pos, pos + node.nodeSize)
            deletedMention = true
            return false
          })
          return deletedMention
        })
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(AgentMentionNodeView)
  }
})

function serializePromptNode(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'agentMention') return `@${String(node.attrs?.label ?? '')}`
  return (node.content ?? []).map(serializePromptNode).join('')
}

function collectMentionAttachments(node: JSONContent, attachments: AttachmentInput[]): void {
  if (node.type === 'agentMention') {
    const kind = attachmentKindFrom(node.attrs?.kind)
    const refId = typeof node.attrs?.refId === 'string' ? node.attrs.refId : null
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label : null
    if (refId && label) {
      attachments.push({ kind, ref_id: refId, label })
    }
  }

  node.content?.forEach((child) => collectMentionAttachments(child, attachments))
}

function dedupeAttachments(attachments: AttachmentInput[]): AttachmentInput[] {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const key = `${attachment.kind}:${attachment.ref_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function readEditorValue(editor: Editor | null): AgentPromptValue {
  if (!editor) return { text: '', attachments: [] }

  const json = editor.getJSON()
  const text = (json.content ?? []).map(serializePromptNode).join('\n')
  const attachments: AttachmentInput[] = []
  collectMentionAttachments(json, attachments)
  return {
    text,
    attachments: dedupeAttachments(attachments)
  }
}

function findMentionQuery(editor: Editor): MentionQuery | null {
  const { selection } = editor.state
  if (!selection.empty) return null

  const { $from } = selection
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\ufffc')
  const match = /(?:^|\s)@([^@\n]*)$/.exec(textBefore)
  if (!match) return null

  const query = match[1] ?? ''
  return {
    query,
    range: {
      from: selection.from - query.length - 1,
      to: selection.from
    }
  }
}

export const AgentPromptEditor = forwardRef<AgentPromptEditorHandle, AgentPromptEditorProps>(
  function AgentPromptEditor(
    {
      disabled,
      placeholder,
      editorClassName,
      onEscape,
      onMentionKeyDown,
      onMentionQueryChange,
      onSubmit,
      onValueChange
    },
    ref
  ) {
    const activeMentionRef = useRef<MentionQuery | null>(null)
    const onEscapeRef = useRef(onEscape)
    const onMentionKeyDownRef = useRef(onMentionKeyDown)
    const onMentionQueryChangeRef = useRef(onMentionQueryChange)
    const onSubmitRef = useRef(onSubmit)
    const onValueChangeRef = useRef(onValueChange)

    useEffect(() => {
      onEscapeRef.current = onEscape
      onMentionKeyDownRef.current = onMentionKeyDown
      onMentionQueryChangeRef.current = onMentionQueryChange
      onSubmitRef.current = onSubmit
      onValueChangeRef.current = onValueChange
    }, [onEscape, onMentionKeyDown, onMentionQueryChange, onSubmit, onValueChange])

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          blockquote: false,
          bold: false,
          bulletList: false,
          code: false,
          codeBlock: false,
          dropcursor: false,
          gapcursor: false,
          heading: false,
          horizontalRule: false,
          italic: false,
          listItem: false,
          listKeymap: false,
          link: false,
          orderedList: false,
          strike: false,
          trailingNode: false,
          underline: false
        }),
        Placeholder.configure({ placeholder }),
        AgentMention
      ],
      content: '',
      editable: !disabled,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': placeholder,
          'aria-multiline': 'true',
          // The accessible name is the placeholder, which is product copy and
          // has been reworded twice. Tests target this instead.
          'data-testid': 'agent-composer-input',
          class: cn(
            '!min-h-[48.4px] min-h-[48.4px] max-h-[258px] whitespace-pre-wrap break-words border-0 bg-transparent p-3 text-[16px] text-foreground outline-none transition-[padding] duration-200 ease-in-out focus:outline-none',
            '[&_p]:m-0 [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:text-sm [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]',
            editorClassName
          )
        },
        handleDOMEvents: {
          keydown: (_view, event) => {
            if (onMentionKeyDownRef.current(event)) return true
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSubmitRef.current()
              return true
            }
            if (event.key === 'Escape') {
              onEscapeRef.current()
              return false
            }
            return false
          }
        }
      },
      onUpdate: ({ editor: updatedEditor }) => {
        onValueChangeRef.current(readEditorValue(updatedEditor))
        const mentionQuery = findMentionQuery(updatedEditor)
        activeMentionRef.current = mentionQuery
        onMentionQueryChangeRef.current(mentionQuery?.query ?? null)
      },
      onSelectionUpdate: ({ editor: updatedEditor }) => {
        const mentionQuery = findMentionQuery(updatedEditor)
        activeMentionRef.current = mentionQuery
        onMentionQueryChangeRef.current(mentionQuery?.query ?? null)
      }
    })

    useEffect(() => {
      // Tiptap exposes editable state through the editor instance after initialization.
      // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-ref-to-parent
      editor?.setEditable(!disabled)
    }, [disabled, editor])

    useImperativeHandle(
      ref,
      () => ({
        clear: () => {
          editor?.commands.clearContent(true)
          activeMentionRef.current = null
          onMentionQueryChangeRef.current(null)
          onValueChangeRef.current({ text: '', attachments: [] })
        },
        focus: () => {
          editor?.commands.focus('end')
        },
        getValue: () => readEditorValue(editor),
        insertText: (text) => {
          if (!editor || !text) return

          editor.chain().focus().insertContent(text).run()

          const mentionQuery = findMentionQuery(editor)
          activeMentionRef.current = mentionQuery
          onMentionQueryChangeRef.current(mentionQuery?.query ?? null)
          onValueChangeRef.current(readEditorValue(editor))
        },
        insertMentionTrigger: () => {
          if (!editor) return

          const { $from } = editor.state.selection
          const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '￼')
          const needsSpace = textBefore.length > 0 && !/\s$/.test(textBefore)

          editor
            .chain()
            .focus()
            .insertContent(needsSpace ? ' @' : '@')
            .run()

          const mentionQuery = findMentionQuery(editor)
          activeMentionRef.current = mentionQuery
          onMentionQueryChangeRef.current(mentionQuery?.query ?? null)
          onValueChangeRef.current(readEditorValue(editor))
        },
        seed: (parts) => {
          if (!editor) return

          const paragraphs: JSONContent[][] = [[]]
          for (const part of parts) {
            if (part.kind === 'mention') {
              paragraphs[paragraphs.length - 1].push({
                type: 'agentMention',
                attrs: mentionAttrs(part.attachment)
              })
              continue
            }
            part.text.split('\n').forEach((chunk, index) => {
              if (index > 0) paragraphs.push([])
              if (chunk) paragraphs[paragraphs.length - 1].push({ type: 'text', text: chunk })
            })
          }

          editor.commands.setContent({
            type: 'doc',
            content: paragraphs.map((content) =>
              content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
            )
          })
          activeMentionRef.current = null
          onMentionQueryChangeRef.current(null)
          onValueChangeRef.current(readEditorValue(editor))
        },
        insertMention: (attachment) => {
          if (!editor || !activeMentionRef.current) return

          editor
            .chain()
            .focus()
            .insertContentAt(activeMentionRef.current.range, [
              { type: 'agentMention', attrs: mentionAttrs(attachment) },
              { type: 'text', text: ' ' }
            ])
            .run()

          activeMentionRef.current = null
          onMentionQueryChangeRef.current(null)
          onValueChangeRef.current(readEditorValue(editor))
        }
      }),
      [editor]
    )

    return <EditorContent editor={editor} />
  }
)
