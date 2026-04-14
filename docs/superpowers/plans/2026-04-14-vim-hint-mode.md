# Vim-Style Hint Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Vimium-style F-key hint navigation that overlays mnemonic labels on every clickable element, letting users navigate the entire app without a mouse.

**Architecture:** React context + portal overlay. Pure-function DOM scanner finds clickable elements, pure-function label assigner generates mnemonic-first labels, a React portal renders positioned badges, and a keyboard hook manages the activation/deactivation lifecycle. A module-level ref flag suspends existing shortcut handlers during hint mode.

**Tech Stack:** React 19 (context, portal, hooks), TypeScript, Vitest, existing `useKeyboardShortcutsBase` hook pattern.

---

## File Structure

```
apps/desktop/src/renderer/src/
├── lib/
│   ├── dom-scanner.ts              — NEW: querySelectorAll + visibility/viewport filters
│   ├── dom-scanner.test.ts         — NEW: unit tests for DOM scanning
│   ├── label-assigner.ts           — NEW: mnemonic-first label algorithm
│   └── label-assigner.test.ts      — NEW: unit tests for label assignment
├── contexts/
│   └── hint-mode/
│       ├── types.ts                — NEW: Hint, HintModeState interfaces
│       ├── context.tsx             — NEW: HintModeProvider + hintModeActiveRef
│       └── index.ts               — NEW: barrel export
├── hooks/
│   ├── use-hint-activation.ts      — NEW: F / Alt+F / Esc key listeners (orchestration lives in context)
│   ├── use-keyboard-shortcuts-base.ts — MODIFY: check hintModeActiveRef early-return
│   ├── use-chord-shortcuts.ts      — MODIFY: check hintModeActiveRef early-return
│   └── index.ts                   — MODIFY: add hint mode exports
├── components/
│   └── hint-overlay/
│       ├── hint-overlay.tsx        — NEW: React portal with positioned badges
│       ├── hint-badge.tsx          — NEW: individual amber badge component
│       └── index.ts               — NEW: barrel export
└── App.tsx                        — MODIFY: add HintModeProvider + HintOverlay
```

---

### Task 1: Types and Interfaces

**Files:**
- Create: `apps/desktop/src/renderer/src/contexts/hint-mode/types.ts`

- [ ] **Step 1: Create hint mode types**

```typescript
export interface HintTarget {
  element: HTMLElement
  label: string
  rect: DOMRect
  text: string
}

export interface HintModeState {
  isActive: boolean
  hints: HintTarget[]
  typedChars: string
}

export interface HintModeContextType {
  state: HintModeState
  activate: () => void
  deactivate: () => void
  typeChar: (char: string) => void
  backspace: () => void
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/contexts/hint-mode/types.ts
git commit -m "feat(hint-mode): add type definitions"
```

---

### Task 2: DOM Scanner

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/dom-scanner.ts`
- Create: `apps/desktop/src/renderer/src/lib/dom-scanner.test.ts`

- [ ] **Step 1: Write failing tests for DOM scanner**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { scanClickableElements } from './dom-scanner'

const HINT_OVERLAY_ID = 'hint-mode-overlay'

const createEl = (
  tag: string,
  attrs: Record<string, string> = {},
  text = ''
): HTMLElement => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  if (text) el.textContent = text
  document.body.appendChild(el)
  return el
}

describe('scanClickableElements', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('finds buttons', () => {
    createEl('button', {}, 'Click me')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
    expect(results[0].tagName).toBe('BUTTON')
  })

  it('finds anchor links', () => {
    createEl('a', { href: '/test' }, 'Link')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=button elements', () => {
    createEl('div', { role: 'button' }, 'Fake button')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=tab elements', () => {
    createEl('div', { role: 'tab' }, 'Tab')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=treeitem elements', () => {
    createEl('div', { role: 'treeitem' }, 'Tree item')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=menuitem elements', () => {
    createEl('div', { role: 'menuitem' }, 'Menu item')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=option elements', () => {
    createEl('div', { role: 'option' }, 'Option')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds tabindex elements (not -1)', () => {
    createEl('div', { tabindex: '0' }, 'Focusable')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('excludes tabindex=-1', () => {
    createEl('div', { tabindex: '-1' }, 'Not focusable')
    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })

  it('finds data-hint elements', () => {
    createEl('span', { 'data-hint': '' }, 'Custom hint')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('excludes disabled elements', () => {
    createEl('button', { disabled: '' }, 'Disabled')
    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })

  it('excludes aria-disabled elements', () => {
    createEl('button', { 'aria-disabled': 'true' }, 'Disabled')
    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })

  it('excludes elements inside hint overlay', () => {
    const overlay = document.createElement('div')
    overlay.id = HINT_OVERLAY_ID
    const btn = document.createElement('button')
    btn.textContent = 'Inside overlay'
    overlay.appendChild(btn)
    document.body.appendChild(overlay)

    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })

  it('returns empty array when no clickable elements exist', () => {
    createEl('div', {}, 'Plain text')
    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests — expect all FAIL**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/lib/dom-scanner.test.ts
```

