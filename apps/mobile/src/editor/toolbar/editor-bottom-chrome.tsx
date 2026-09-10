import type { EditorToolbarSelection } from '@memry/contracts/webview-bridge'
import type { JSX } from 'react'
import { View } from 'react-native'

import type { BottomChrome, ToolbarIntents, ToolbarPanel } from '@/editor/toolbar/bottom-chrome'
import { LinkPrompt } from '@/editor/toolbar/link-prompt'
import { BlocksPanel, TablePanel, TurnIntoPanel } from '@/editor/toolbar/pickers'
import { StylePanel } from '@/editor/toolbar/style-panel'
import { FormattingRow, MainRow } from '@/editor/toolbar/toolbar-rows'
import { useColors } from '@/theme/use-colors'

export interface EditorBottomChromeProps {
  chrome: BottomChrome
  selection: EditorToolbarSelection
  /** Height of a keyboard-replacing panel (the last measured keyboard height). */
  panelHeight: number
  /** How much of the host the keyboard covers right now, in pt. The spacer under the toolbar. */
  keyboardOverlap: number
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
  intents
}: EditorBottomChromeProps): JSX.Element {
  const c = useColors()
  const panel = chrome.kind === 'panel' ? chrome.panel : null
  // A panel takes the keyboard's place, so the keyboard's space is already
  // spoken for. The link prompt is the exception; its own field holds the
  // keyboard up, so the spacer stays under it.
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
  intents
}: {
  panel: ToolbarPanel
  selection: EditorToolbarSelection
  panelHeight: number
  intents: ToolbarIntents
}) {
  switch (panel) {
    case 'blocks':
      return <BlocksPanel style={{ height: panelHeight }} intents={intents} />
    case 'turn-into':
      return (
        <TurnIntoPanel style={{ height: panelHeight }} selection={selection} intents={intents} />
      )
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
