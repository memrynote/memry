# i18n Phase C Graph Namespace Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate graph feature UI copy to a new `graph.json` namespace, with English populated and Turkish/Arabic namespace files left as `{}` for fallback.

**Architecture:** Phase C graph is a renderer-only namespace migration on top of Phase A/B i18n infrastructure. Add `graph` to the i18n namespace registry and resource map, create locale files, then replace user-facing graph strings with `useT('graph')` calls while preserving user content such as note titles, tag names, and stored node labels. No IPC, main-process, error namespace, menu namespace, codemod, or broad RTL cleanup work is included.

**Tech Stack:** TypeScript, React 19, Electron renderer, `react-i18next`, `@memry/i18n`, Vitest, Testing Library, Sigma/Graphology graph UI.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Depends on:** Phase A i18n infrastructure and Phase B common namespace merged or present in this branch. Required files include `packages/i18n/src/renderer/use-t.ts`, `packages/i18n/src/shared/config.ts`, and `packages/i18n/src/locales/index.ts`.

**Out of scope:**
- Phase D `errors.json` and `menu.json` migrations.
- Phase E `pnpm i18n:check`, ESLint untranslated-string rule, and Tailwind logical-property codemod.
- Translating Turkish or Arabic graph content. `packages/i18n/src/locales/tr/graph.json` and `packages/i18n/src/locales/ar/graph.json` stay literal `{}`.
- Translating user content: note titles, project names, task names, tag text, graph node labels derived from user data, and graph edge labels from stored content.
- Refactoring graph rendering, Sigma behavior, graph data contracts, or settings persistence.

---

## Files

### Inspect before editing

- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- `apps/desktop/src/renderer/src/components/graph/graph-page.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-canvas.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-context-menu.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-control-panel.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-events.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-filters.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-search.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-tooltip.tsx`
- `apps/desktop/src/renderer/src/components/graph/local-graph-panel.tsx`
- `apps/desktop/src/renderer/src/hooks/use-graph-data.ts`
- `apps/desktop/src/renderer/src/hooks/use-graph-filters.ts`
- `apps/desktop/src/renderer/src/hooks/use-graph-settings.ts`
- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/locales/index.ts`

### Create

- `packages/i18n/src/locales/en/graph.json`
- `packages/i18n/src/locales/tr/graph.json`
- `packages/i18n/src/locales/ar/graph.json`
- `packages/i18n/src/locales/graph-namespace.test.ts`
- `apps/desktop/src/renderer/src/components/graph/graph-page.i18n.test.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-controls.i18n.test.tsx`

### Modify

- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/locales/index.ts`
- `apps/desktop/src/renderer/src/components/graph/graph-page.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-canvas.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-context-menu.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-control-panel.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-events.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-filters.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-search.tsx`
- `apps/desktop/src/renderer/src/components/graph/graph-tooltip.tsx`
- `apps/desktop/src/renderer/src/components/graph/local-graph-panel.tsx`

---

## Translation Key Shape

Use namespace `graph.json` and `useT('graph')`.

Populate `packages/i18n/src/locales/en/graph.json` with this shape. Adjust only if live code inspection finds an additional graph-only user-facing string.

