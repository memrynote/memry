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

export interface HintModeActions {
  activate: () => void
  deactivate: () => void
  typeChar: (char: string) => void
  backspace: () => void
}

export interface HintModeContextType extends HintModeActions {
  state: HintModeState
}
