// Locator specs: a serializable chain of steps that the in-page `queryAll` resolves. Building a
// spec is pure, so it is unit-tested without a browser.

export type TextMatcher = string | { regex: { source: string; flags: string } }

export type Step =
  | { kind: 'css'; selector: string }
  | { kind: 'role'; role: string; name?: TextMatcher; exact?: boolean }
  | { kind: 'testid'; id: string }
  | { kind: 'text'; text: TextMatcher; exact?: boolean }
  | { kind: 'label'; text: TextMatcher; exact?: boolean }
  | { kind: 'placeholder'; text: TextMatcher; exact?: boolean }
  | { kind: 'filter'; hasText?: TextMatcher; hasNotText?: TextMatcher }
  | { kind: 'nth'; index: number }

export interface LocatorSpec {
  steps: Step[]
}

export function toMatcher(value: string | RegExp): TextMatcher {
  return typeof value === 'string' ? value : { regex: { source: value.source, flags: value.flags } }
}

export const rootSpec: LocatorSpec = { steps: [] }

export function append(spec: LocatorSpec, step: Step): LocatorSpec {
  return { steps: [...spec.steps, step] }
}

export interface ByRoleOptions {
  name?: string | RegExp
  exact?: boolean
}

export interface TextOptions {
  exact?: boolean
}

export const specs = {
  css: (spec: LocatorSpec, selector: string): LocatorSpec =>
    append(spec, { kind: 'css', selector }),
  role: (spec: LocatorSpec, role: string, options: ByRoleOptions = {}): LocatorSpec =>
    append(spec, {
      kind: 'role',
      role,
      name: options.name === undefined ? undefined : toMatcher(options.name),
      exact: options.exact
    }),
  testId: (spec: LocatorSpec, id: string): LocatorSpec => append(spec, { kind: 'testid', id }),
  text: (spec: LocatorSpec, text: string | RegExp, options: TextOptions = {}): LocatorSpec =>
    append(spec, { kind: 'text', text: toMatcher(text), exact: options.exact }),
  label: (spec: LocatorSpec, text: string | RegExp, options: TextOptions = {}): LocatorSpec =>
    append(spec, { kind: 'label', text: toMatcher(text), exact: options.exact }),
  placeholder: (spec: LocatorSpec, text: string | RegExp, options: TextOptions = {}): LocatorSpec =>
    append(spec, { kind: 'placeholder', text: toMatcher(text), exact: options.exact }),
  filter: (
    spec: LocatorSpec,
    options: { hasText?: string | RegExp; hasNotText?: string | RegExp }
  ): LocatorSpec =>
    append(spec, {
      kind: 'filter',
      hasText: options.hasText === undefined ? undefined : toMatcher(options.hasText),
      hasNotText: options.hasNotText === undefined ? undefined : toMatcher(options.hasNotText)
    }),
  nth: (spec: LocatorSpec, index: number): LocatorSpec => append(spec, { kind: 'nth', index })
}

/** A readable form for error messages, shaped like Playwright's `locator.toString()`. */
export function describeSpec(spec: LocatorSpec): string {
  if (spec.steps.length === 0) return 'page'
  const matcher = (value: TextMatcher | undefined): string =>
    value === undefined
      ? ''
      : typeof value === 'string'
        ? JSON.stringify(value)
        : `/${value.regex.source}/${value.regex.flags}`
  return spec.steps
    .map((step) => {
      switch (step.kind) {
        case 'css':
          return `locator(${JSON.stringify(step.selector)})`
        case 'role':
          return `getByRole(${JSON.stringify(step.role)}${step.name === undefined ? '' : `, { name: ${matcher(step.name)} }`})`
        case 'testid':
          return `getByTestId(${JSON.stringify(step.id)})`
        case 'text':
          return `getByText(${matcher(step.text)})`
        case 'label':
          return `getByLabel(${matcher(step.text)})`
        case 'placeholder':
          return `getByPlaceholder(${matcher(step.text)})`
        case 'filter':
          return `filter({ hasText: ${matcher(step.hasText)} })`
        case 'nth':
          return step.index === 0 ? 'first()' : step.index === -1 ? 'last()' : `nth(${step.index})`
        default:
          throw new Error(`unknown locator step ${JSON.stringify(step)}`)
      }
    })
    .join('.')
}
