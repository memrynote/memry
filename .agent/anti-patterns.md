# Anti-patterns

Things to avoid in this codebase.

## TypeScript

- **Never** suppress errors with `as any`, `@ts-ignore`, or `@ts-expect-error`
- **Never** use empty catch blocks `catch(e) {}`

## Architecture

- **Never** access Node.js APIs from renderer process
- **Never** hardcode file paths - use path utilities from `src/main/lib/paths.ts`

## Git

- **Never** commit without explicit user request
- **Never** delete failing tests to make builds pass

## Why These Matter

| Anti-pattern | Consequence |
|--------------|-------------|
| `as any` | Hides bugs, defeats type safety |
| Empty catch | Silent failures, debugging nightmares |
| Node.js in renderer | Breaks Electron security model |
| Hardcoded paths | Breaks on different OSes |
