import {
  addDefaultPropsExternalHTML,
  createBlockSpec,
  createToggleListItemBlockSpec,
  createToggleWrapper,
  type ExtensionFactoryInstance
} from '@blocknote/core'
import { toggleListItemConfig } from '@memry/editor-schema/blocks'

/**
 * The editor's toggle, which is BlockNote's own with the fold moved into the
 * document (#1847).
 *
 * BlockNote's `defaultToggledState` reads and writes `localStorage` under
 * `toggle-<block.id>`. Block ids are minted fresh every time markdown is parsed
 * into blocks, and localStorage is per-device, so the fold survived neither a
 * re-open nor a sync. `createToggleWrapper` takes the state as a parameter for
 * exactly this, so the wrapper DOM and its behaviour stay BlockNote's; only
 * where the bit lives changes.
 *
 * `set` also runs from inside `createToggleWrapper`'s `editor.onChange` handler
 * when a child is added to a collapsed toggle. That is a sequential dispatch,
 * not a nested one: tiptap emits `update` from `dispatchTransaction` after
 * `view.updateState` has returned.
 */
interface ToggleBlock {
  props: { open?: boolean }
}

const defaultSpec = createToggleListItemBlockSpec()

export const createToggleListItemBlock = createBlockSpec(
  toggleListItemConfig,
  {
    render(block, editor) {
      const paragraph = document.createElement('p')
      const wrapper = createToggleWrapper(block as never, editor as never, paragraph, {
        get: (toggle) => (toggle as unknown as ToggleBlock).props.open === true,
        set: (toggle, isToggled) =>
          editor.transact(() => editor.updateBlock(toggle, { props: { open: isToggled } }))
      })

      return { ...wrapper, contentDOM: paragraph }
    },
    // The bytes a toggle nested under a list item reaches the vault as, and the
    // same DOM the main process builds (`server-specs.ts`). A toggle on a page
    // never gets here: the save path writes those as `<details>` itself.
    toExternalHTML(block) {
      const li = document.createElement('li')
      const p = document.createElement('p')
      addDefaultPropsExternalHTML(block.props, li)
      li.appendChild(p)
      return { dom: li, contentDOM: p }
    }
  },
  // BlockNote hangs the Enter and Mod-Shift-6 handlers off its own spec, and an
  // override replaces the whole spec object. Reused rather than reimplemented:
  // the handler they call (`handleEnter`) is not part of the public surface.
  defaultSpec.extensions as ExtensionFactoryInstance[] | undefined
)
