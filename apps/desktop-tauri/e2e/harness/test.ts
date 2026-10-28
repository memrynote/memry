// Playwright-shaped `test()` over mocha. A test declares the fixtures it wants by destructuring
// its first parameter, as in Playwright; only those are built, and they are torn down in
// reverse order after the test.
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { browser } from '@wdio/globals'

import { TEST_TIMEOUT_MS } from './budgets'
import { HarnessError } from './errors'
import { removeDir } from './remove-dir'
import { expect } from './pw-compat/expect'
import { Page } from './pw-compat/page'
import { type FreshOptions, type TauriApp, dispose, fresh } from './tauri-lifecycle'

const FIXTURE_VAULT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/test-vault')

export interface Fixtures {
  /** The lifecycle handle of instance A (the only instance in the single-app config). */
  app: TauriApp
  page: Page
  /** A temp copy of `e2e/fixtures/test-vault`; the vault of instance A. */
  testVaultPath: string
  /** An empty vault for instance B. */
  vaultPathB: string
  deviceId: string
  /** The sync server the apps use; null until a fixture sets one. */
  syncServerUrl: string | null
  /** Instance B; multiremote config only. */
  appB: TauriApp
  pageB: Page
}

type Built = { value: unknown; teardown?: () => Promise<void> }
type Get = (name: string) => unknown
interface Recipe {
  needs: string[]
  build: (get: Get) => Promise<Built>
}

/** Launch options of the current file, set with `test.use`. */
let launchOptions: Pick<
  FreshOptions,
  'syncServerUrl' | 'extraEnv' | 'keepWindowRect' | 'startupFails'
> = {}

interface MultiBrowser {
  isMultiremote?: boolean
  getInstance?(name: string): never
}

function isMulti(): boolean {
  return (browser as unknown as MultiBrowser).isMultiremote === true
}

function instance(label: 'A' | 'B') {
  if (!isMulti()) {
    if (label === 'B')
      throw new HarnessError('appB and pageB need the multiremote config (test:e2e:multi)')
    return browser
  }
  return (browser as unknown as MultiBrowser).getInstance!(label)
}

function tempVault(prefix: string, { empty }: { empty: boolean }): Built {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const vault = join(root, 'vault')
  if (empty) {
    for (const dir of ['.memry', 'notes', 'journal'])
      mkdirSync(join(vault, dir), { recursive: true })
  } else {
    cpSync(FIXTURE_VAULT, vault, { recursive: true })
  }
  return {
    value: vault,
    teardown: async () => removeDir(root)
  }
}

/** What each built-in fixture needs first, and how to build it. */
const BASE_RECIPES: Record<string, Recipe> = {
  testVaultPath: { needs: [], build: async () => tempVault('memry-e2e-vault-', { empty: false }) },
  vaultPathB: { needs: [], build: async () => tempVault('memry-e2e-vault-b-', { empty: true }) },
  syncServerUrl: { needs: [], build: async () => ({ value: null }) },
  deviceId: { needs: ['app'], build: async (get) => ({ value: (get('app') as TauriApp).device }) },
  app: {
    needs: ['testVaultPath', 'syncServerUrl'],
    build: async (get) => {
      const app = await fresh(instance('A') as never, {
        ...launchOptions,
        syncServerUrl: (get('syncServerUrl') as string | null) ?? launchOptions.syncServerUrl,
        label: isMulti() ? 'A' : undefined,
        testVaultPath: get('testVaultPath') as string
      })
      return { value: app, teardown: () => dispose(app) }
    }
  },
  page: {
    needs: ['app'],
    build: async (get) => ({ value: new Page((get('app') as TauriApp).executor as never) })
  },
  appB: {
    needs: ['vaultPathB', 'syncServerUrl'],
    build: async (get) => {
      const app = await fresh(instance('B') as never, {
        ...launchOptions,
        syncServerUrl: (get('syncServerUrl') as string | null) ?? launchOptions.syncServerUrl,
        label: 'B',
        testVaultPath: get('vaultPathB') as string
      })
      return { value: app, teardown: () => dispose(app) }
    }
  },
  pageB: {
    needs: ['appB'],
    build: async (get) => ({ value: new Page((get('appB') as TauriApp).executor as never) })
  }
}

/** The destructured names of `fn`'s first parameter, `({ app, page: p }) =>` to `['app', 'page']`. */
export function fixtureNames(fn: (...args: never[]) => unknown): string[] {
  const match = /^(?:async\s*)?(?:function\s*\w*\s*)?\(?\s*\{([^}]*)\}/.exec(fn.toString())
  if (!match) return []
  return match[1]
    .split(',')
    .map((part) => part.trim().split(/[:=\s]/)[0])
    .filter(Boolean)
}

