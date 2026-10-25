// Playwright key names to W3C WebDriver key codepoints. Pure; unit-tested without a browser.

const NAMED: Record<string, string> = {
  Backspace: '\uE003',
  Tab: '\uE004',
  Enter: '\uE007',
  Return: '\uE006',
  Shift: '\uE008',
  Control: '\uE009',
  Alt: '\uE00A',
  Pause: '\uE00B',
  Escape: '\uE00C',
  Esc: '\uE00C',
  Space: ' ',
  PageUp: '\uE00E',
  PageDown: '\uE00F',
  End: '\uE010',
  Home: '\uE011',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
  Insert: '\uE016',
  Delete: '\uE017',
  Meta: '\uE03D',
  Command: '\uE03D',
  Cmd: '\uE03D',
  Ctrl: '\uE009',
  Option: '\uE00A'
}
for (let n = 1; n <= 12; n += 1) NAMED[`F${n}`] = String.fromCodePoint(0xe031 + n - 1)

export const MODIFIERS = new Set(['\uE008', '\uE009', '\uE00A', '\uE03D'])

/**
 * `ControlOrMeta` is Meta on macOS and Control elsewhere, as in Playwright.
 * @param platform a `process.platform` value
 */
export function keyToCodepoint(key: string, platform: string = process.platform): string {
  if (key === 'ControlOrMeta') return platform === 'darwin' ? NAMED.Meta : NAMED.Control
  const named = NAMED[key]
  if (named !== undefined) return named
  const code = /^Key([A-Z])$/.exec(key)
  if (code) return code[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(key)
  if (digit) return digit[1]
  if (Array.from(key).length === 1) return key
  throw new Error(`Unknown key "${key}"`)
}

/**
 * `Meta+Shift+a` to the codepoints to press in order. A lone `+` is the plus key.
 */
export function parseKeyCombo(combo: string, platform: string = process.platform): string[] {
  if (combo === '+') return ['+']
  const parts = combo.split('+')
  // `Control++` is Control and the plus key: the empty part left by the split stands for it.
  const tokens: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === '' && index === parts.length - 1 && tokens.length > 0) tokens.push('+')
    else if (parts[index] !== '') tokens.push(parts[index])
  }
  return tokens.map((token) => keyToCodepoint(token, platform))
}

export interface KeyAction {
  type: 'keyDown' | 'keyUp'
  value: string
}

/** The W3C key actions of one press: modifiers down, key down and up, modifiers up. */
export function pressActions(combo: string, platform: string = process.platform): KeyAction[] {
  const codepoints = parseKeyCombo(combo, platform)
  const key = codepoints[codepoints.length - 1]
  const modifiers = codepoints.slice(0, -1)
  return [
    ...modifiers.map((value) => ({ type: 'keyDown' as const, value })),
    { type: 'keyDown', value: key },
    { type: 'keyUp', value: key },
    ...modifiers.toReversed().map((value) => ({ type: 'keyUp' as const, value }))
  ]
}

/** The key actions that type `text` character by character; `\n` is Enter. */
export function typeActions(text: string): KeyAction[] {
  return Array.from(text).flatMap((char) => {
    const value = char === '\n' ? NAMED.Enter : char
    return [
      { type: 'keyDown' as const, value },
      { type: 'keyUp' as const, value }
    ]
  })
}
