# Code Style

## Formatting (Prettier)

```yaml
singleQuote: true
semi: false
printWidth: 100
trailingComma: none
```

## TypeScript

- Strict mode enabled
- **NEVER** use `as any`, `@ts-ignore`, `@ts-expect-error`
- Define interfaces for props with `Props` suffix

## React Components

Standard pattern: explicit props interface + function declaration

```tsx
export interface TaskItemProps {
  id: string
  onComplete: (id: string) => void
}

export function TaskItem({ id, onComplete }: TaskItemProps) {
  const handleComplete = useCallback(() => onComplete(id), [id, onComplete])
  return <div onClick={handleComplete}>{id}</div>
}

// Performance-critical components: use memo
export const ContentArea = memo(function ContentArea({ ... }: ContentAreaProps) { ... })
```

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `task-section.tsx`, `vault-handlers.ts` |
| Components | PascalCase | `TaskItem`, `ContentArea` |
| Event handlers | `handle` prefix | `handleClick`, `handleKeyDown` |
| Props interfaces | `Props` suffix | `TaskItemProps` |
| IPC channels | Namespaced | `NotesChannels.invoke.CREATE` |

## Import Order

1. React & hooks: `import { useState } from 'react'`
2. External libs: `import { z } from 'zod'`
3. Path aliases: `@/lib`, `@/components`, `@/hooks`
4. Shared: `@shared/contracts`, `@shared/db`
5. Local: `./types`, `./utils`