```json
{
  "page": {
    "loading": "Loading graph...",
    "load-failed": "Failed to load graph data",
    "try-again": "Try again",
    "aria-label": "Knowledge graph with {nodeCount, plural, one {# node} other {# nodes}} and {edgeCount, plural, one {# connection} other {# connections}}{summary, select, none {.} other {: {summary}.}}",
    "nodes-list-label": "Graph nodes",
    "node-list-item": "{label} ({type})"
  },
  "empty": {
    "title": "Your knowledge graph",
    "description": "Connections between your notes, tasks, and projects will appear here as an interactive graph.",
    "link-title": "Link your notes",
    "link-description": "Use [[wikilinks]] to connect ideas across notes",
    "discover-title": "Discover patterns",
    "discover-description": "As connections grow, clusters and themes will emerge naturally"
  },
  "entity": {
    "note": "note",
    "notes": "notes",
    "journal": "journal",
    "journals": "journals",
    "task": "task",
    "tasks": "tasks",
    "project": "project",
    "projects": "projects",
    "tag": "tag",
    "tags": "tags",
    "orphan": "orphan",
    "orphans": "orphans",
    "unresolved": "unresolved"
  },
  "summary": {
    "node-type-count": "{count} {label}"
  },
  "control": {
    "show-settings": "Graph settings",
    "hide-settings": "Hide settings",
    "reset-filters": "Reset filters",
    "filters": "Filters",
    "display": "Display",
    "show-labels": "Show labels",
    "focus-depth": "depth {depth}",
    "clear-focus": "Clear focused node"
  },
  "filter": {
    "notes": "Notes",
    "journals": "Journals",
    "tasks": "Tasks",
    "projects": "Projects",
    "tags": "Tags",
    "orphans": "Orphans",
    "toggle-entity": "Toggle {label}",
    "toggle-orphans": "Toggle orphan nodes"
  },
  "search": {
    "placeholder": "Search nodes...",
    "clear": "Clear graph search"
  },
  "context-menu": {
    "untitled": "Untitled",
    "focus-node": "Focus on this node",
    "open-new-tab": "Open in new tab",
    "create-note": "Create note",
    "copy-title": "Copy title"
  },
  "tooltip": {
    "connection-count": "{count, plural, one {# connection} other {# connections}}",
    "more-tags": "+{count}"
  },
  "local-panel": {
    "loading": "Loading graph...",
    "empty": "No connections found",
    "open-full": "Open full graph",
    "close": "Close graph"
  }
}
```

TR/AR files:

```json
{}
```

---

## Task 1: Verify Base and Inventory Current Graph Strings

**Files:**
- Inspect only: graph component and hook files listed above

- [ ] **Step 1: Verify clean scope**

Run:

```bash
git status --short
```

Expected: no changes in `docs/superpowers/plans/2026-04-29-i18n-phase-c-graph.md` unless resuming this plan, and no unrelated files staged. Do not revert other agents' changes.

- [ ] **Step 2: Confirm graph string inventory**

Run:

```bash
rg -n "'[^']*[A-Za-z][^']*'|\"[^\"]*[A-Za-z][^\"]*\"|>[^<{]*[A-Za-z][^<{]*<" apps/desktop/src/renderer/src/components/graph apps/desktop/src/renderer/src/hooks/use-graph-*.ts
```

Expected: hardcoded graph strings in page loading/error/empty UI, controls, filters, search placeholders, context menu actions, tooltip labels, local graph panel titles, and `Untitled` tab fallback. Hooks should have no user-facing strings.

- [ ] **Step 3: Confirm i18n namespace registry shape**

Run:

```bash
sed -n '1,140p' packages/i18n/src/shared/config.ts
sed -n '1,180p' packages/i18n/src/shared/types.ts
sed -n '1,180p' packages/i18n/src/locales/index.ts
```

Expected: static `I18N_NAMESPACES`, typed `Resources`, and static `RESOURCES` map that need a `graph` entry.

---

## Task 2: Add the `graph` Locale Namespace

**Files:**
- Create: `packages/i18n/src/locales/en/graph.json`
- Create: `packages/i18n/src/locales/tr/graph.json`
- Create: `packages/i18n/src/locales/ar/graph.json`
- Modify: `packages/i18n/src/shared/config.ts`
- Modify: `packages/i18n/src/shared/types.ts`
- Modify: `packages/i18n/src/locales/index.ts`

- [ ] **Step 1: Create locale files**

Create `packages/i18n/src/locales/en/graph.json` with the key shape above.

Create `packages/i18n/src/locales/tr/graph.json`:

```json
{}
```

Create `packages/i18n/src/locales/ar/graph.json`:

```json
{}
```

Expected: English contains all graph UI keys; Turkish/Arabic are empty objects so missing keys fall back to English.

- [ ] **Step 2: Register namespace**

In `packages/i18n/src/shared/config.ts`, add `'graph'` to `I18N_NAMESPACES` after existing feature namespaces. Keep `DEFAULT_NAMESPACE` as `'common'`.

Expected:

