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
