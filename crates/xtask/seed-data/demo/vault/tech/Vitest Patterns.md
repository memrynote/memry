---
tags:
  - tech/typescript
  - tests
  - reference
project:
  - memrynote Launch
area: Learning
status: reference
language: typescript
level: intermediate
---
The handful of things I re-look-up every time.

## Mock a module, keep one real export

```ts
vi.mock('./logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logger')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
```

## Fake timers without deadlocking async code

```ts
vi.useFakeTimers({ shouldAdvanceTime: true })
await vi.advanceTimersByTimeAsync(1_000)
```

## Rules I learned the hard way

| Rule | Why |
|------|-----|
| Reset module state in `beforeEach` | Singletons leak between files, not just tests |
| Never assert on a snapshot you did not read | It will happily record a bug |
| One behavior per test name | A failing name should tell you the bug |
| Prefer a real object over a mock | A mock only proves the mock works |

> [!warning] Partial mocks are a trap
> Mock a module partially and every *new* export silently becomes `undefined` for that file. Prefer building a real fixture.

See also: [[TypeScript Patterns]], [[Electron Gotchas]].

#tech/typescript #tests