/** A Playwright-style fixture: set up, `await use(value)`, tear down. */
type FixtureDef<V, D> = (deps: D, use: (value: V) => Promise<void>) => Promise<void>

/** Wraps a Playwright-style fixture; a dependency named like the fixture is the one it overrides. */
function recipeOf(name: string, def: FixtureDef<unknown, never>): Recipe {
  const needs = fixtureNames(def as never).map((need) => (need === name ? `${name}#base` : need))
  return {
    needs,
    build: async (get) => {
      const deps = Object.fromEntries(needs.map((need) => [need.replace('#base', ''), get(need)]))
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      let provide!: (value: unknown) => void
      const provided = new Promise<unknown>((resolve) => {
        provide = resolve
      })
      const running = Promise.resolve(
        (def as never as FixtureDef<unknown, unknown>)(deps, async (value) => {
          provide(value)
          await released
        })
      )
      const value = await Promise.race([
        provided,
        running.then(() => {
          throw new HarnessError(`fixture "${name}" finished without calling use()`)
        })
      ])
      return {
        value,
        teardown: async () => {
          release()
          await running
        }
      }
    }
  }
}

let current: Mocha.Context | undefined

async function runWithFixtures(
  recipes: Record<string, Recipe>,
  fn: (fixtures: never) => unknown
): Promise<void> {
  const built = new Map<string, Built>()
  const order: string[] = []
  const get = (name: string): unknown => built.get(name)?.value

  const build = async (name: string): Promise<void> => {
    if (built.has(name)) return
    const recipe = recipes[name]
    if (!recipe) throw new HarnessError(`unknown fixture "${name}"`)
    for (const need of recipe.needs) await build(need)
    built.set(name, await recipe.build(get))
    order.push(name)
  }

  try {
    for (const name of fixtureNames(fn)) await build(name)
    const fixtures = Object.fromEntries(
      [...built].filter(([name]) => !name.includes('#')).map(([name, entry]) => [name, entry.value])
    )
    await fn(fixtures as never)
  } finally {
    for (const name of order.toReversed()) {
      try {
        await built.get(name)?.teardown?.()
      } catch (error) {
        console.warn(`fixture ${name} teardown failed: ${String(error)}`)
      }
    }
  }
}

interface TestApi<F> {
  (name: string, fn: (fixtures: F) => Promise<void> | void): Mocha.Test
  describe: typeof describe & { serial: typeof describe }
  beforeEach: typeof beforeEach
  afterEach: typeof afterEach
  beforeAll: typeof before
  afterAll: typeof after
  skip: {
    (name: string, fn: (fixtures: F) => Promise<void> | void): void
    (condition: boolean, reason?: string): void
  }
  slow(): void
  setTimeout(ms: number): void
  use(
    options: Pick<FreshOptions, 'syncServerUrl' | 'extraEnv' | 'keepWindowRect' | 'startupFails'>
  ): void
  /** Adds or overrides fixtures, as Playwright's `test.extend`. */
  extend<T extends Record<string, unknown>>(defs: {
    [K in keyof T]: FixtureDef<T[K], F & T>
  }): TestApi<F & T>
}

function createTest<F>(recipes: Record<string, Recipe>): TestApi<F> {
  const api = ((name: string, fn: (fixtures: F) => Promise<void> | void) =>
    it(name, async function (this: Mocha.Context) {
      // oxlint-disable-next-line typescript/no-this-alias -- Mocha's context is only reachable as `this`; skip, slow and setTimeout act on it
      current = this
      try {
        await runWithFixtures(recipes, fn)
      } finally {
        current = undefined
      }
    })) as TestApi<F>

  const describeApi = ((name: string, fn: () => void) =>
    describe(name, fn)) as TestApi<F>['describe']
  describeApi.serial = describeApi
  api.describe = describeApi
  api.beforeEach = beforeEach
  api.afterEach = afterEach
  api.beforeAll = before
  api.afterAll = after
  api.skip = (first: string | boolean) => {
    if (typeof first === 'string') it.skip(first, () => {})
    else if (first) current?.skip()
  }
  api.slow = () => {
    current?.timeout(TEST_TIMEOUT_MS * 3)
  }
  api.setTimeout = (ms: number) => {
    current?.timeout(ms)
  }
  api.use = (options) => {
    launchOptions = { ...launchOptions, ...options }
  }
  api.extend = (defs) => {
    const next = { ...recipes }
    for (const [name, def] of Object.entries(defs)) {
      if (next[name]) next[`${name}#base`] = next[name]
      next[name] = recipeOf(name, def as never)
    }
    return createTest(next) as never
  }
  return api
}

export const test = createTest<Fixtures>(BASE_RECIPES)
export { expect }
