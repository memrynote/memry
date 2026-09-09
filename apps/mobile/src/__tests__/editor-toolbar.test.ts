// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BLOCK_PICKER_GROUPS,
  installEditorToolbar,
  type EditorToolbarActions
} from '../../editor-web/src/editor-toolbar'

function toolbarActions(): EditorToolbarActions {
  return {
    insert: vi.fn(),
    turnInto: vi.fn(),
    toggleStyle: vi.fn(),
    toggleBulletedList: vi.fn(),
    createLink: vi.fn(),
    focusEditor: vi.fn(),
    insertWikiLink: vi.fn(),
    insertImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    dismissKeyboard: vi.fn()
  }
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === name
  )
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return match
}

function install(host: HTMLElement, actions = toolbarActions()) {
  const controller = installEditorToolbar(host, actions)
  controller.setKeyboardVisible(true)
  return controller
}

describe('mobile editor toolbar', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    document.documentElement.style.removeProperty('--memry-viewport-bottom-inset')
    document.documentElement.style.removeProperty('--memry-keyboard-height')
  })

  it('keeps Aa and Turn into as separate states from the Paper flow', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    install(host)

    button('Formatting').click()

    expect(document.querySelector('[aria-label="Formatting"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Turn into"]')).toBeNull()
    expect(button('Bold')).toBeInstanceOf(HTMLButtonElement)

    button('Back to editor toolbar').click()
    button('Turn into. Current block: T').click()

    expect(document.querySelector('[aria-label="Turn into"]')).not.toBeNull()
    expect(button('Bold')).toBeInstanceOf(HTMLButtonElement)
  })

  it('shows the complete desktop block set and dispatches the selected item', () => {
    const actions = toolbarActions()
    const host = document.createElement('div')
    document.body.appendChild(host)
    install(host, actions)

    button('Insert blocks').click()

    const labels = BLOCK_PICKER_GROUPS.flatMap((group) => group.items.map((item) => item.label))
    expect(labels).toEqual([
      'Text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Heading 4',
      'Heading 5',
      'Heading 6',
      'Bulleted list',
      'Numbered list',
      'To-do list',
      'Toggle list',
      'Quote',
      'Code',
      'Callout',
      'Divider',
      'Image',
      'File',
      'Table',
      'Link to note'
    ])
    expect(document.querySelector('[aria-label="Blocks"]')).not.toBeNull()

    const heading = button('Heading 4')
    heading.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
    heading.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))
    expect(actions.insert).not.toHaveBeenCalled()

    heading.click()

    expect(actions.insert).toHaveBeenCalledWith({
      kind: 'convertible',
      block: { kind: 'heading', level: 4 }
    })
    expect(document.querySelector('[aria-label="Blocks"]')).toBeNull()
  })

  it('reflects the active block and inline styles', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = install(host)

    controller.update({
      blockLabel: 'H2',
      activeStyles: {
        bold: true,
        italic: false,
        underline: true,
        strike: false,
        code: false
      }
    })
    button('Formatting').click()

    expect(button('Turn into. Current block: H2').textContent).toBe('H2')
    expect(button('Bold').getAttribute('aria-pressed')).toBe('true')
    expect(button('Underline').getAttribute('aria-pressed')).toBe('true')
    expect(button('Italic').getAttribute('aria-pressed')).toBe('false')
  })

  it('renders only while the software keyboard is visible and find is closed', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = installEditorToolbar(host, toolbarActions())

    expect(host.hidden).toBe(true)
    expect(host.childElementCount).toBe(0)

    controller.setKeyboardVisible(true)
    expect(host.hidden).toBe(false)
    expect(button('Formatting')).toBeInstanceOf(HTMLButtonElement)

    controller.setSuppressed(true)
    expect(host.hidden).toBe(true)
    expect(host.childElementCount).toBe(0)

    controller.setSuppressed(false)
    controller.setKeyboardVisible(false)
    expect(host.hidden).toBe(true)
  })

  it('keeps a block picker open after dismissing the keyboard and reports panel state', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const panelStates: boolean[] = []
    const controller = installEditorToolbar(host, toolbarActions(), (open) =>
      panelStates.push(open)
    )
    controller.setKeyboardVisible(true)

    button('Insert blocks').click()
    controller.setKeyboardVisible(false)

    expect(host.hidden).toBe(false)
    expect(document.querySelector('[aria-label="Blocks"]')).not.toBeNull()
    expect(controller.isPanelOpen()).toBe(true)
    expect(panelStates).toEqual([true])

    button('Dismiss picker').click()
    expect(host.hidden).toBe(true)
    expect(controller.isPanelOpen()).toBe(false)
    expect(panelStates).toEqual([true, false])
  })

  it('replaces the keyboard with a picker at the measured keyboard height', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const actions = toolbarActions()
    const dismissKeyboard = vi.fn(() => {
      document.documentElement.style.setProperty('--memry-viewport-bottom-inset', '0px')
    })
    actions.dismissKeyboard = dismissKeyboard
    const controller = install(host, actions)
    document.documentElement.style.setProperty('--memry-viewport-bottom-inset', '290px')

    button('Insert blocks').click()

    const picker = document.querySelector<HTMLElement>('[aria-label="Blocks"]')
    expect(picker?.style.getPropertyValue('--memry-picker-height')).toBe('290px')
    expect(dismissKeyboard).toHaveBeenCalledOnce()

    document.documentElement.style.setProperty('--memry-viewport-bottom-inset', '0px')
    controller.setKeyboardVisible(false)
    const pickerAfterKeyboardDismiss = document.querySelector<HTMLElement>('[aria-label="Blocks"]')
    expect(pickerAfterKeyboardDismiss?.style.getPropertyValue('--memry-picker-height')).toBe(
      '290px'
    )
  })

  it('sizes the picker from the host keyboard height, not the clipped inset', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    install(host)
    // What a KeyboardAvoidingView leaves the guest: a sliver of the keyboard.
    document.documentElement.style.setProperty('--memry-viewport-bottom-inset', '34px')
    document.documentElement.style.setProperty('--memry-keyboard-height', '336px')

    button('Insert blocks').click()

    const picker = document.querySelector<HTMLElement>('[aria-label="Blocks"]')
    expect(picker?.style.getPropertyValue('--memry-picker-height')).toBe('336px')
  })

  it('restores editor focus when the link prompt is cancelled', () => {
    const actions = toolbarActions()
    const host = document.createElement('div')
    document.body.appendChild(host)
    install(host, actions)

    button('Formatting').click()
    button('Link').click()
    button('Cancel').click()

    expect(actions.focusEditor).toHaveBeenCalledOnce()
  })
})
