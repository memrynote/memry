import { createInlineContentSpec } from '@blocknote/core'
import {
  serializeDateMentionToken,
  type DateMentionData,
  type DateMentionLead
} from '@memry/shared/date-mention'

export function formatDateMentionLabel(dateISO: string, hasTime: boolean): string {
  const d = new Date(dateISO)
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (!hasTime) return date
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date}, ${time}`
}

export function createDateMentionContent(data: DateMentionData) {
  return {
    type: 'dateMention' as const,
    props: {
      anchorId: data.anchorId,
      dateISO: data.dateISO,
      hasTime: data.hasTime,
      remind: data.remind,
      lead: data.lead
    }
  }
}

export const DateMention = createInlineContentSpec(
  {
    type: 'dateMention',
    propSchema: {
      anchorId: { default: '' },
      dateISO: { default: '' },
      hasTime: { default: false },
      remind: { default: false },
      lead: { default: 'at' }
    },
    content: 'none'
  },
  {
    render: (inlineContent) => {
      const { anchorId, dateISO, hasTime, remind, lead } = inlineContent.props

      const dom = document.createElement('span')
      dom.className = 'date-mention'
      dom.setAttribute('data-date-mention', '')
      dom.setAttribute('data-anchor-id', anchorId)
      dom.setAttribute('data-date-iso', dateISO)
      dom.setAttribute('data-has-time', String(hasTime))
      dom.setAttribute('data-remind', String(remind))
      dom.setAttribute('data-lead', String(lead))
      dom.setAttribute('contenteditable', 'false')

      const icon = document.createElement('span')
      icon.className = 'date-mention-icon'
      icon.textContent = '📅'
      dom.appendChild(icon)

      const label = document.createElement('span')
      label.className = 'date-mention-label'
      label.textContent = formatDateMentionLabel(dateISO, hasTime)
      dom.appendChild(label)

      if (remind) {
        const bell = document.createElement('span')
        bell.className = 'date-mention-bell'
        bell.textContent = '🔔'
        dom.appendChild(bell)
      }

      return { dom }
    },

    parse: (element) => {
      if (!element.hasAttribute('data-date-mention')) return undefined
      const anchorId = element.getAttribute('data-anchor-id') || ''
      const dateISO = element.getAttribute('data-date-iso') || ''
      if (!anchorId || !dateISO) return undefined
      return {
        anchorId,
        dateISO,
        hasTime: element.getAttribute('data-has-time') === 'true',
        remind: element.getAttribute('data-remind') === 'true',
        lead: (element.getAttribute('data-lead') || 'at') as DateMentionLead
      }
    },

    toExternalHTML: (inlineContent) => {
      const { anchorId, dateISO, hasTime, remind } = inlineContent.props
      const lead = inlineContent.props.lead as DateMentionLead
      const dom = document.createElement('span')
      dom.textContent = serializeDateMentionToken({ anchorId, dateISO, hasTime, remind, lead })
      return { dom }
    }
  }
)
