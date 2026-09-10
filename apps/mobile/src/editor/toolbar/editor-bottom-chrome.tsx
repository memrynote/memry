import type { EditorToolbarSelection } from '@memry/contracts/webview-bridge'
import type { JSX } from 'react'
import { View } from 'react-native'

import type { BottomChrome, ToolbarIntents, ToolbarPanel } from '@/editor/toolbar/bottom-chrome'
import { LinkPrompt } from '@/editor/toolbar/link-prompt'
import { BlocksPanel, TablePanel, TurnIntoPanel } from '@/editor/toolbar/pickers'
import { StylePanel } from '@/editor/toolbar/style-panel'
import { FormattingRow, MainRow } from '@/editor/toolbar/toolbar-rows'
import { sizes } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface EditorBottomChromeProps {
  chrome: BottomChrome
  selection: EditorToolbarSelection
  /** Height of a keyboard-replacing panel (the last measured keyboard height). */
  panelHeight: number
  /** How much of the host the keyboard covers right now, in pt. The spacer under the toolbar. */
  keyboardOverlap: number
  /** The editor frame's height, the most a content-sized panel may take. */
  availableHeight: number
  intents: ToolbarIntents
}

/**
 * Everything below the editor WebView, in one column.
 *
 * The WebView's frame ends where this begins, so a panel does not float over
 * the document: it occupies the space the keyboard is giving back.
 */
export function EditorBottomChrome({
  chrome,
  selection,
  panelHeight,
  keyboardOverlap,
  availableHeight,
  intents
}: EditorBottomChromeProps): JSX.Element {
  const c = useColors()
  const panel = chrome.kind === 'panel' ? chrome.panel : null
  // A panel takes the keyboard's place, so the keyboard's space is already
  // spoken for. The link prompt is the exception; its own field holds the
  // keyboard up, so the spacer stays under it. The spacer is also drawn under
  // a HIDDEN chrome: that is what keeps the WebView above a keyboard the title
  // field or a tag sheet raised.
  const spacer = panel === null || panel === 'link-prompt'

  return (
    <View style={{ backgroundColor: c.canvas.background }}>
      {chrome.kind === 'hidden' ? null : chrome.row === 'main' ? (
        <MainRow panel={panel} selection={selection} intents={intents} />
      ) : (
        <FormattingRow panel={panel} selection={selection} intents={intents} />
      )}
      {panel === null ? null : (
        <PanelView
          panel={panel}
          selection={selection}
          panelHeight={panelHeight}
          availableHeight={availableHeight}
          intents={intents}
        />
      )}
      {spacer ? <View style={{ height: keyboardOverlap }} /> : null}
    </View>
  )
}

function PanelView({
  panel,
  selection,
  panelHeight,
  availableHeight,
  intents
}: {
  panel: ToolbarPanel
  selection: EditorToolbarSelection
  panelHeight: number
  availableHeight: number
  intents: ToolbarIntents
}) {
  switch (panel) {
    case 'blocks':
      return <BlocksPanel style={{ height: panelHeight }} intents={intents} />
    case 'turn-into': {
      // Fourteen cards are taller than a keyboard, so the grid sizes to its
      // content under the DOM's `min(546px, viewport - 56px)` ceiling rather
      // than scrolling inside the keyboard's slot.
      const ceiling = Math.max(panelHeight, Math.min(546, availableHeight - sizes.row))
      return (
        <TurnIntoPanel style={{ maxHeight: ceiling }} selection={selection} intents={intents} />
      )
    }
    case 'table':
      return <TablePanel style={{ height: panelHeight }} selection={selection} intents={intents} />
    case 'style':
      // Two colour rows are shorter than a keyboard, and a panel padded out to
      // the keyboard's height would push the paragraph being styled off screen.
      return (
        <StylePanel style={{ maxHeight: panelHeight }} selection={selection} intents={intents} />
      )
    case 'link-prompt':
      return <LinkPrompt intents={intents} />
    default: {
      const _exhaustive: never = panel
      return _exhaustive
    }
  }
}