Expected: FAIL — `dom-scanner` module not found.

- [ ] **Step 3: Implement DOM scanner**

```typescript
const CLICKABLE_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="tab"]',
  '[role="treeitem"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[tabindex]:not([tabindex="-1"])',
  '[data-hint]'
].join(', ')

const HINT_OVERLAY_ID = 'hint-mode-overlay'

const MIN_SIZE = 8

const isVisible = (el: HTMLElement): boolean => {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false
  if (getComputedStyle(el).pointerEvents === 'none') return false
  return true
}

const isInViewport = (rect: DOMRect): boolean => {
  return (
    rect.width >= MIN_SIZE &&
    rect.height >= MIN_SIZE &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  )
}

const isEnabled = (el: HTMLElement): boolean => {
  if (el.hasAttribute('disabled')) return false
  if (el.getAttribute('aria-disabled') === 'true') return false
  return true
}

const isInsideOverlay = (el: HTMLElement): boolean => {
  const overlay = document.getElementById(HINT_OVERLAY_ID)
  return overlay !== null && overlay.contains(el)
}

export const scanClickableElements = (): HTMLElement[] => {
  const candidates = document.querySelectorAll<HTMLElement>(CLICKABLE_SELECTOR)
  const results: HTMLElement[] = []

  for (const el of candidates) {
    if (!isEnabled(el)) continue
    if (isInsideOverlay(el)) continue
    if (!isVisible(el)) continue
    const rect = el.getBoundingClientRect()
    if (!isInViewport(rect)) continue
    results.push(el)
  }

  return results
}

export { HINT_OVERLAY_ID }
```

- [ ] **Step 4: Run tests — expect all PASS**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/lib/dom-scanner.test.ts
```

Note: jsdom doesn't support `offsetParent` or `getBoundingClientRect` with real layout. The visibility/viewport tests will pass because jsdom returns default values (`offsetParent = body`, `getBoundingClientRect = {x:0,y:0,width:0,height:0}`). For zero-size elements, the `MIN_SIZE` filter may reject them in jsdom. If tests fail on size check, mock `getBoundingClientRect` on test elements:

```typescript
const mockRect = (el: HTMLElement, rect: Partial<DOMRect> = {}) => {
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, bottom: 30, right: 100,
    toJSON: () => ({}),
    ...rect
  })
}
```

Add this helper to the test file and call `mockRect(el)` after each `createEl`. Adjust tests accordingly.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/dom-scanner.ts apps/desktop/src/renderer/src/lib/dom-scanner.test.ts
git commit -m "feat(hint-mode): add DOM scanner with visibility filters"
```

---

### Task 3: Label Assigner

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/label-assigner.ts`
- Create: `apps/desktop/src/renderer/src/lib/label-assigner.test.ts`

- [ ] **Step 1: Write failing tests for label assigner**

```typescript
import { describe, it, expect } from 'vitest'
import { assignLabels, extractElementText } from './label-assigner'

const mockElement = (text: string, ariaLabel?: string): HTMLElement => {
  const el = document.createElement('button')
  el.textContent = text
  if (ariaLabel) el.setAttribute('aria-label', ariaLabel)
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, bottom: 30, right: 100,
    toJSON: () => ({})
  })
  return el
}

describe('extractElementText', () => {
  it('returns textContent trimmed', () => {
    const el = mockElement('  Hello World  ')
    expect(extractElementText(el)).toBe('Hello World')
  })

  it('prefers aria-label over textContent', () => {
    const el = mockElement('X', 'Close dialog')
    expect(extractElementText(el)).toBe('Close dialog')
  })

  it('falls back to title attribute', () => {
    const el = document.createElement('button')
    el.setAttribute('title', 'Settings')
    expect(extractElementText(el)).toBe('Settings')
  })

  it('returns empty string when no text found', () => {
    const el = document.createElement('button')
    expect(extractElementText(el)).toBe('')
  })
})

