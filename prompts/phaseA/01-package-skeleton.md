# Task 01: Scaffold `@memry/i18n` workspace package

> **Plan:** Task 1 (Create `packages/i18n` Package Skeleton)
> **Depends on:** Tasks 0a, 0b (preflight passed)
> **Dependents:** All later tasks import from this package

## Pre-flight check

```bash
pwd                                       # ../memry-i18n-phase-a
git status                                # clean
ls packages/                              # see existing packages: contracts, shared, db-schema, etc.
cat packages/contracts/package.json | head -20   # for reference: source-pointing exports pattern
```

## Your job

Create a new workspace package at `packages/i18n` that mirrors memry's existing package conventions: `"type": "module"`, source-pointing exports (no build step), TypeScript-only, depends on `@memry/contracts` for `LocaleSchema`/`Locale` (added in Task 03).

## Steps

1. Create directories:

```bash
mkdir -p packages/i18n/src/shared
mkdir -p packages/i18n/src/main
mkdir -p packages/i18n/src/renderer
mkdir -p packages/i18n/src/locales/en
mkdir -p packages/i18n/src/locales/tr
mkdir -p packages/i18n/src/locales/ar
```

2. Create `packages/i18n/package.json`:

```json
{
  "name": "@memry/i18n",
  "version": "0.1.0",
  "private": true,
  "license": "GPL-3.0",
  "type": "module",
  "exports": {
    "./main": "./src/main/index.ts",
    "./renderer": "./src/renderer/index.ts",
    "./shared": "./src/shared/index.ts",
    "./locales": "./src/locales/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@memry/typescript-config": "workspace:*"
  },
  "dependencies": {
    "@memry/contracts": "workspace:*",
    "i18next": "^23.16.0",
    "react-i18next": "^15.4.0",
    "i18next-icu": "^2.3.0",
    "i18next-resources-to-backend": "^1.2.1",
    "intl-messageformat": "^10.7.0",
    "zod": "^4.3.4"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

(Replace `react-i18next` version with whatever Task 0b recorded if different.)

3. Create `packages/i18n/tsconfig.json`:

```json
{
  "extends": "@memry/typescript-config/node.json",
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "**/*.test.tsx"],
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "baseUrl": ".",
    "resolveJsonModule": true,
    "esModuleInterop": true
  }
}
```

4. Create `packages/i18n/src/index.ts` (placeholder so the package resolves):

```ts
export { } // placeholder; real exports live in /main, /renderer, /shared
```

5. Install:

```bash
pnpm install
```

6. Verify the workspace picks up the new package:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes (no source files yet, only placeholder).

7. Commit:

```bash
git add packages/i18n/
git commit -m "feat(i18n): scaffold @memry/i18n package skeleton"
```

## Exit criteria

- [ ] `packages/i18n/package.json` exists with the exports field above
- [ ] `packages/i18n/tsconfig.json` exists
- [ ] `pnpm install` succeeded; lockfile updated
- [ ] `pnpm --filter @memry/i18n typecheck` passes
- [ ] One commit created

## Skills to use

None — this is package scaffolding.

## Report back

```
✅ Task 01 complete.
Commit SHA: <abbrev>
pnpm install: success
typecheck: passes
Next: Task 02 (install deps into desktop)
```
