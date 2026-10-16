import type { CommandMeta } from './types'

/** Acts on the canvas shown in the active tab. */
export const CANVAS_COMMANDS = {
  'canvas.addCard': {
    context: 'canvas',
    owner: 'canvas',
    group: 'canvas',
    i18nKey: 'commands.canvasAddCard'
  },
  'canvas.layoutByProperty': {
    context: 'canvas',
    owner: 'canvas',
    group: 'canvas',
    i18nKey: 'commands.canvasLayoutByProperty'
  },
  'canvas.linkToItem': {
    context: 'canvas',
    owner: 'canvas',
    group: 'canvas',
    i18nKey: 'commands.canvasLinkToItem'
  }
} as const satisfies Record<string, CommandMeta>