describe('assignLabels', () => {
  it('assigns single-char mnemonic for unique first letters', () => {
    const elements = [mockElement('Inbox'), mockElement('Journal'), mockElement('Tasks')]
    const hints = assignLabels(elements)
    expect(hints.map((h) => h.label)).toEqual(['I', 'J', 'T'])
  })

  it('assigns two-char labels when first letters conflict', () => {
    const elements = [mockElement('Tags'), mockElement('Tasks')]
    const hints = assignLabels(elements)
    expect(hints[0].label).toBe('TA')
    expect(hints[1].label).toBe('TS')
  })

  it('falls back to sequential codes for three-way conflicts with same second letter', () => {
    const elements = [mockElement('AA'), mockElement('AB'), mockElement('AA')]
    const hints = assignLabels(elements)
    const labels = hints.map((h) => h.label)
    expect(labels).toHaveLength(3)
    expect(new Set(labels).size).toBe(3)
  })

  it('assigns sequential codes for elements with no text', () => {
    const el1 = document.createElement('button')
    const el2 = document.createElement('button')
    ;[el1, el2].forEach((el) => {
      el.getBoundingClientRect = () => ({
        x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, bottom: 30, right: 100,
        toJSON: () => ({})
      })
    })
    const hints = assignLabels([el1, el2])
    expect(hints[0].label).toMatch(/^[A-Z]{2}$/)
    expect(hints[1].label).toMatch(/^[A-Z]{2}$/)
    expect(hints[0].label).not.toBe(hints[1].label)
  })

  it('avoids prefix collisions between single and two-char labels', () => {
    const elements = [
      mockElement('Inbox'),
      mockElement('Journal'),
      mockElement(''),
      mockElement('')
    ]
    const hints = assignLabels(elements)
    const singleChars = hints.filter((h) => h.label.length === 1).map((h) => h.label)
    const twoChars = hints.filter((h) => h.label.length === 2).map((h) => h.label)

    for (const sc of singleChars) {
      for (const tc of twoChars) {
        expect(tc.startsWith(sc)).toBe(false)
      }
    }
  })

  it('is case insensitive — labels are uppercase', () => {
    const elements = [mockElement('inbox')]
    const hints = assignLabels(elements)
    expect(hints[0].label).toBe('I')
  })

  it('skips non-ASCII first letters and assigns sequential code', () => {
    const elements = [mockElement('日本語')]
    const hints = assignLabels(elements)
    expect(hints[0].label).toMatch(/^[A-Z]{2}$/)
  })

  it('handles single element', () => {
    const hints = assignLabels([mockElement('Only')])
    expect(hints).toHaveLength(1)
    expect(hints[0].label).toBe('O')
  })

  it('handles empty input', () => {
    const hints = assignLabels([])
    expect(hints).toHaveLength(0)
  })

  it('preserves element references in output', () => {
    const el = mockElement('Test')
    const hints = assignLabels([el])
    expect(hints[0].element).toBe(el)
  })

  it('includes rect in output', () => {
    const hints = assignLabels([mockElement('Test')])
    expect(hints[0].rect).toBeDefined()
    expect(hints[0].rect.width).toBe(100)
  })
})
```

- [ ] **Step 2: Run tests — expect all FAIL**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/lib/label-assigner.test.ts
```

Expected: FAIL — `label-assigner` module not found.

- [ ] **Step 3: Implement label assigner**