```ts
export const I18N_NAMESPACES = [
  'common',
  'inbox',
  'notes',
  'journal',
  'calendar',
  'settings',
  'errors',
  'menu',
  'graph'
] as const
```

- [ ] **Step 3: Add typed resource**

In `packages/i18n/src/shared/types.ts`, import English graph JSON and add it to `Resources`.

Expected:

```ts
import type graph from '../locales/en/graph.json'

export interface Resources {
  common: typeof common
  inbox: typeof inbox
  notes: typeof notes
  journal: typeof journal
  calendar: typeof calendar
  settings: typeof settings
  errors: typeof errors
  menu: typeof menu
  graph: typeof graph
}
```

- [ ] **Step 4: Add resource exports**

In `packages/i18n/src/locales/index.ts`, import all three graph files and add `graph` to each locale in `RESOURCES`.

Expected:

```ts
import enGraph from './en/graph.json'
import trGraph from './tr/graph.json'
import arGraph from './ar/graph.json'
```

and each locale map includes `graph: enGraph`, `graph: trGraph`, or `graph: arGraph`.

- [ ] **Step 5: Verify package typecheck**

Run:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: pass; `useT('graph')` is now accepted by TypeScript.

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/src/locales/en/graph.json packages/i18n/src/locales/tr/graph.json packages/i18n/src/locales/ar/graph.json packages/i18n/src/shared/config.ts packages/i18n/src/shared/types.ts packages/i18n/src/locales/index.ts
git commit -m "feat(i18n): add graph locale namespace"
```

---

## Task 3: Add Namespace Fallback Tests

**Files:**
- Create: `packages/i18n/src/locales/graph-namespace.test.ts`

- [ ] **Step 1: Write tests before component migration**

Create `packages/i18n/src/locales/graph-namespace.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../renderer'
import { I18N_NAMESPACES } from '../shared/config'
import { RESOURCES } from '.'

describe('graph namespace resources', () => {
  it('registers graph as a typed namespace', () => {
    expect(I18N_NAMESPACES).toContain('graph')
  })

  it('populates English and leaves Turkish/Arabic as fallback-only empty objects', () => {
    expect(RESOURCES.en.graph.page.loading).toBe('Loading graph...')
    expect(RESOURCES.tr.graph).toEqual({})
    expect(RESOURCES.ar.graph).toEqual({})
  })

  it('falls back to English graph strings for Turkish and Arabic', async () => {
    const tr = await createRendererI18n({ locale: 'tr' })
    const ar = await createRendererI18n({ locale: 'ar' })

    expect(tr.t('graph:page.loading')).toBe('Loading graph...')
    expect(ar.t('graph:context-menu.copy-title')).toBe('Copy title')
  })
})
```

- [ ] **Step 2: Run focused test**

Run:

```bash
pnpm --filter @memry/i18n test -- graph-namespace.test.ts
```

Expected: pass. If `@memry/i18n` does not support filename filtering, run `pnpm --filter @memry/i18n test` and expect all i18n tests to pass.

- [ ] **Step 3: Commit**

```bash
git add packages/i18n/src/locales/graph-namespace.test.ts
git commit -m "test(i18n): cover graph namespace fallback"
```

---

## Task 4: Migrate Graph Page States and Accessibility Copy

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/graph/graph-page.tsx`
- Create: `apps/desktop/src/renderer/src/components/graph/graph-page.i18n.test.tsx`

- [ ] **Step 1: Add `useT('graph')` to `GraphPage`**

In `graph-page.tsx`, import `useT`:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside `GraphPage`, add:

```ts
const { t } = useT('graph')
```

Pass `t`-produced strings to loading, error, retry, graph aria label, node-list label, and `GraphEmptyState`.

- [ ] **Step 2: Replace node summary with translated labels**

Keep counts derived from data. Translate only entity type labels.

Implementation pattern:

```ts
const ENTITY_PLURAL_KEYS = {
  note: 'entity.notes',
  journal: 'entity.journals',
  task: 'entity.tasks',
  project: 'entity.projects',
  tag: 'entity.tags'
} as const

function graphEntityLabel(type: string, count: number, t: TFunction<'graph'>): string {
  const knownKey = ENTITY_PLURAL_KEYS[type as keyof typeof ENTITY_PLURAL_KEYS]
  if (knownKey) return t(knownKey)
  return count === 1 ? type : `${type}s`
}
```

