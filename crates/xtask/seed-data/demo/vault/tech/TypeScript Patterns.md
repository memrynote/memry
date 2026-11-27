---
tags:
  - tech/typescript
  - reference
area: Learning
language: typescript
level: advanced
status: active
---
## Discriminated unions for IPC

```typescript
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

function parse(json: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(json) }
  } catch (e) {
    return { ok: false, error: e as Error }
  }
}
```

## Branded types for IDs

```typescript
type NoteId = string & { readonly _brand: unique symbol }
const asNoteId = (s: string): NoteId => s as NoteId
```

## Why I don't use `any`

Because the moment I do, I've thrown away the only reason to write TypeScript. Use `unknown` and refine.

Linked: [[Drizzle ORM]] for type inference details, [[memrynote Architecture]] for the IPC boundary.

#tech/typescript #reference