```typescript
import type { HintTarget } from '@/contexts/hint-mode/types'

const ASCII_UPPER = /^[A-Z]$/

export const extractElementText = (el: HTMLElement): string => {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel?.trim()) return ariaLabel.trim()

  const textContent = el.textContent?.trim()
  if (textContent) return textContent

  const title = el.getAttribute('title')
  if (title?.trim()) return title.trim()

  return ''
}

const getFirstLetter = (text: string): string | null => {
  const char = text.charAt(0).toUpperCase()
  return ASCII_UPPER.test(char) ? char : null
}

const getSecondLetter = (text: string): string | null => {
  for (let i = 1; i < text.length; i++) {
    const char = text.charAt(i).toUpperCase()
    if (ASCII_UPPER.test(char)) return char
  }
  return null
}

const generateSequentialCode = (
  index: number,
  usedLabels: Set<string>,
  singleCharLabels: Set<string>
): string => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let seqIndex = 0
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = letters[i] + letters[j]
      if (singleCharLabels.has(code[0])) continue
      if (usedLabels.has(code)) continue
      if (seqIndex === index) return code
      seqIndex++
    }
  }
  return 'ZZ'
}

export const assignLabels = (elements: HTMLElement[]): HintTarget[] => {
  if (elements.length === 0) return []

  const texts = elements.map((el) => extractElementText(el))
  const firstLetters = texts.map((t) => getFirstLetter(t))

  // Group by first letter to detect conflicts
  const letterGroups = new Map<string, number[]>()
  const noLetterIndices: number[] = []

  firstLetters.forEach((letter, i) => {
    if (!letter) {
      noLetterIndices.push(i)
      return
    }
    const group = letterGroups.get(letter) ?? []
    group.push(i)
    letterGroups.set(letter, group)
  })

  const labels = new Array<string>(elements.length).fill('')
  const singleCharLabels = new Set<string>()

  // Pass 1: assign single-char labels for unique first letters
  for (const [letter, indices] of letterGroups) {
    if (indices.length === 1) {
      labels[indices[0]] = letter
      singleCharLabels.add(letter)
    }
  }

  // Pass 2: resolve conflicts with first+second letter
  const usedLabels = new Set<string>(singleCharLabels)
  const needsSequential: number[] = []

  for (const [letter, indices] of letterGroups) {
    if (indices.length <= 1) continue

    const twoCharCandidates = new Map<number, string>()
    for (const idx of indices) {
      const second = getSecondLetter(texts[idx])
      if (second) {
        const candidate = letter + second
        twoCharCandidates.set(idx, candidate)
      }
    }

    // Check for two-char conflicts
    const twoCharGroups = new Map<string, number[]>()
    for (const [idx, candidate] of twoCharCandidates) {
      const group = twoCharGroups.get(candidate) ?? []
      group.push(idx)
      twoCharGroups.set(candidate, group)
    }

    for (const [candidate, idxs] of twoCharGroups) {
      if (idxs.length === 1 && !usedLabels.has(candidate)) {
        labels[idxs[0]] = candidate
        usedLabels.add(candidate)
      } else {
        needsSequential.push(...idxs.filter((i) => labels[i] === ''))
      }
    }

    // Elements in this conflict group that had no second letter
    for (const idx of indices) {
      if (labels[idx] === '' && !twoCharCandidates.has(idx)) {
        needsSequential.push(idx)
      }
    }
  }

  // Pass 3: assign sequential codes
  const allNeedSequential = [...noLetterIndices, ...needsSequential].filter((i) => labels[i] === '')
  let seqCounter = 0
  for (const idx of allNeedSequential) {
    const code = generateSequentialCode(seqCounter, usedLabels, singleCharLabels)
    labels[idx] = code
    usedLabels.add(code)
    seqCounter++
  }

  return elements.map((element, i) => ({
    element,
    label: labels[i],
    rect: element.getBoundingClientRect(),
    text: texts[i]
  }))
}
```

- [ ] **Step 4: Run tests — expect all PASS**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/lib/label-assigner.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/label-assigner.ts apps/desktop/src/renderer/src/lib/label-assigner.test.ts
git commit -m "feat(hint-mode): add mnemonic-first label assigner"
```

---

### Task 4: Hint Mode Context

**Files:**
- Create: `apps/desktop/src/renderer/src/contexts/hint-mode/context.tsx`
- Create: `apps/desktop/src/renderer/src/contexts/hint-mode/index.ts`

- [ ] **Step 1: Create the context + provider + module-level ref**

`context.tsx`:

```typescript
import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react'
import type { HintTarget, HintModeState, HintModeContextType } from './types'
import { scanClickableElements, HINT_OVERLAY_ID } from '@/lib/dom-scanner'
import { assignLabels } from '@/lib/label-assigner'

export const hintModeActiveRef: { current: boolean } = { current: false }

const INITIAL_STATE: HintModeState = {
  isActive: false,
  hints: [],
  typedChars: ''
}

const HintModeContext = createContext<HintModeContextType | null>(null)