Use this in `nodeSummary`. Do not translate arbitrary unknown node types.

- [ ] **Step 3: Use ICU graph aria label**

Replace manual plural string construction:

```ts
const graphAriaLabel = t('page.aria-label', {
  nodeCount,
  edgeCount,
  summary: nodeSummary || 'none'
})
```

Expected English output with no summary: `Knowledge graph with 1 node and 2 connections.`

Expected English output with summary: `Knowledge graph with 2 nodes and 1 connection: 1 note, 1 task.`

- [ ] **Step 4: Translate empty state copy**

Change `GraphEmptyState` to call `const { t } = useT('graph')`, or accept translated strings as props. Keep user-facing text exactly mapped to `empty.*` keys.

- [ ] **Step 5: Add focused page tests**

Create `graph-page.i18n.test.tsx` with mocks for graph hooks and canvas/control children. Test:

- loading state renders `Loading graph...`
- error state renders `Failed to load graph data` and `Try again`
- empty state renders `Your knowledge graph`, `Link your notes`, and `Discover patterns`
- populated state exposes `aria-label="Knowledge graph with 1 node and 1 connection: 1 note."`
- screen-reader list has `aria-label="Graph nodes"`

Use an `I18nextProvider` wrapper with `createRendererI18n({ locale: 'en' })`.

- [ ] **Step 6: Run focused renderer test**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- graph-page.i18n.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/graph/graph-page.tsx apps/desktop/src/renderer/src/components/graph/graph-page.i18n.test.tsx
git commit -m "feat(i18n): migrate graph page copy"
```

---

## Task 5: Migrate Graph Controls, Filters, Search, and Local Panel Copy

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/graph/graph-control-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/graph/graph-filters.tsx`
- Modify: `apps/desktop/src/renderer/src/components/graph/graph-search.tsx`
- Modify: `apps/desktop/src/renderer/src/components/graph/local-graph-panel.tsx`
- Create: `apps/desktop/src/renderer/src/components/graph/graph-controls.i18n.test.tsx`

- [ ] **Step 1: Replace control panel labels**

In `graph-control-panel.tsx`, import and call `useT('graph')`.

Replace:

- button `title={isOpen ? 'Hide settings' : 'Graph settings'}` with `control.hide-settings` / `control.show-settings`
- reset button `title="Reset filters"` with `control.reset-filters`
- `depth {filterState.focusDepth}` with `control.focus-depth`
- `PanelSection title="Filters"` with `control.filters`
- search placeholder with `search.placeholder`
- entity labels with `filter.notes`, `filter.journals`, `filter.tasks`, `filter.projects`, `filter.tags`, `filter.orphans`
- `PanelSection title="Display"` with `control.display`
- `FilterSwitch label="Show labels"` with `control.show-labels`
- clear-focus button should gain `aria-label={t('control.clear-focus')}`
- clear search button should gain `aria-label={t('search.clear')}`

Keep `ENTITY_FILTERS` as stable keys plus icons/color vars. Compute labels inside render so language changes re-render correctly.

- [ ] **Step 2: Replace legacy filter toolbar labels**

In `graph-filters.tsx`, import and call `useT('graph')`.

Replace:

- `ENTITY_TOGGLES` visible/aria labels with `filter.*`
- `aria-label={`Toggle ${label}`}` with `t('filter.toggle-entity', { label })`
- `aria-label="Toggle orphan nodes"` with `filter.toggle-orphans`
- `depth {filterState.focusDepth}` with `control.focus-depth`
- clear-focus button should gain `aria-label={t('control.clear-focus')}`
- reset button should gain `aria-label={t('control.reset-filters')}`

- [ ] **Step 3: Replace standalone graph search labels**

In `graph-search.tsx`, import and call `useT('graph')`.

Replace:

- placeholder `Search nodes...` with `search.placeholder`
- clear button should gain `aria-label={t('search.clear')}`

