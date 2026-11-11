/**
 * BlockNote's `SuggestionMenuController` for the `/` trigger, with one change: when to close a
 * menu that matches nothing.
 *
 * BlockNote closes the menu once the query is 4 characters past the last query that had items,
 * and it learns which queries had items only from the lookups React got to render. Typing fast
 * (or a slow frame) moves the query from `` to `zqxv` in one render, so `/z`, which matches
 * Divider, was never looked up: the menu closed with `zqxv` 4 characters past ``, and Enter then
 * split the paragraph instead of handing `zqxv` to note search (#4205). Here the rule reads the
 * query itself: the menu closes when the query and its 3 shorter prefixes all match nothing,
 * however the characters arrived.
 *
 * And one more: Enter waits for the current query's rows. BlockNote runs the selected row of the
 * last list that finished loading, so `/check` and Enter before the `check` lookup returned
 * inserted Divider, the first row of `/` (#4245). Enter on a stale list is held until that query's
 * rows load and then runs the first one; it is dropped if the query changes again first.
 *
 * Copied from `@blocknote/react@0.54.2` (`SuggestionMenuController.tsx` and
 * `SuggestionMenuWrapper.tsx`). Re-diff against upstream on every BlockNote bump.
 */

import { useCallback, useEffect, useMemo, useRef, type FC, type ReactNode } from 'react'
import { SuggestionMenu } from '@blocknote/core/extensions'
import {
  GenericPopover,
  useBlockNoteContext,
  useBlockNoteEditor,
  useEditorDOMElement,
  useExtension,
  useExtensionState,
  useLoadSuggestionMenuItems,
  useSuggestionMenuKeyboardNavigation,
  type FloatingUIOptions,
  type GenericPopoverReference,
  type SuggestionMenuProps
} from '@blocknote/react'
import { autoPlacement, offset, shift, size } from '@floating-ui/react'

const TRIGGER = '/'
/** BlockNote's `invalidQueries`: no-match characters typed past the last query with items. */
const NO_MATCH_CHARACTERS_BEFORE_CLOSE = 3

/** True when the query and its shorter prefixes, back to 3 characters, all match nothing. */
async function isDeadEndQuery<Item>(
  query: string,
  getItems: (query: string) => Promise<Item[]>
): Promise<boolean> {
  if (query.length <= NO_MATCH_CHARACTERS_BEFORE_CLOSE) return false
  for (let cut = 0; cut <= NO_MATCH_CHARACTERS_BEFORE_CLOSE; cut++) {
    if ((await getItems(query.slice(0, query.length - cut))).length > 0) return false
  }
  return true
}

type ControllerProps<Item> = {
  getItems: (query: string) => Promise<Item[]>
  suggestionMenuComponent: FC<SuggestionMenuProps<Item>>
  onItemClick: (item: Item) => void
}