export const HintModeProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [state, setState] = useState<HintModeState>(INITIAL_STATE)
  const stateRef = useRef(state)
  stateRef.current = state

  const deactivate = useCallback(() => {
    hintModeActiveRef.current = false
    setState(INITIAL_STATE)
  }, [])

  const activate = useCallback(() => {
    if (stateRef.current.isActive) {
      deactivate()
      return
    }

    const elements = scanClickableElements()
    if (elements.length === 0) return

    const hints = assignLabels(elements)
    hintModeActiveRef.current = true
    setState({ isActive: true, hints, typedChars: '' })
  }, [deactivate])

  const typeChar = useCallback(
    (char: string) => {
      const upper = char.toUpperCase()
      const next = stateRef.current.typedChars + upper
      const matching = stateRef.current.hints.filter((h) => h.label.startsWith(next))

      if (matching.length === 0) return

      if (matching.length === 1 && matching[0].label === next) {
        matching[0].element.click()
        matching[0].element.focus()
        deactivate()
        return
      }

      setState((prev) => ({ ...prev, typedChars: next }))
    },
    [deactivate]
  )

  const backspace = useCallback(() => {
    setState((prev) => ({
      ...prev,
      typedChars: prev.typedChars.slice(0, -1)
    }))
  }, [])

  const value: HintModeContextType = { state, activate, deactivate, typeChar, backspace }

  return <HintModeContext.Provider value={value}>{children}</HintModeContext.Provider>
}