- [ ] **Step 4: Replace local graph panel labels**

In `local-graph-panel.tsx`, import and call `useT('graph')` in `LocalGraphPanel` and `PanelHeader`.

Replace:

- `Loading graph...` with `local-panel.loading`
- `No connections found` with `local-panel.empty`
- `title="Open full graph"` with `local-panel.open-full`
- `title="Close graph"` with `local-panel.close`

- [ ] **Step 5: Add focused controls tests**

Create `graph-controls.i18n.test.tsx`. Test rendered labels/titles without mounting Sigma:

- `GraphControlPanel` renders `Graph settings`, opens drawer, renders `Filters`, `Search nodes...`, `Notes`, `Orphans`, `Display`, and `Show labels`
- when focused, renders `depth 2` and a clear-focus button with accessible label `Clear focused node`
- `GraphSearch` renders placeholder `Search nodes...` and clear button accessible label after query is set
- `GraphFilters` exposes aria labels `Toggle Notes`, `Toggle orphan nodes`, and reset button `Reset filters`

Use a wrapper with `createRendererI18n({ locale: 'en' })`.

- [ ] **Step 6: Run focused controls test**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- graph-controls.i18n.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/graph/graph-control-panel.tsx apps/desktop/src/renderer/src/components/graph/graph-filters.tsx apps/desktop/src/renderer/src/components/graph/graph-search.tsx apps/desktop/src/renderer/src/components/graph/local-graph-panel.tsx apps/desktop/src/renderer/src/components/graph/graph-controls.i18n.test.tsx
git commit -m "feat(i18n): migrate graph controls copy"
```

---

## Task 6: Migrate Context Menu, Tooltip, and Tab Fallback Copy

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/graph/graph-context-menu.tsx`
- Modify: `apps/desktop/src/renderer/src/components/graph/graph-tooltip.tsx`
- Modify: `apps/desktop/src/renderer/src/components/graph/graph-events.tsx`
- Modify: `apps/desktop/src/renderer/src/components/graph/graph-canvas.tsx`

- [ ] **Step 1: Replace context menu labels**

In `graph-context-menu.tsx`, import and call `useT('graph')`.

Replace:

- fallback label `'Untitled'` with `context-menu.untitled`
- `Focus on this node` with `context-menu.focus-node`
- `Open in new tab` with `context-menu.open-new-tab`
- `Create note` with `context-menu.create-note`
- `Copy title` with `context-menu.copy-title`

Do not translate the actual node label when it exists; that is user content.

- [ ] **Step 2: Replace tooltip labels**

In `graph-tooltip.tsx`, import and call `useT('graph')`.

Replace:

- unresolved badge with `entity.unresolved`
- known node type badges with `entity.note`, `entity.journal`, `entity.task`, `entity.project`, `entity.tag`
- connection count with `tooltip.connection-count`
- more-tags string `+{tags.length - 5}` with `tooltip.more-tags`

Do not translate real tag names. Keep `#{tag}` as user content.

- [ ] **Step 3: Replace tab title fallbacks**

In both `graph-events.tsx` and the `ContextMenuWithTabAction` helper inside `graph-canvas.tsx`, import/call `useT('graph')` at component scope and pass `untitledLabel` into helper functions.

Expected pattern:

```ts
const { t } = useT('graph')
openNodeInTab(sigma, openTab, node, t('context-menu.untitled'))
```

Do not call React hooks from non-component helper functions.

- [ ] **Step 4: Extend tests if needed**

If `graph-controls.i18n.test.tsx` already imports these components cleanly, add tests there:

- context menu renders `Focus on this node`, `Open in new tab`, and `Copy title`
- unresolved context menu renders `Create note`
- tooltip renders `unresolved` and `2 connections`

If Sigma/Graphology setup makes this noisy, create a separate focused `graph-menu-tooltip.i18n.test.tsx`.

