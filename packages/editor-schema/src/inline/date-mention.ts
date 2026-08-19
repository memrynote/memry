/**
 * `dateMention` inline content spec — serialization half only.
 *
 * The pill's `render` formats relative days against the user's week-start and
 * clock-format settings, so it stays in the renderer. The token that reaches
 * the vault file comes from @memry/shared/date-mention, which both processes
 * already depend on, so parse/toExternalHTML live here. See hash-tag.ts.
 */

import { createInlineContentSpec, type InlineContentSpec } from '@blocknote/core'
import type { CustomInlineContentImplementation } from '@blocknote/core'
import {
  serializeDateMentionToken,
  type DateMentionDateFormat,
  type DateMentionTimeFormat,
  type RemindOffset
} from '@memry/shared/date-mention'

export const dateMentionConfig = {
  type: 'dateMention' as const,
  propSchema: {
    anchorId: { default: '' },
    dateISO: { default: '' },
    hasTime: { default: false },
    dateFormat: { default: 'relative' },
    remind: { default: 'none' },
    timeFormat: { default: 'system' }
  },
  content: 'none' as const
}

type DateMentionRender = CustomInlineContentImplementation<
  typeof dateMentionConfig,
  never
>['render']

interface DateMentionProps {
  anchorId: string
  dateISO: string
  hasTime: boolean
  dateFormat: string
  remind: string
  timeFormat: string
}

export const dateMentionSerialization = {
  parse: (element: HTMLElement) => {
    if (!element.hasAttribute('data-date-mention')) return undefined
    const anchorId = element.getAttribute('data-anchor-id') || ''
    const dateISO = element.getAttribute('data-date-iso') || ''
    if (!anchorId || !dateISO) return undefined
    return {
      anchorId,
      dateISO,
      hasTime: element.getAttribute('data-has-time') === 'true',
      dateFormat: (element.getAttribute('data-date-format') || 'relative') as DateMentionDateFormat,
      remind: (element.getAttribute('data-remind') || 'none') as RemindOffset,
      timeFormat: (element.getAttribute('data-time-format') || 'system') as DateMentionTimeFormat
    }
  },
  toExternalHTML: (inlineContent: { props: DateMentionProps }) => {
    const { anchorId, dateISO, hasTime, dateFormat, remind, timeFormat } = inlineContent.props
    const dom = document.createElement('span')
    dom.textContent = serializeDateMentionToken({
      anchorId,
      dateISO,
      hasTime,
      dateFormat: dateFormat as DateMentionDateFormat,
      remind: remind as RemindOffset,
      timeFormat: timeFormat as DateMentionTimeFormat
    })
    return { dom }
  }
}

export function createDateMentionSpec(
  render: DateMentionRender
): InlineContentSpec<typeof dateMentionConfig> {
  return createInlineContentSpec(dateMentionConfig, {
    render,
    ...dateMentionSerialization
  })
}