export const useHintModeContext = (): HintModeContextType => {
  const ctx = useContext(HintModeContext)
  if (!ctx) throw new Error('useHintModeContext must be inside HintModeProvider')
  return ctx
}
```

`index.ts`:

```typescript
export { HintModeProvider, useHintModeContext, hintModeActiveRef } from './context'
export type { HintTarget, HintModeState, HintModeContextType } from './types'
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/contexts/hint-mode/
git commit -m "feat(hint-mode): add HintModeProvider context with module-level ref"
```

---

### Task 5: Suspend Existing Shortcuts During Hint Mode

**Files:**
- Modify: `apps/desktop/src/renderer/src/hooks/use-keyboard-shortcuts-base.ts` (line 72, inside `handleKeyDown`)
- Modify: `apps/desktop/src/renderer/src/hooks/use-chord-shortcuts.ts` (line 206, inside `handleKeyDown`)

- [ ] **Step 1: Add early-return guard to `use-keyboard-shortcuts-base.ts`**

Add this import near the top of the file (after the existing `import { useEffect, useCallback, useMemo } from 'react'` on line 6):

```typescript
import { hintModeActiveRef } from '@/contexts/hint-mode'
```

Inside `handleKeyDown` (which begins at line 73), add the guard as the FIRST statement of the callback body — before `const target = e.target as HTMLElement`:

```typescript
const handleKeyDown = useCallback(
  (e: KeyboardEvent) => {
    if (hintModeActiveRef.current) return

    const target = e.target as HTMLElement
    // ... rest of existing body unchanged
```

- [ ] **Step 2: Add early-return guard to `use-chord-shortcuts.ts`**

Add this import near the top of the file (after the existing `import { isMac } from './use-keyboard-shortcuts-base'` on line 8):

```typescript
import { hintModeActiveRef } from '@/contexts/hint-mode'
```

Inside the `handleKeyDown` defined in the `useEffect` (which begins at line 206), add the guard as the FIRST statement of the handler body — before `const metaOrCtrl = isMac ? e.metaKey : e.ctrlKey`:

```typescript
const handleKeyDown = (e: KeyboardEvent) => {
  if (hintModeActiveRef.current) return

  const metaOrCtrl = isMac ? e.metaKey : e.ctrlKey
  // ... rest of existing body unchanged
```

- [ ] **Step 3: Run existing keyboard shortcut tests to verify no regressions**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/hooks/use-keyboard-shortcuts-base.test.ts
```

Expected: all existing tests still PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-keyboard-shortcuts-base.ts apps/desktop/src/renderer/src/hooks/use-chord-shortcuts.ts
git commit -m "feat(hint-mode): suspend shortcuts when hint mode is active"
```

---

### Task 6: Hint Activation Hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-hint-activation.ts`

- [ ] **Step 1: Implement the activation hook**

```typescript
import { useEffect } from 'react'
import { useHintModeContext } from '@/contexts/hint-mode'

const isEditorFocused = (): boolean => {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
}

export const useHintActivation = (): void => {
  const { state, activate, deactivate, typeChar, backspace } = useHintModeContext()

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Hint mode is active — handle hint-specific keys
      if (state.isActive) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          deactivate()
          return
        }

        if (e.key === 'Backspace') {
          e.preventDefault()
          e.stopPropagation()
          backspace()
          return
        }

        // Single letter/number input for hint matching
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          e.stopPropagation()
          typeChar(e.key)
          return
        }

        // Swallow all other keys during hint mode
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // Hint mode not active — check activation triggers

      // Alt+F activates from anywhere (including editor)
      if (e.key === 'f' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        e.stopPropagation()
        activate()
        return
      }

      // F activates only when not in an editor/input
      if (e.key === 'f' && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (!isEditorFocused()) {
          e.preventDefault()
          e.stopPropagation()
          activate()
          return
        }
      }

      // Escape blurs editor when in editor (makes F available next)
      if (e.key === 'Escape' && isEditorFocused()) {
        ;(document.activeElement as HTMLElement)?.blur()
      }
    }

    // Capture phase — intercept before other handlers
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [state.isActive, activate, deactivate, typeChar, backspace])
}
```

Key design decisions:
- Uses **capture phase** (`{ capture: true }`) so hint mode intercepts keys before bubble-phase handlers (existing shortcuts, cmdk, chord shortcuts).
- When hint mode is active, swallows all keystrokes — no shortcut leaks through.
- `Alt+F` works from inside editors. Plain `F` only works from app chrome.
- `Escape` in editor blurs the editor (existing behavior preserved; hint mode isn't active so it doesn't interfere).

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-hint-activation.ts
git commit -m "feat(hint-mode): add activation hook with F / Alt+F / Esc handling"
```

---

### Task 7: Hint Badge Component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/hint-overlay/hint-badge.tsx`

- [ ] **Step 1: Implement hint badge**

```typescript
import type { HintTarget } from '@/contexts/hint-mode'

interface HintBadgeProps {
  hint: HintTarget
  typedChars: string
}

export const HintBadge = ({ hint, typedChars }: HintBadgeProps): React.JSX.Element => {
  const isMatching = hint.label.startsWith(typedChars)
  const matchedLength = typedChars.length

  return (
    <span
      style={{
        position: 'fixed',
        top: hint.rect.top - 6,
        left: hint.rect.left - 6,
        zIndex: 2147483647,
        background: '#f59e0b',
        color: '#000',
        fontSize: '11px',
        fontWeight: 700,
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
        padding: '1px 5px',
        borderRadius: '3px',
        lineHeight: 1.3,
        letterSpacing: '0.5px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        pointerEvents: 'none',
        opacity: isMatching ? 1 : 0.3,
        transition: 'opacity 100ms ease'
      }}
    >
      {hint.label.split('').map((char, i) => (
        <span
          key={i}
          style={{ opacity: i < matchedLength && isMatching ? 0.4 : 1 }}
        >
          {char}
        </span>
      ))}
    </span>
  )
}
```

Using inline styles intentionally — this overlay sits outside the app's theme/styling system and needs fixed visual treatment regardless of theme. Avoids coupling to Tailwind/CSS vars.

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/hint-overlay/hint-badge.tsx
git commit -m "feat(hint-mode): add HintBadge component with narrowing feedback"
```

---

### Task 8: Hint Overlay Portal

**Files:**
- Create: `apps/desktop/src/renderer/src/components/hint-overlay/hint-overlay.tsx`
- Create: `apps/desktop/src/renderer/src/components/hint-overlay/index.ts`

- [ ] **Step 1: Implement overlay portal**

`hint-overlay.tsx`:

```typescript
import { createPortal } from 'react-dom'
import { useHintModeContext } from '@/contexts/hint-mode'
import { HINT_OVERLAY_ID } from '@/lib/dom-scanner'
import { HintBadge } from './hint-badge'

export const HintOverlay = (): React.JSX.Element | null => {
  const { state } = useHintModeContext()

  if (!state.isActive) return null

  return createPortal(
    <div
      id={HINT_OVERLAY_ID}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483646,
        pointerEvents: 'none'
      }}
    >
      {state.hints.map((hint, i) => (
        <HintBadge key={i} hint={hint} typedChars={state.typedChars} />
      ))}
    </div>,
    document.body
  )
}
```

`index.ts`:

```typescript
export { HintOverlay } from './hint-overlay'
export { HintBadge } from './hint-badge'
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/hint-overlay/
git commit -m "feat(hint-mode): add HintOverlay portal rendering positioned badges"
```

---

### Task 9: Hint Mode Status Indicator

**Files:**
- Create: `apps/desktop/src/renderer/src/components/hint-overlay/hint-indicator.tsx`
- Modify: `apps/desktop/src/renderer/src/components/hint-overlay/index.ts`

- [ ] **Step 1: Implement status indicator (sibling to chord indicator)**

`hint-indicator.tsx`:

```typescript
import { useHintModeContext } from '@/contexts/hint-mode'
import { cn } from '@/lib/utils'

export const HintIndicator = (): React.JSX.Element | null => {
  const { state } = useHintModeContext()

  if (!state.isActive) return null

  return (
    <div
      className={cn(
        'fixed bottom-4 left-1/2 -translate-x-1/2 z-50',
        'bg-amber-500 text-black',
        'px-4 py-2 rounded-md shadow-lg',
        'animate-in fade-in slide-in-from-bottom-2 duration-200'
      )}
    >
      <div className="flex items-center gap-2 text-sm font-mono font-bold">
        <span>HINT</span>
        {state.typedChars && (
          <kbd className="px-1.5 py-0.5 bg-black/20 rounded text-xs">
            {state.typedChars}
          </kbd>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add to barrel export**

Append to `apps/desktop/src/renderer/src/components/hint-overlay/index.ts`:

```typescript
export { HintIndicator } from './hint-indicator'
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/hint-overlay/
git commit -m "feat(hint-mode): add HINT status indicator"
```

---

### Task 10: Wire Into App

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/hooks/index.ts`

- [ ] **Step 1: Add hint mode exports to hooks barrel**

In `apps/desktop/src/renderer/src/hooks/index.ts`, add after the `use-search` exports:

```typescript
// Hint mode
export * from './use-hint-activation'
```

- [ ] **Step 2: Add HintModeProvider to App.tsx provider tree**

In `App.tsx`, add imports:

```typescript
import { HintModeProvider } from '@/contexts/hint-mode'
import { HintOverlay, HintIndicator } from '@/components/hint-overlay'
import { useHintActivation } from '@/hooks/use-hint-activation'
```

In `AppContent`, add the hook call alongside other keyboard hooks (after `useSearchShortcut(toggleSearch)` on line 143):

```typescript
useHintActivation()
```

In `AppContent`'s return JSX (after `<ChordIndicator isActive={isChordActive} />`):

```tsx
{/* Hint Mode Overlay + Indicator */}
<HintOverlay />
<HintIndicator />
```

Wrap the existing `mainContent` variable's `<TabProvider>` inside `<HintModeProvider>`. In the provider tree (around line 357), change:

```tsx
<TabProvider>
```

to:

```tsx
<HintModeProvider>
  <TabProvider>
```

And the corresponding closing tag from:

```tsx
</TabProvider>
```

to:

```tsx
  </TabProvider>
</HintModeProvider>
```

This places `HintModeProvider` above `TabProvider` so hint mode context is available in `AppContent` where the hook is called.

- [ ] **Step 3: Run typecheck to verify integration**

```bash
cd apps/desktop && pnpm typecheck:web
```

Expected: PASS (no new type errors).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/hooks/index.ts
git commit -m "feat(hint-mode): wire HintModeProvider and overlay into App"
```

---

### Task 11: Manual Smoke Test

**Files:** None — verification only.

- [ ] **Step 1: Start the dev server**

```bash
pnpm dev
```

- [ ] **Step 2: Verify hint mode activation**

1. Focus is on app chrome (click sidebar or press `Escape` if in editor)
2. Press `F` — amber badges should appear on sidebar items, tabs, buttons
3. Verify mnemonic labels: `I` near Inbox, `J` near Journal, `T` near Tasks
4. Type a label character — non-matching badges fade, matching ones narrow
5. Complete a label — element is clicked, hint mode exits
6. Press `F` again → `Escape` — should cancel without clicking

- [ ] **Step 3: Verify Alt+F from editor**

1. Open a note, click into the editor, start typing
2. Press `F` — should type "f" in the editor (not activate hints)
3. Press `Alt+F` — should activate hint mode (leaves editor)
4. Press `Escape` — should cancel hint mode

- [ ] **Step 4: Verify Escape→F flow**

1. Click into editor
2. Press `Escape` — editor should blur
3. Press `F` — hint mode should activate

- [ ] **Step 5: Verify existing shortcuts still work**

1. Press `⌘K` — command palette should open (not interfered with)
2. Press `⌘N` — should create new note
3. Press `Ctrl+Tab` — should switch tabs
4. During hint mode, press `⌘K` — should be swallowed (no palette)

---

### Task 12: Integration Tests

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-hint-activation.test.ts`

- [ ] **Step 1: Write integration tests for the activation flow**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { type ReactNode } from 'react'
import { HintModeProvider, useHintModeContext } from '@/contexts/hint-mode'

const wrapper = ({ children }: { children: ReactNode }) => (
  <HintModeProvider>{children}</HintModeProvider>
)

const mockRect: DOMRect = {
  x: 10, y: 10, width: 100, height: 30,
  top: 10, left: 10, bottom: 40, right: 110,
  toJSON: () => ({})
}

const addButton = (text: string): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.textContent = text
  btn.getBoundingClientRect = () => mockRect
  Object.defineProperty(btn, 'offsetParent', { value: document.body, configurable: true })
  document.body.appendChild(btn)
  return btn
}

describe('HintModeProvider', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('activate scans DOM and assigns labels', () => {
    addButton('Inbox')
    addButton('Journal')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())

    expect(result.current.state.isActive).toBe(true)
    expect(result.current.state.hints).toHaveLength(2)
    expect(result.current.state.hints[0].label).toBe('I')
    expect(result.current.state.hints[1].label).toBe('J')
  })

  it('deactivate resets state', () => {
    addButton('Test')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    expect(result.current.state.isActive).toBe(true)

    act(() => result.current.deactivate())
    expect(result.current.state.isActive).toBe(false)
    expect(result.current.state.hints).toHaveLength(0)
  })

  it('typeChar narrows matches', () => {
    addButton('Tags')
    addButton('Tasks')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    expect(result.current.state.hints[0].label).toBe('TA')
    expect(result.current.state.hints[1].label).toBe('TS')

    act(() => result.current.typeChar('T'))
    expect(result.current.state.typedChars).toBe('T')
  })

  it('typeChar triggers click on unique match', () => {
    const btn = addButton('Inbox')
    const clickSpy = vi.spyOn(btn, 'click')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    act(() => result.current.typeChar('I'))

    expect(clickSpy).toHaveBeenCalledOnce()
    expect(result.current.state.isActive).toBe(false)
  })

  it('backspace removes last typed char', () => {
    addButton('Tags')
    addButton('Tasks')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    act(() => result.current.typeChar('T'))
    expect(result.current.state.typedChars).toBe('T')

    act(() => result.current.backspace())
    expect(result.current.state.typedChars).toBe('')
  })

  it('double activate toggles off', () => {
    addButton('Test')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    expect(result.current.state.isActive).toBe(true)

    act(() => result.current.activate())
    expect(result.current.state.isActive).toBe(false)
  })

  it('activate with no clickable elements is a no-op', () => {
    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    expect(result.current.state.isActive).toBe(false)
  })

  it('ignores non-matching typeChar', () => {
    addButton('Inbox')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    act(() => result.current.typeChar('Z'))

    expect(result.current.state.typedChars).toBe('')
    expect(result.current.state.isActive).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests — expect all PASS**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/hooks/use-hint-activation.test.ts
```

Note: if jsdom `getBoundingClientRect` or `offsetParent` mocking causes issues, adjust the mock helpers.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-hint-activation.test.ts
git commit -m "test(hint-mode): add integration tests for HintModeProvider"
```

---

### Task 13: Run Full Test Suite

**Files:** None — verification only.

- [ ] **Step 1: Run all desktop tests**

```bash
cd apps/desktop && pnpm vitest run
```

Expected: all existing tests pass, new tests pass. Pre-existing failures in websocket.test.ts and folders.test.ts are known — ignore those.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck:node && pnpm typecheck:web
```

Expected: PASS (skip `ipc:check` pre-hook — it's flaky for non-contract changes, see memory on typecheck gotchas).

- [ ] **Step 3: Run lint**

```bash
pnpm lint
```

Expected: PASS.