- [ ] **Step 5: Run focused graph component tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- graph-controls.i18n.test.tsx graph-page.i18n.test.tsx
```

Expected: pass. If a separate menu/tooltip test file was created, include it in the command.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/graph/graph-context-menu.tsx apps/desktop/src/renderer/src/components/graph/graph-tooltip.tsx apps/desktop/src/renderer/src/components/graph/graph-events.tsx apps/desktop/src/renderer/src/components/graph/graph-canvas.tsx apps/desktop/src/renderer/src/components/graph/*i18n.test.tsx
git commit -m "feat(i18n): migrate graph menu and tooltip copy"
```

---

## Task 7: Final Hardcoded String Sweep

**Files:**
- Inspect/modify only graph files listed in this plan

- [ ] **Step 1: Search graph components for remaining English UI strings**

Run:

```bash
rg -n "Loading graph|Failed to load graph|Try again|Your knowledge graph|Link your notes|Discover patterns|Graph settings|Hide settings|Reset filters|Search nodes|Toggle orphan|Show labels|Focus on this node|Open in new tab|Create note|Copy title|No connections found|Open full graph|Close graph|connection\\{|connections|Untitled|unresolved|depth " apps/desktop/src/renderer/src/components/graph apps/desktop/src/renderer/src/hooks/use-graph-*.ts
```

Expected: no matches except inside test expectations if tests intentionally assert English output.

- [ ] **Step 2: Search for generic quoted strings in graph files**

Run:

```bash
rg -n "'[^']*[A-Za-z][^']*'|\"[^\"]*[A-Za-z][^\"]*\"|>[^<{]*[A-Za-z][^<{]*<" apps/desktop/src/renderer/src/components/graph apps/desktop/src/renderer/src/hooks/use-graph-*.ts
```

Expected: remaining matches are imports, CSS classes, event/action constants, route/type IDs, icon names, test names, user-content fallbacks already routed through `t`, or other non-user-facing code. If any graph UI copy remains, migrate it to `graph.json`.

- [ ] **Step 3: Confirm TR/AR graph files are still empty**

Run:

```bash
cat packages/i18n/src/locales/tr/graph.json
cat packages/i18n/src/locales/ar/graph.json
```

Expected:

```json
{}
```

- [ ] **Step 4: Commit any cleanup**

```bash
git add packages/i18n/src/locales apps/desktop/src/renderer/src/components/graph packages/i18n/src/shared packages/i18n/src/locales/index.ts
git commit -m "chore(i18n): clean up graph namespace migration"
```

If there are no changes, skip this commit.

---

## Task 8: Verification Gate

**Files:**
- No edits unless a check fails

- [ ] **Step 1: Run i18n package tests**

Run:

```bash
pnpm --filter @memry/i18n test
```

Expected: all i18n tests pass, including graph namespace fallback.

- [ ] **Step 2: Run focused renderer tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- graph
```

Expected: graph i18n tests pass. If the filter matches no tests, run the explicit filenames from Tasks 4-6.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: pass, except for any explicitly documented pre-existing type errors from the current base. Do not hide new graph/i18n type errors.

- [ ] **Step 4: Run lint**

Run:

```bash
pnpm lint
```

Expected: pass. If lint flags pre-existing unrelated files, record them separately and do not edit outside graph/i18n namespace files for this phase.

- [ ] **Step 5: Optional manual smoke test**

Run:

```bash
pnpm dev
```

Expected:

- Graph page loading/error/empty UI renders English strings from `graph.json`.
- Control drawer opens and shows translated graph strings.
- Search placeholder, reset tooltip, filter labels, context menu actions, tooltip connection counts, and local graph panel copy still render.
- Switching to Turkish or Arabic keeps graph UI readable in English fallback.

- [ ] **Step 6: Final status**

Run:

```bash
git status --short
```

Expected: only intended Phase C graph files changed or working tree clean after commits. No files from other Phase C plans are staged.

---

## Atomic Commit Summary

Suggested commits:

1. `feat(i18n): add graph locale namespace`
2. `test(i18n): cover graph namespace fallback`
3. `feat(i18n): migrate graph page copy`
4. `feat(i18n): migrate graph controls copy`
5. `feat(i18n): migrate graph menu and tooltip copy`
6. `chore(i18n): clean up graph namespace migration` only if the final sweep creates real cleanup changes

Keep commits scoped. Do not include unrelated docs or other agents' Phase C plan files.