function SlashMenuWrapper<Item>({
  query,
  getItems,
  suggestionMenuComponent: Component,
  onItemClick
}: ControllerProps<Item> & { query: string }): ReactNode {
  const setContentEditableProps = useBlockNoteContext()!.setContentEditableProps!
  const editor = useBlockNoteEditor()
  const suggestionMenu = useExtension(SuggestionMenu)
  const { closeMenu, clearQuery } = suggestionMenu

  const onItemClickCloseMenu = useCallback(
    (item: Item) => {
      closeMenu()
      clearQuery()
      onItemClick(item)
    },
    [onItemClick, closeMenu, clearQuery]
  )

  // The last lookup that finished, and the query of an Enter waiting for its own lookup.
  const lastLoaded = useRef<{ query: string; items: Item[] } | undefined>(undefined)
  const heldEnter = useRef<string | undefined>(undefined)
  const liveQuery = useCallback(() => suggestionMenu.store.state?.query, [suggestionMenu])

  const loadItems = useCallback(
    async (lookupQuery: string) => {
      const loaded = await getItems(lookupQuery)
      lastLoaded.current = { query: lookupQuery, items: loaded }
      if (heldEnter.current === lookupQuery) {
        heldEnter.current = undefined
        if (liveQuery() === lookupQuery && loaded[0] !== undefined) onItemClickCloseMenu(loaded[0])
      }
      return loaded
    },
    [getItems, liveQuery, onItemClickCloseMenu]
  )

  const { items, usedQuery, loadingState } = useLoadSuggestionMenuItems(query, loadItems)

  useEffect(() => {
    let current = true
    if (usedQuery !== undefined && items.length === 0) {
      void isDeadEndQuery(usedQuery, getItems).then((deadEnd) => {
        if (current && deadEnd) closeMenu()
      })
    }
    return () => {
      current = false
    }
  }, [closeMenu, getItems, items.length, usedQuery])

  const runEnter = useCallback(
    (item: Item) => {
      // The extension's state, not `query`: keys typed in the frame before Enter are not rendered.
      const current = liveQuery()
      const loaded = lastLoaded.current
      if (current === usedQuery) {
        onItemClickCloseMenu(item)
      } else if (loaded !== undefined && loaded.query === current) {
        // Loaded but not rendered yet: its first row is the one that will show selected.
        const first = loaded.items[0]
        if (first !== undefined) onItemClickCloseMenu(first)
      } else {
        heldEnter.current = current
      }
    },
    [liveQuery, usedQuery, onItemClickCloseMenu]
  )

  const { selectedIndex } = useSuggestionMenuKeyboardNavigation(editor, query, items, runEnter)

  useEffect(() => {
    setContentEditableProps((p) => ({
      ...p,
      'aria-expanded': true,
      'aria-controls': 'bn-suggestion-menu'
    }))
    return () => {
      setContentEditableProps((p) => ({
        ...p,
        'aria-expanded': false,
        'aria-controls': undefined
      }))
    }
  }, [setContentEditableProps])

  useEffect(() => {
    setContentEditableProps((p) => ({
      ...p,
      'aria-activedescendant':
        selectedIndex === undefined ? undefined : `bn-suggestion-menu-item-${selectedIndex}`
    }))
    return () => {
      setContentEditableProps((p) => ({ ...p, 'aria-activedescendant': undefined }))
    }
  }, [setContentEditableProps, selectedIndex])

  return (
    <Component
      items={items}
      onItemClick={onItemClickCloseMenu}
      loadingState={loadingState}
      selectedIndex={selectedIndex}
    />
  )
}

export function SlashMenuController<Item>(props: ControllerProps<Item>): ReactNode {
  const editorDOMElement = useEditorDOMElement()
  const suggestionMenu = useExtension(SuggestionMenu)

  useEffect(() => {
    suggestionMenu.addSuggestionMenu({ triggerCharacter: TRIGGER })
  }, [suggestionMenu])

  const state = useExtensionState(SuggestionMenu)
  const reference = useExtensionState(SuggestionMenu, {
    selector: (menuState) =>
      ({
        element: editorDOMElement?.firstElementChild ?? undefined,
        getBoundingClientRect: () => menuState?.referencePos || new DOMRect()
      }) satisfies GenericPopoverReference
  })

  const floatingUIOptions = useMemo<FloatingUIOptions>(
    () => ({
      useFloatingOptions: {
        open: state?.show && state?.triggerCharacter === TRIGGER,
        onOpenChange: (open) => {
          if (!open) suggestionMenu.closeMenu()
        },
        placement: 'bottom-start',
        middleware: [
          offset(10),
          autoPlacement({ allowedPlacements: ['bottom-start', 'top-start'], padding: 10 }),
          shift(),
          size({
            apply({ elements, availableHeight }) {
              elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`
            },
            padding: 10
          })
        ]
      },
      focusManagerProps: { disabled: true },
      elementProps: {
        onMouseDownCapture: (event) => event.preventDefault(),
        style: { zIndex: 80 }
      }
    }),
    [state?.show, state?.triggerCharacter, suggestionMenu]
  )

  if (!state) return null

  return (
    <GenericPopover reference={reference} {...floatingUIOptions}>
      <SlashMenuWrapper query={state.query} {...props} />
    </GenericPopover>
  )
}
