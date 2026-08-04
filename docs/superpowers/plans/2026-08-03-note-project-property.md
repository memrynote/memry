# Note → Project `project` Property Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move note/journal → project assignment out of the `⋯` menu and pill row into a multi-valued `project` property, with note frontmatter as the source of truth and `project_links` derived from it.

**Architecture:** A new `project` property type stores project **names** as an array in note frontmatter. A new projection projector (`note-project-links`) reads `note.upserted` events and reconciles the note's `project_links` rows in the data DB. Every other write path (sidebar drag, URL capture, MCP) is rerouted at the main-process boundary to write frontmatter instead of link rows. Project rename/delete rewrite the frontmatter of linked notes. Files and calendar events are untouched — they have no frontmatter and keep the existing dialog.

**Tech Stack:** Electron + TypeScript, React 19 renderer, Drizzle + better-sqlite3 (dual DB: data + index), Vitest, Zod v4, i18next.

**Spec:** `docs/superpowers/specs/2026-08-03-note-project-property-design.md`

## Global Constraints

- **Production app, backward compatibility mandatory.** No DB resets. `project_links` and `property_definitions` need no schema migration — `type` is a free-text column, so `'project'` fits existing rows.
- **No data migration.** The feature is unreleased; do not write a backfill.
- **Logging:** `createLogger('Scope')`, never raw `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **RTL-safe Tailwind in new code:** `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`. No `ml-*`/`pl-*`/`left-*`.
- **Contracts changes require** `pnpm ipc:generate` before `pnpm ipc:check`.
- **`domain-tasks` stays pure.** It has no vault or filesystem access. All frontmatter branching lives in `apps/desktop/src/main/`.
- Commit after every task. Branch is `claude/gallant-perlman-34ad46` (rename before pushing — see CLAUDE.md).

## File Structure

**Create:**

- `apps/desktop/src/main/notes/entity-properties.ts` — one funnel for "set properties on a note _or_ journal entry by id"; extracted from the properties IPC handler so the reroute and propagation paths reuse it.
- `apps/desktop/src/main/notes/project-property.ts` — pure helpers: read/normalise the `project` value, add/remove a name, resolve names → project rows.
- `apps/desktop/src/main/projections/projectors/note-project-links-projector.ts` — the reconciler.
- `apps/desktop/src/renderer/src/components/note/info-section/editors/ProjectEditor.tsx` — the chips + picker editor.
- `apps/desktop/src/renderer/src/hooks/use-projects-list.ts` — loads projects for the editor, refreshes on `onProjectUpdated`.

**Modify:**

- `packages/contracts/src/property-types.ts` — `PROJECT` type + schema + reserved key constant.
- `apps/desktop/src/main/vault/frontmatter.ts` — `inferPropertyType` returns `'project'` for the reserved key.
- `apps/desktop/src/main/database/queries/notes/property-queries.ts` — `getPropertyType` honours the reserved key before the definition lookup.
- `apps/desktop/src/main/database/queries/notes/query-helpers.ts` — `deserializeValue` treats `'project'` as an array.
- `apps/desktop/src/main/database/queries/projects.ts` — queries the reconciler and payload split need.
- `apps/desktop/src/main/ipc/properties-handlers.ts` — use the extracted funnel.
- `apps/desktop/src/main/ipc/tasks-handlers.ts` — markdown-note branch on link/unlink.
- `apps/desktop/src/main/sync/item-handlers/project-handler.ts` — payload split (push) + preservation (pull).
- `apps/desktop/src/main/vault/index.ts` — register the projector.
- `apps/desktop/src/renderer/src/components/note/info-section/types.ts` — type union + config.
- `.../info-section/AddPropertyPopup.tsx` — force the name, disable when present.
- `.../info-section/PropertyRow.tsx` — render `ProjectEditor`, block rename.
- `.../info-section/editors/index.ts` — export.
- `apps/desktop/src/renderer/src/pages/note.tsx` — remove menu item, handler, chips, imports.
- `packages/i18n/src/locales/en/notes.json` — new strings.

**Delete:**

- `apps/desktop/src/renderer/src/components/tasks/projects/add-note-to-project-dialog.tsx`

---

### Task 1: `project` property type in contracts

**Files:**

- Modify: `packages/contracts/src/property-types.ts`
- Test: `apps/desktop/src/main/vault/property-definitions.test.ts`

**Interfaces:**

- Produces: `PropertyTypes.PROJECT` (`'project'`), `PROJECT_PROPERTY_KEY` (`'project'`), `ProjectPropertySchema`. Every later task imports these from `@memry/contracts/property-types`.

- [ ] **Step 1: Add the type, the reserved key, and the schema**

In `packages/contracts/src/property-types.ts`, add to the `PropertyTypes` const:

```ts
export const PropertyTypes = {
  TEXT: 'text',
  NUMBER: 'number',
  CHECKBOX: 'checkbox',
  DATE: 'date',
  URL: 'url',
  STATUS: 'status',
  SELECT: 'select',
  MULTISELECT: 'multiselect',
  PROJECT: 'project'
} as const
```

Below `PropertyType`, add the reserved key:

```ts
/**
 * The one frontmatter key that carries project membership. Reserved: its type is
 * always `project`, whatever the definition file or type inference would say.
 * Inference would otherwise read `project: [Alpha]` as a plain array and store it
 * as text, so a note written in Obsidian would render the wrong editor.
 */
export const PROJECT_PROPERTY_KEY = 'project'
```

Add the schema next to `DatePropertySchema`:

```ts
const ProjectPropertySchema = z.object({
  type: z.literal('project')
})
```

Add it to the union:

```ts
export const PropertyDefinitionSchema = z.discriminatedUnion('type', [
  StatusPropertySchema,
  SelectPropertySchema,
  MultiselectPropertySchema,
  DatePropertySchema,
  ProjectPropertySchema
])
```

- [ ] **Step 2: Write the failing round-trip test**

Append to `apps/desktop/src/main/vault/property-definitions.test.ts`, inside the existing top-level `describe`:

```ts
it('round-trips a project definition through properties.md', async () => {
  const service = PropertyDefinitionsService.init(vaultPath)
  await service.upsert({ name: 'project', type: 'project' })

  const reloaded = PropertyDefinitionsService.init(vaultPath)
  await reloaded.reload()

  expect(reloaded.get('project')).toEqual({
    name: 'project',
    type: 'project',
    options: undefined
  })
})
```

> Match the existing file's setup: reuse whatever `vaultPath` fixture and DB
> initialisation the surrounding `describe` already sets up rather than creating new ones.

- [ ] **Step 3: Run the test and confirm it fails**

```bash
pnpm --filter @memry/desktop test:main -- property-definitions
```

Expected: FAIL — `PropertyDefinitionsFileSchema` rejects `{ type: 'project' }`, so `reload()` keeps the last-known-good cache and `get('project')` is `undefined`.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm --filter @memry/desktop test:main -- property-definitions
```

Expected: PASS. `persistToFile` already falls into the generic `else` branch and writes `{ type: 'project', options: undefined }`; `applyParsedData` mirrors it. No change needed there.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/property-types.ts apps/desktop/src/main/vault/property-definitions.test.ts
git commit -m "feat(properties): add the project property type"
```

---

### Task 2: Reserved-key typing and array deserialization

**Files:**

- Modify: `apps/desktop/src/main/vault/frontmatter.ts:389`
- Modify: `apps/desktop/src/main/database/queries/notes/property-queries.ts:187`
- Modify: `apps/desktop/src/main/database/queries/notes/query-helpers.ts:40`
- Test: `apps/desktop/src/main/database/queries/notes/property-queries.test.ts` (create if absent)

**Interfaces:**

- Consumes: `PROJECT_PROPERTY_KEY` from Task 1.
- Produces: `getNoteProperties(db, noteId)` returns `{ name: 'project', type: 'project', value: string[] }` for a project property. Tasks 3, 4 and 6 rely on the value already being an array.

Two existing behaviours break a multi-valued project property, and both must be fixed
here or the value silently degrades to a string on the first index pass:

- `inferPropertyType` maps any array to `'text'` (`frontmatter.ts:401`).
- `deserializeValue` JSON-parses only `'multiselect'` (`query-helpers.ts:50`).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/database/queries/notes/property-queries.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setNoteProperties, getNoteProperties, getPropertyType } from './property-queries'
import { inferPropertyType } from '../../../vault/frontmatter'
import { createTestIndexDb } from '../../../../test/helpers/test-db'
import type { IndexDb } from '../../types'

describe('project property typing', () => {
  let db: IndexDb

  beforeEach(() => {
    db = createTestIndexDb()
  })

  it('types the reserved project key as project and keeps the array', () => {
    setNoteProperties(db, 'note-1', { project: ['Alpha', 'Beta'] }, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )

    const props = getNoteProperties(db, 'note-1')

    expect(props).toEqual([{ name: 'project', type: 'project', value: ['Alpha', 'Beta'] }])
  })

  it('keeps a single project as a one-element array', () => {
    setNoteProperties(db, 'note-2', { project: ['Alpha'] }, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )

    expect(getNoteProperties(db, 'note-2')[0].value).toEqual(['Alpha'])
  })

  it('reads an empty project list back as an empty array', () => {
    setNoteProperties(db, 'note-3', { project: [] }, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )

    expect(getNoteProperties(db, 'note-3')[0].value).toEqual([])
  })

  it('still infers a non-reserved array key as text', () => {
    setNoteProperties(db, 'note-4', { colours: ['red'] }, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )

    expect(getNoteProperties(db, 'note-4')[0].type).toBe('text')
  })
})
```

> Use whatever in-memory index-DB helper the neighbouring query tests already use; if
> the import path above does not exist, copy the setup from an existing test in
> `apps/desktop/src/main/database/queries/notes/`.

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @memry/desktop test:main -- property-queries
```

Expected: FAIL — type is `'text'` and the value comes back as the JSON string `'["Alpha","Beta"]'`.

- [ ] **Step 3: Make `inferPropertyType` honour the reserved key**

In `apps/desktop/src/main/vault/frontmatter.ts`, import the key alongside the existing
`PropertyType` import:

```ts
import { PROJECT_PROPERTY_KEY, type PropertyType } from '@memry/contracts/property-types'
```

Rename the ignored parameter and add the check as the first statement of the function
(it currently reads `export function inferPropertyType(_name: string, value: unknown)`):

```ts
export function inferPropertyType(name: string, value: unknown): PropertyType {
  // Reserved: `project` carries an array of project names. Inference would fall
  // through to the array branch below and flatten it to text.
  if (name === PROJECT_PROPERTY_KEY) {
    return 'project'
  }

  // Boolean -> checkbox
  if (typeof value === 'boolean') {
```

- [ ] **Step 4: Make `getPropertyType` honour it before the definition lookup**

In `apps/desktop/src/main/database/queries/notes/property-queries.ts`, add the import:

```ts
import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'
```

and change `getPropertyType`:

```ts
export function getPropertyType(
  db: IndexDb,
  name: string,
  value: unknown,
  inferFn: (name: string, value: unknown) => PropertyType
): PropertyType {
  // Ahead of the definition lookup: a stale `text` definition written before this
  // type existed must not win over the reserved key.
  if (name === PROJECT_PROPERTY_KEY) {
    return 'project'
  }

  const definition = getPropertyDefinition(db, name)
  if (definition) {
    return definition.type as PropertyType
  }
  return inferFn(name, value)
}
```

- [ ] **Step 5: Deserialize project values as arrays**

In `apps/desktop/src/main/database/queries/notes/query-helpers.ts`, extend the
`multiselect` case:

```ts
    case 'multiselect':
    case 'project': {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : [value]
      } catch {
        return [value]
      }
    }
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
pnpm --filter @memry/desktop test:main -- property-queries
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/vault/frontmatter.ts apps/desktop/src/main/database/queries/notes/
git commit -m "feat(properties): type the reserved project key and keep its array value"
```

---

### Task 3: Renderer property-type plumbing

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/info-section/types.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/info-section/AddPropertyPopup.tsx`
- Modify: `packages/i18n/src/locales/en/notes.json`
- Test: `apps/desktop/src/renderer/src/components/note/info-section/info-section.test.tsx`

**Interfaces:**

- Consumes: `PROJECT_PROPERTY_KEY` from Task 1.
- Produces: `PropertyType` union includes `'project'`; `AddPropertyPopup` emits `{ name: 'project', type: 'project' }`. Task 5 renders on this type.

- [ ] **Step 1: Extend the renderer property type**

In `.../info-section/types.ts`:

```ts
import {
  AlignLeft,
  Hash,
  Calendar,
  CheckSquare,
  Link,
  ListChecks,
  List,
  Layers,
  FolderKanban,
  type AppIcon
} from '@/lib/icons'

export type PropertyType =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'status'
  | 'select'
  | 'multiselect'
  | 'project'
```

and add the config entry (last, so it sorts last in the popup):

```ts
export const PROPERTY_TYPE_CONFIG: Record<PropertyType, PropertyTypeConfig> = {
  text: { label: 'Text', icon: AlignLeft },
  number: { label: 'Number', icon: Hash },
  date: { label: 'Date', icon: Calendar },
  checkbox: { label: 'Checkbox', icon: CheckSquare },
  url: { label: 'URL', icon: Link },
  status: { label: 'Status', icon: ListChecks },
  select: { label: 'Select', icon: List },
  multiselect: { label: 'Multiselect', icon: Layers },
  project: { label: 'Project', icon: FolderKanban }
}
```

> If `FolderKanban` is not re-exported from `@/lib/icons`, add it there — `note.tsx`
> already imports it, so the icon exists in the set.

- [ ] **Step 2: Add the i18n strings**

In `packages/i18n/src/locales/en/notes.json`, inside the `"properties"` object add:

```json
"types": {
  "project": "Project"
},
"projectAlreadySet": "This note already has a project property",
"projectPlaceholder": "No project",
"projectSearch": "Search projects",
"projectEmpty": "No projects",
"projectRemove": "Remove from {{name}}",
"projectAdd": "Add to project",
"projectUnknown": "{{name}} (not found)"
```

> `types` already exists — add only the `project` member to it, keep the siblings.

- [ ] **Step 3: Write the failing test**

Add to `.../info-section/info-section.test.tsx`:

```tsx
it('forces the name to `project` when the project type is picked', async () => {
  const onAdd = vi.fn()
  const user = userEvent.setup()

  renderWithI18n(
    <AddPropertyPopup open onAdd={onAdd}>
      <button type="button">add</button>
    </AddPropertyPopup>
  )

  await user.type(screen.getByLabelText(/property name/i), 'My Client')
  await user.click(screen.getByRole('button', { name: /^project$/i }))

  expect(onAdd).toHaveBeenCalledWith({ name: 'project', type: 'project' })
})

it('disables the project entry when the note already has one', () => {
  renderWithI18n(
    <AddPropertyPopup open onAdd={vi.fn()} existingNames={['project']}>
      <button type="button">add</button>
    </AddPropertyPopup>
  )

  expect(screen.getByRole('button', { name: /^project$/i })).toBeDisabled()
})
```

> Reuse the file's existing render helper and imports rather than the names above if
> they differ.

- [ ] **Step 4: Run and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- info-section
```

Expected: FAIL — the popup passes the typed name through and has no `existingNames` prop.

- [ ] **Step 5: Implement in `AddPropertyPopup`**

Add the prop and the two behaviours:

```tsx
import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'

interface AddPropertyPopupProps {
  onAdd: (property: NewProperty) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  /** Property names already on the entity — used to block a second `project`. */
  existingNames?: string[]
  children: React.ReactNode
}
```

In the component body:

```tsx
const hasProject = (existingNames ?? []).includes(PROJECT_PROPERTY_KEY)

const handleTypeSelect = useCallback(
  (type: string) => {
    // The project link is keyed off one reserved frontmatter key, so the name is
    // not the user's to choose — a second `project 2` would render but never link.
    if (type === 'project') {
      if (hasProject) return
      onAdd({ name: PROJECT_PROPERTY_KEY, type: 'project' })
      setPropertyName('')
      return
    }

    const config = PROPERTY_TYPE_CONFIG[type as PropertyType]
    const baseName = propertyName.trim() || config.label
    onAdd({ name: baseName, type: type as PropertyType })
    setPropertyName('')
  },
  [hasProject, onAdd, propertyName]
)
```

Add `project` to `propertyTypeLabels`:

```tsx
project: t('properties.types.project')
```

and disable the item in the list:

```tsx
<Picker.Item
  key={propType}
  value={propType}
  label={propertyTypeLabels[propType]}
  disabled={propType === 'project' && hasProject}
  icon={
    <span className="text-muted-foreground">
      <IconComponent className="size-4" />
    </span>
  }
/>
```

- [ ] **Step 6: Pass `existingNames` from `InfoSection`**

In `.../info-section/InfoSection.tsx`, pass the names it already holds to every
`AddPropertyPopup` it renders:

```tsx
existingNames={properties.map((p) => p.name)}
```

> Use whatever the component's local property array is actually called.

- [ ] **Step 7: Run tests and i18n check**

```bash
pnpm --filter @memry/desktop test:renderer -- info-section
pnpm --filter @memry/desktop i18n:check
```

Expected: PASS, no missing English keys.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/info-section/ packages/i18n/src/locales/en/notes.json
git commit -m "feat(properties): offer the project type in the add-property popup"
```

---

### Task 4: `ProjectEditor` component

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-projects-list.ts`
- Create: `apps/desktop/src/renderer/src/components/note/info-section/editors/ProjectEditor.tsx`
- Modify: `apps/desktop/src/renderer/src/components/note/info-section/editors/index.ts`
- Test: `apps/desktop/src/renderer/src/components/note/info-section/editors/ProjectEditor.test.tsx`

**Interfaces:**

- Consumes: `tasksService.listProjects()` → `{ projects: ProjectWithStats[] }` where each project has `id`, `name`, `color`, `icon` (emoji or `null`), `archivedAt`; `onProjectUpdated(cb)` from `@/services/tasks-service`.
- Produces:

  ```tsx
  interface ProjectEditorProps {
    value: string[]
    defaultOpen?: boolean
    onChange: (value: string[]) => void
  }
  export function ProjectEditor(props: ProjectEditorProps): React.JSX.Element
  ```

  `value` and the `onChange` argument are project **names**. Task 5 wires this into `PropertyRow`.

- [ ] **Step 1: Write the hook**

Create `apps/desktop/src/renderer/src/hooks/use-projects-list.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'
import { tasksService, onProjectUpdated, type ProjectWithStats } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:ProjectsList')

export interface UseProjectsListReturn {
  projects: ProjectWithStats[]
  isLoading: boolean
}

/**
 * All non-archived projects, refreshed whenever a project changes. Archived
 * projects are excluded from the picker but a note already naming one still
 * renders it — resolution happens by name in the editor, not here.
 */
export function useProjectsList(): UseProjectsListReturn {
  const [projects, setProjects] = useState<ProjectWithStats[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await tasksService.listProjects()
      setProjects(result.projects.filter((project) => project.archivedAt == null))
    } catch (error) {
      log.error('Failed to list projects', extractErrorMessage(error))
      setProjects([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => onProjectUpdated(() => void load()), [load])

  return { projects, isLoading }
}
```

- [ ] **Step 2: Write the failing test**

Create `.../editors/ProjectEditor.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectEditor } from './ProjectEditor'

const listProjects = vi.fn()

vi.mock('@/services/tasks-service', () => ({
  tasksService: { listProjects: () => listProjects() },
  onProjectUpdated: () => () => {}
}))

const PROJECTS = [
  { id: 'p1', name: 'Alpha', color: '#ff0000', icon: '🚀', archivedAt: null },
  { id: 'p2', name: 'Beta', color: '#00ff00', icon: null, archivedAt: null },
  { id: 'p3', name: 'Old', color: '#0000ff', icon: null, archivedAt: '2026-01-01' }
]

describe('ProjectEditor', () => {
  beforeEach(() => {
    listProjects.mockResolvedValue({ projects: PROJECTS })
  })

  it('renders a chip per selected project with its emoji', async () => {
    render(<ProjectEditor value={['Alpha']} onChange={vi.fn()} />)

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('🚀')).toBeInTheDocument()
  })

  it('removes one project when its × is clicked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ProjectEditor value={['Alpha', 'Beta']} onChange={onChange} />)

    await user.click(await screen.findByRole('button', { name: /remove from alpha/i }))

    expect(onChange).toHaveBeenCalledWith(['Beta'])
  })

  it('leaves an empty array when the last project is removed', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ProjectEditor value={['Alpha']} onChange={onChange} />)

    await user.click(await screen.findByRole('button', { name: /remove from alpha/i }))

    expect(onChange).toHaveBeenCalledWith([])
  })

  it('appends a picked project without dropping the existing ones', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ProjectEditor value={['Alpha']} defaultOpen onChange={onChange} />)

    await user.click(await screen.findByRole('button', { name: /^beta$/i }))

    expect(onChange).toHaveBeenCalledWith(['Alpha', 'Beta'])
  })

  it('keeps a name that matches no project, rendered as unknown', async () => {
    render(<ProjectEditor value={['Ghost']} onChange={vi.fn()} />)

    expect(await screen.findByText(/ghost/i)).toBeInTheDocument()
  })

  it('renders an archived project already on the note but omits it from the picker', async () => {
    render(<ProjectEditor value={['Old']} defaultOpen onChange={vi.fn()} />)

    expect(await screen.findByText('Old')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^old$/i })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- ProjectEditor
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `ProjectEditor`**

Create `.../editors/ProjectEditor.tsx`:

```tsx
import { useState } from 'react'
import { X } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import { cn } from '@/lib/utils'
import { useProjectsList } from '@/hooks/use-projects-list'
import { useT } from '@memry/i18n/renderer'

interface ProjectEditorProps {
  /** Project names, as stored in frontmatter. */
  value: string[]
  defaultOpen?: boolean
  onChange: (value: string[]) => void
}

/**
 * The `project` property's value: one chip per project name in the note's
 * frontmatter. A name with no matching project still renders — resolution is
 * by name, and silently dropping the user's text would be data loss.
 */
export function ProjectEditor({
  value,
  defaultOpen,
  onChange
}: ProjectEditorProps): React.JSX.Element {
  const { t } = useT('notes')
  const [isOpen, setIsOpen] = useState(defaultOpen ?? false)
  const { projects } = useProjectsList()

  const byName = new Map(projects.map((project) => [project.name.toLowerCase(), project]))
  const chips = value.map((name) => ({ name, project: byName.get(name.toLowerCase()) ?? null }))

  const handleToggle = (name: string): void => {
    const next = value.some((v) => v.toLowerCase() === name.toLowerCase())
      ? value.filter((v) => v.toLowerCase() !== name.toLowerCase())
      : [...value, name]
    onChange(next)
  }

  const handleRemove = (name: string): void => {
    onChange(value.filter((v) => v !== name))
  }

  return (
    <Picker
      mode="multi"
      open={isOpen}
      onOpenChange={setIsOpen}
      value={value}
      onValueChange={handleToggle}
      closeOnSelect={false}
    >
      <Picker.Trigger variant="inline" asChild>
        <span>
          {chips.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              {chips.map(({ name, project }) => (
                <span
                  key={name}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs',
                    project
                      ? 'border-border bg-muted/40'
                      : 'border-dashed border-border text-text-tertiary'
                  )}
                >
                  {project?.icon ? (
                    <span aria-hidden="true">{project.icon}</span>
                  ) : (
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: project?.color ?? 'transparent' }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="max-w-32 truncate">{name}</span>
                  <button
                    type="button"
                    aria-label={t('properties.projectRemove', { name })}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemove(name)
                    }}
                    className="rounded p-0.5 text-text-tertiary transition-colors hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </span>
          ) : (
            <span className="text-[13px] text-text-tertiary font-sans">
              {t('properties.projectPlaceholder')}
            </span>
          )}
        </span>
      </Picker.Trigger>
      <Picker.Content width={220} align="start">
        <Picker.Search placeholder={t('properties.projectSearch')} />
        <Picker.List>
          {projects.length === 0 && <Picker.Empty message={t('properties.projectEmpty')} />}
          {projects.map((project) => (
            <Picker.Item
              key={project.id}
              value={project.name}
              label={project.name}
              indicator="checkbox"
              indicatorColor={project.color}
              icon={project.icon ? <span aria-hidden="true">{project.icon}</span> : undefined}
            />
          ))}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}
```

> The `Picker` props above mirror `MultiselectEditor.tsx`, which is the closest
> existing editor. If `Picker.Item` has no `icon`/`indicatorColor` prop in this
> codebase version, read `MultiselectEditor.tsx` and match its actual API.

- [ ] **Step 5: Export it**

In `.../editors/index.ts` add:

```ts
export { ProjectEditor } from './ProjectEditor'
```

- [ ] **Step 6: Run and confirm it passes**

```bash
pnpm --filter @memry/desktop test:renderer -- ProjectEditor
```

Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-projects-list.ts apps/desktop/src/renderer/src/components/note/info-section/editors/
git commit -m "feat(properties): add the project property editor"
```

---

### Task 5: Render `ProjectEditor` and strip the note page's old surface

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/note.tsx`
- Delete: `apps/desktop/src/renderer/src/components/tasks/projects/add-note-to-project-dialog.tsx`
- Test: `apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.test.tsx`

**Interfaces:**

- Consumes: `ProjectEditor` from Task 4, `PROPERTY_TYPE_CONFIG.project` from Task 3.

- [ ] **Step 1: Write the failing test**

Add to `PropertyRow.test.tsx`:

```tsx
it('renders the project editor for a project property', () => {
  renderWithI18n(
    <PropertyRow
      property={{ id: '1', name: 'project', type: 'project', value: ['Alpha'], isCustom: true }}
      onValueChange={vi.fn()}
    />
  )

  expect(screen.getByText('Alpha')).toBeInTheDocument()
})

it('does not let a project property be renamed', () => {
  renderWithI18n(
    <PropertyRow
      property={{ id: '1', name: 'project', type: 'project', value: [], isCustom: true }}
      onValueChange={vi.fn()}
      onNameChange={vi.fn()}
    />
  )

  expect(screen.getByTitle('project')).not.toHaveAttribute('role', 'button')
})
```

> Mock `@/hooks/use-projects-list` in this file the way the surrounding tests mock
> their hooks, returning `{ projects: [{ id: 'p1', name: 'Alpha', color: '#f00', icon: null, archivedAt: null }], isLoading: false }`.

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- PropertyRow
```

Expected: FAIL — the value renders through `PropertyValueDisplay` as a stringified array, and the label is still a rename button.

- [ ] **Step 3: Render the editor in `PropertyRow`**

Add the icon mapping:

```tsx
import {
  GripVertical,
  Trash2,
  Calendar,
  Type,
  Hash,
  CheckSquare,
  List,
  Tags,
  Link,
  Star,
  FolderKanban,
  type AppIcon
} from '@/lib/icons'

const PROPERTY_TYPE_ICONS: Record<string, AppIcon> = {
  text: Type,
  number: Hash,
  checkbox: CheckSquare,
  date: Calendar,
  select: List,
  multiselect: Tags,
  status: List,
  url: Link,
  rating: Star,
  project: FolderKanban
}
```

Import the editor from the existing editors import block, then branch in
`PropertyValueRenderer` — before the `SELECT_TYPES` check:

```tsx
if (property.type === 'project') {
  const names = Array.isArray(property.value) ? (property.value as string[]) : []
  return <ProjectEditor value={names} defaultOpen={autoOpen} onChange={onValueChange} />
}
```

Treat it as always-interactive so the row never enters inline text editing:

```tsx
const isAlwaysInteractiveType = (type: string): boolean =>
  type === 'checkbox' || type === 'date' || type === 'project' || SELECT_TYPES.has(type)
```

Block renaming by ignoring `onNameChange` for this type. Near the top of the
`PropertyRow` body:

```tsx
// The reserved `project` key is what the reconciler reads; renaming it would
// silently unlink the note.
const canRenameName = property.type !== 'project' ? onNameChange : undefined
```

then use `canRenameName` everywhere `onNameChange` is currently read inside the
component (the `handleStartNameEdit` guard and dependency array, the label's
`onClick`, `role`, `tabIndex`, and `onKeyDown`).

- [ ] **Step 4: Remove the note page's menu item, handler, and chips**

In `apps/desktop/src/renderer/src/pages/note.tsx`:

- delete the `add-to-project` `Picker.Item` block at `note.tsx:1271-1275`
- delete the `case 'add-to-project':` branch in the menu's value handler
- delete the `<ItemProjectChips ... />` line at `note.tsx:1361`
- delete the `<AddNoteToProjectDialog ... />` render at `note.tsx:1557` and the
  `useState` that drives its `open` prop
- delete the imports at `note.tsx:64` and `note.tsx:65`
- remove `FolderKanban` from the icon import **only if** nothing else in the file
  still uses it
- remove `tTasks` and its `useT('tasks')` call **only if** no other usage remains
  (check first — other menu labels may use it)

Then delete the dialog:

```bash
git rm apps/desktop/src/renderer/src/components/tasks/projects/add-note-to-project-dialog.tsx
```

`ItemProjectChips` itself stays — `file.tsx:151` and `calendar-event-form.tsx:223`
still render it.

- [ ] **Step 5: Run tests and lint**

```bash
pnpm --filter @memry/desktop test:renderer -- PropertyRow
pnpm --filter @memry/desktop typecheck:web
pnpm lint
```

Expected: PASS, no unused imports or variables reported.

- [ ] **Step 6: Commit**

```bash
git add -A apps/desktop/src/renderer/src
git commit -m "feat(note): move project assignment into the property row"
```

---

### Task 6: `setEntityProperties` funnel

**Files:**

- Create: `apps/desktop/src/main/notes/entity-properties.ts`
- Modify: `apps/desktop/src/main/ipc/properties-handlers.ts`
- Test: `apps/desktop/src/main/notes/entity-properties.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export async function setEntityProperties(
    entityId: string,
    properties: Record<string, unknown>
  ): Promise<{ success: true } | { success: false; error: string }>

  export function getEntityPropertiesRecord(entityId: string): Record<string, unknown> | null
  ```

  Tasks 8 and 9 call both. `setEntityProperties` dispatches to the journal or note
  writer exactly as `properties-handlers.ts` does today.

The dispatch logic ("has a `date` → journal, else note") currently lives inline in the
IPC handler and is about to have three callers. Extract it before adding them.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/notes/entity-properties.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const updateNote = vi.fn()
const getNoteCacheById = vi.fn()
const getNoteProperties = vi.fn()
const syncNoteUpdate = vi.fn()
const enqueueJournalUpdate = vi.fn()

vi.mock('../vault/notes-crud', () => ({ updateNote: (...a: unknown[]) => updateNote(...a) }))
vi.mock('../notes/store', () => ({
  getNoteCacheById: (...a: unknown[]) => getNoteCacheById(...a),
  getNoteProperties: (...a: unknown[]) => getNoteProperties(...a),
  getJournalEntryByDate: vi.fn()
}))
vi.mock('../notes/runtime-effects', () => ({
  syncNoteUpdate: (...a: unknown[]) => syncNoteUpdate(...a)
}))
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalUpdate: (...a: unknown[]) => enqueueJournalUpdate(...a)
}))
vi.mock('../database', () => ({ getIndexDatabase: () => ({}), getDatabase: () => ({}) }))

describe('setEntityProperties', () => {
  beforeEach(() => vi.clearAllMocks())

  it('routes a plain note to updateNote', async () => {
    getNoteCacheById.mockReturnValue({ id: 'n1', date: null })
    const { setEntityProperties } = await import('./entity-properties')

    const result = await setEntityProperties('n1', { project: ['Alpha'] })

    expect(result).toEqual({ success: true })
    expect(updateNote).toHaveBeenCalledWith({ id: 'n1', properties: { project: ['Alpha'] } })
    expect(syncNoteUpdate).toHaveBeenCalledWith('n1')
  })

  it('returns an error envelope for an unknown entity', async () => {
    getNoteCacheById.mockReturnValue(undefined)
    const { setEntityProperties } = await import('./entity-properties')

    expect(await setEntityProperties('missing', {})).toEqual({
      success: false,
      error: 'Entity not found'
    })
    expect(updateNote).not.toHaveBeenCalled()
  })
})
```

> Match the mock paths to the real imports in `properties-handlers.ts`; adjust if the
> extracted module imports from different specifiers.

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm --filter @memry/desktop test:main -- entity-properties
```

Expected: FAIL — module not found.

- [ ] **Step 3: Extract the module**

Create `apps/desktop/src/main/notes/entity-properties.ts` by moving the body of the
`properties:set` handler and the `updateJournalProperties` helper out of
`apps/desktop/src/main/ipc/properties-handlers.ts` verbatim:

```ts
import { createLogger } from '../lib/logger'
import { getNoteCacheById, getNoteProperties } from './store'
import { getIndexDatabase } from '../database'
import { updateNote } from '../vault/notes-crud'
import { syncNoteUpdate } from './runtime-effects'
import { enqueueJournalUpdate } from '../journal/runtime-effects'
import { updateJournalProperties } from '../journal/properties'

const logger = createLogger('EntityProperties')

export type SetEntityPropertiesResult = { success: true } | { success: false; error: string }

/**
 * Write a full property record onto a note or a journal entry, whichever the id
 * resolves to. The only funnel for property writes — the properties IPC handler,
 * the project-link reroute and project rename/delete propagation all go through it.
 */
export async function setEntityProperties(
  entityId: string,
  properties: Record<string, unknown>
): Promise<SetEntityPropertiesResult> {
  const db = getIndexDatabase()
  const entity = getNoteCacheById(db, entityId)

  if (!entity) {
    return { success: false, error: 'Entity not found' }
  }

  logger.debug('setEntityProperties', { entityId, propertyKeys: Object.keys(properties) })

  if (entity.date) {
    await updateJournalProperties(entity.date, properties)
    enqueueJournalUpdate(entityId, entity.date)
  } else {
    await updateNote({ id: entityId, properties })
    syncNoteUpdate(entityId)
  }

  return { success: true }
}

/** The entity's current properties as a plain record, or null if it does not exist. */
export function getEntityPropertiesRecord(entityId: string): Record<string, unknown> | null {
  const db = getIndexDatabase()
  if (!getNoteCacheById(db, entityId)) return null

  const record: Record<string, unknown> = {}
  for (const prop of getNoteProperties(db, entityId)) {
    record[prop.name] = prop.value
  }
  return record
}
```

Move `updateJournalProperties` into `apps/desktop/src/main/journal/properties.ts`
unchanged (it currently sits at the bottom of `properties-handlers.ts`) and export it.

- [ ] **Step 4: Rewire the IPC handler**

In `properties-handlers.ts`, replace the inlined bodies of the `SET` and `RENAME`
handlers with calls to `setEntityProperties`, keeping the existing validation and
`withErrorHandler` wrappers and the rename handler's duplicate/missing-name checks.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @memry/desktop test:main -- "entity-properties|properties-handlers"
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS — the existing `properties-handlers.test.ts` must stay green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/notes/entity-properties.ts apps/desktop/src/main/journal/properties.ts apps/desktop/src/main/ipc/properties-handlers.ts apps/desktop/src/main/notes/entity-properties.test.ts
git commit -m "refactor(properties): extract the note/journal property write funnel"
```

---

### Task 7: Reconciler projector

**Files:**

- Create: `apps/desktop/src/main/notes/project-property.ts`
- Create: `apps/desktop/src/main/projections/projectors/note-project-links-projector.ts`
- Modify: `apps/desktop/src/main/database/queries/projects.ts`
- Modify: `apps/desktop/src/main/vault/index.ts:275`
- Test: `apps/desktop/src/main/projections/projectors/note-project-links-projector.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // project-property.ts
  export function readProjectNames(properties: Record<string, unknown>): string[]
  export function withProjectName(names: string[], name: string): string[]
  export function withoutProjectName(names: string[], name: string): string[]

  // projects.ts
  export function listProjectsByNames(db: DataDb, names: string[]): { id: string; name: string }[]
  export function listNoteProjectLinkIds(
    db: DataDb,
    noteId: string
  ): { id: string; projectId: string }[]
  ```

  Tasks 8 and 9 consume `readProjectNames`, `withProjectName`, `withoutProjectName`.

- [ ] **Step 1: Write the pure helpers**

Create `apps/desktop/src/main/notes/project-property.ts`:

```ts
import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'

/**
 * The `project` value as a clean name list. Tolerates every shape a hand-edited
 * frontmatter can produce: a bare string, a nested array, nulls, blank entries.
 */
export function readProjectNames(properties: Record<string, unknown>): string[] {
  const raw = properties[PROJECT_PROPERTY_KEY]
  const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]

  const seen = new Set<string>()
  const names: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

export function withProjectName(names: string[], name: string): string[] {
  return names.some((n) => n.toLowerCase() === name.toLowerCase()) ? names : [...names, name]
}

export function withoutProjectName(names: string[], name: string): string[] {
  return names.filter((n) => n.toLowerCase() !== name.toLowerCase())
}
```

- [ ] **Step 2: Add the two queries**

In `apps/desktop/src/main/database/queries/projects.ts`:

```ts
/**
 * Resolve project names case-insensitively. Names are not unique, so a duplicate
 * resolves to the oldest project — callers log the ambiguity.
 */
export function listProjectsByNames(
  db: DataDb,
  names: string[]
): { id: string; name: string; createdAt: string }[] {
  if (names.length === 0) return []
  const lowered = names.map((n) => n.toLowerCase())
  return db
    .select({ id: projects.id, name: projects.name, createdAt: projects.createdAt })
    .from(projects)
    .where(inArray(sql`lower(${projects.name})`, lowered))
    .orderBy(asc(projects.createdAt))
    .all()
}

/** Every project link pointing at one note, for the frontmatter reconciler. */
export function listNoteProjectLinkIds(
  db: DataDb,
  noteId: string
): { id: string; projectId: string }[] {
  return db
    .select({ id: projectLinks.id, projectId: projectLinks.projectId })
    .from(projectLinks)
    .where(and(eq(projectLinks.itemType, 'note'), eq(projectLinks.itemId, noteId)))
    .all()
}
```

> Add `sql` to the `drizzle-orm` import in that file if it is not already there.

- [ ] **Step 3: Write the failing projector test**

Create `.../projectors/note-project-links-projector.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listProjectsByNames = vi.fn()
const listNoteProjectLinkIds = vi.fn()
const linkRows: { projectId: string; itemId: string }[] = []
const insertProjectLink = vi.fn((_db, row) => linkRows.push(row))
const deleteProjectLink = vi.fn()
const syncProjectUpdate = vi.fn()

vi.mock('../../database', () => ({ getDatabase: () => ({}) }))
vi.mock('../../database/queries/projects', () => ({
  listProjectsByNames: (...a: unknown[]) => listProjectsByNames(...a),
  listNoteProjectLinkIds: (...a: unknown[]) => listNoteProjectLinkIds(...a),
  insertProjectLink: (...a: unknown[]) => insertProjectLink(...a),
  deleteProjectLink: (...a: unknown[]) => deleteProjectLink(...a)
}))
vi.mock('../../tasks/runtime-effects', () => ({
  syncProjectUpdate: (...a: unknown[]) => syncProjectUpdate(...a)
}))

const markdownEvent = (properties: Record<string, unknown>) => ({
  type: 'note.upserted' as const,
  note: {
    kind: 'markdown' as const,
    noteId: 'n1',
    properties
  } as never
})

describe('note-project-links projector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    linkRows.length = 0
  })

  it('inserts a link for a newly named project', async () => {
    listProjectsByNames.mockReturnValue([{ id: 'p1', name: 'Alpha', createdAt: '2026-01-01' }])
    listNoteProjectLinkIds.mockReturnValue([])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Alpha'] }))

    expect(linkRows).toEqual([expect.objectContaining({ projectId: 'p1', itemId: 'n1' })])
    expect(syncProjectUpdate).toHaveBeenCalledWith('p1', ['links'])
  })

  it('deletes a link whose project is no longer named', async () => {
    listProjectsByNames.mockReturnValue([])
    listNoteProjectLinkIds.mockReturnValue([{ id: 'l1', projectId: 'p1' }])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: [] }))

    expect(deleteProjectLink).toHaveBeenCalledWith({}, 'l1')
    expect(syncProjectUpdate).toHaveBeenCalledWith('p1', ['links'])
  })

  it('leaves an unchanged link untouched so position and pinned survive', async () => {
    listProjectsByNames.mockReturnValue([{ id: 'p1', name: 'Alpha', createdAt: '2026-01-01' }])
    listNoteProjectLinkIds.mockReturnValue([{ id: 'l1', projectId: 'p1' }])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Alpha'] }))

    expect(insertProjectLink).not.toHaveBeenCalled()
    expect(deleteProjectLink).not.toHaveBeenCalled()
  })

  it('drops a name that resolves to no project without touching links', async () => {
    listProjectsByNames.mockReturnValue([])
    listNoteProjectLinkIds.mockReturnValue([])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Ghost'] }))

    expect(insertProjectLink).not.toHaveBeenCalled()
  })

  it('resolves a duplicate name to the oldest project', async () => {
    listProjectsByNames.mockReturnValue([
      { id: 'old', name: 'Alpha', createdAt: '2026-01-01' },
      { id: 'new', name: 'alpha', createdAt: '2026-05-01' }
    ])
    listNoteProjectLinkIds.mockReturnValue([])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Alpha'] }))

    expect(linkRows).toEqual([expect.objectContaining({ projectId: 'old' })])
  })

  it('ignores a file note', async () => {
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project({
      type: 'note.upserted',
      note: { kind: 'file', noteId: 'f1' } as never
    })

    expect(listNoteProjectLinkIds).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run and confirm it fails**

```bash
pnpm --filter @memry/desktop test:main -- note-project-links
```

Expected: FAIL — module not found.

- [ ] **Step 5: Add the two link mutations the projector needs**

In `apps/desktop/src/main/database/queries/projects.ts`:

```ts
export function insertProjectLink(
  db: DataDb,
  row: { id: string; projectId: string; itemType: string; itemId: string }
): void {
  db.insert(projectLinks).values(row).run()
}

export function deleteProjectLink(db: DataDb, id: string): void {
  db.delete(projectLinks).where(eq(projectLinks.id, id)).run()
}
```

> If equivalents already exist in this file, use those instead of adding duplicates
> and update the test's mock names to match.

- [ ] **Step 6: Implement the projector**

Create `.../projectors/note-project-links-projector.ts`:

```ts
import { randomUUID } from 'crypto'
import { createLogger } from '../../lib/logger'
import { getDatabase } from '../../database'
import {
  deleteProjectLink,
  insertProjectLink,
  listNoteProjectLinkIds,
  listProjectsByNames
} from '../../database/queries/projects'
import { readProjectNames } from '../../notes/project-property'
import { syncProjectUpdate } from '../../tasks/runtime-effects'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:NoteProjectLinks')

/**
 * Derives a markdown note's `project_links` rows from its frontmatter, which is
 * the source of truth. Rows that survive the diff are never deleted and
 * reinserted — that is what preserves `position` and `pinned`.
 */
function reconcileNoteLinks(noteId: string, properties: Record<string, unknown>): void {
  const db = getDatabase()

  const names = readProjectNames(properties)
  const resolved = listProjectsByNames(db, names)

  // `listProjectsByNames` is ordered oldest-first, so the first write per lowered
  // name wins and later duplicates are the ambiguous ones.
  const byName = new Map<string, string>()
  for (const project of resolved) {
    const key = project.name.toLowerCase()
    if (byName.has(key)) {
      logger.warn('Ambiguous project name, resolving to the oldest', { name: project.name })
      continue
    }
    byName.set(key, project.id)
  }

  const desired = new Set<string>()
  for (const name of names) {
    const projectId = byName.get(name.toLowerCase())
    if (!projectId) {
      logger.debug('Project name matches no project, leaving it unlinked', { noteId, name })
      continue
    }
    desired.add(projectId)
  }

  const existing = listNoteProjectLinkIds(db, noteId)
  const existingByProject = new Map(existing.map((row) => [row.projectId, row.id]))
  const touched = new Set<string>()

  for (const projectId of desired) {
    if (existingByProject.has(projectId)) continue
    insertProjectLink(db, {
      id: randomUUID(),
      projectId,
      itemType: 'note',
      itemId: noteId
    })
    touched.add(projectId)
  }

  for (const row of existing) {
    if (desired.has(row.projectId)) continue
    deleteProjectLink(db, row.id)
    touched.add(row.projectId)
  }

  // A project's links only sync because its own payload carries them.
  for (const projectId of touched) {
    syncProjectUpdate(projectId, ['links'])
  }
}

export function createNoteProjectLinksProjector(): ProjectionProjector {
  return {
    name: 'note-project-links',

    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type !== 'note.upserted') return
      if (event.note.kind !== 'markdown') return

      try {
        reconcileNoteLinks(event.note.noteId, event.note.properties)
      } catch (err) {
        // A reconcile failure must not stall the projection queue behind it.
        logger.error('Failed to reconcile project links', err)
      }
    },

    async rebuild(): Promise<void> {},

    async reconcile(): Promise<void> {}
  }
}
```

> `note.deleted` is deliberately not handled — `cleanupProjectLinksForDeletedNote`
> already clears links for a deleted note and additionally clears home-note
> references, which this projector must not duplicate.

- [ ] **Step 7: Register the projector**

In `apps/desktop/src/main/vault/index.ts`, import it next to the existing projector
import at line 55 and add it to the array at line 275:

```ts
    createNoteDerivedStateProjector(() => vaultPath),
    createNoteProjectLinksProjector(),
```

- [ ] **Step 8: Run and confirm it passes**

```bash
pnpm --filter @memry/desktop test:main -- note-project-links
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/notes/project-property.ts apps/desktop/src/main/projections/ apps/desktop/src/main/database/queries/projects.ts apps/desktop/src/main/vault/index.ts
git commit -m "feat(projects): derive note project links from frontmatter"
```

---

### Task 8: Reroute link/unlink for markdown notes

**Files:**

- Modify: `apps/desktop/src/main/ipc/tasks-handlers.ts:220-238`
- Modify: `apps/desktop/src/main/database/queries/projects.ts`
- Test: `apps/desktop/src/main/ipc/tasks-handlers.project-links.test.ts`

**Interfaces:**

- Consumes: `setEntityProperties`, `getEntityPropertiesRecord` (Task 6); `readProjectNames`, `withProjectName`, `withoutProjectName` (Task 7).
- Produces: `isMarkdownNote(db, itemId): boolean` in `projects.ts`.

With frontmatter as the source of truth, a caller that writes a link row directly has
its row deleted by the reconciler on the note's next index pass. Sidebar
drag-and-drop, project-hub URL capture and the MCP `tasks.linkProjectItem` tool all
land on these two handlers, so branching here fixes every caller at once without
touching `domain-tasks`, the RPC signatures or the MCP allowlist.

- [ ] **Step 1: Add the discriminator query**

In `apps/desktop/src/main/database/queries/projects.ts`:

```ts
/**
 * True when the id resolves to a markdown note — the one item kind whose project
 * links are derived from frontmatter. Keys off `file_type`, not the caller's
 * `item_type`: a binary file can carry `item_type: 'note'` from before a
 * conversion, and treating it as frontmatter-owned would drop its link.
 */
export function isMarkdownNote(db: DataDb, itemId: string): boolean {
  const row = db
    .select({ fileType: noteMetadata.fileType })
    .from(noteMetadata)
    .where(eq(noteMetadata.id, itemId))
    .get()
  return row?.fileType === 'markdown'
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/ipc/tasks-handlers.project-links.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { linkProjectItem, unlinkProjectItem } from './project-item-links'

const isMarkdownNote = vi.fn()
const getProjectById = vi.fn()
const setEntityProperties = vi.fn()
const getEntityPropertiesRecord = vi.fn()
const domainLink = vi.fn()
const domainUnlink = vi.fn()

vi.mock('../database/queries/projects', () => ({
  isMarkdownNote: (...a: unknown[]) => isMarkdownNote(...a),
  getProject: (...a: unknown[]) => getProjectById(...a)
}))
vi.mock('../notes/entity-properties', () => ({
  setEntityProperties: (...a: unknown[]) => setEntityProperties(...a),
  getEntityPropertiesRecord: (...a: unknown[]) => getEntityPropertiesRecord(...a)
}))

const domain = { linkItemToProject: domainLink, unlinkItemFromProject: domainUnlink }

describe('project item link reroute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setEntityProperties.mockResolvedValue({ success: true })
    getProjectById.mockReturnValue({ id: 'p1', name: 'Alpha' })
  })

  it('writes frontmatter for a markdown note instead of a link row', async () => {
    isMarkdownNote.mockReturnValue(true)
    getEntityPropertiesRecord.mockReturnValue({ project: ['Beta'] })

    const result = await linkProjectItem({} as never, domain as never, {
      projectId: 'p1',
      itemType: 'note',
      itemId: 'n1'
    })

    expect(result).toEqual({ success: true })
    expect(setEntityProperties).toHaveBeenCalledWith('n1', { project: ['Beta', 'Alpha'] })
    expect(domainLink).not.toHaveBeenCalled()
  })

  it('is a no-op when the note already names the project', async () => {
    isMarkdownNote.mockReturnValue(true)
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha'] })

    await linkProjectItem({} as never, domain as never, {
      projectId: 'p1',
      itemType: 'note',
      itemId: 'n1'
    })

    expect(setEntityProperties).toHaveBeenCalledWith('n1', { project: ['Alpha'] })
  })

  it('falls through to the domain for a file', async () => {
    isMarkdownNote.mockReturnValue(false)
    domainLink.mockResolvedValue({ success: true })

    await linkProjectItem({} as never, domain as never, {
      projectId: 'p1',
      itemType: 'file',
      itemId: 'f1'
    })

    expect(domainLink).toHaveBeenCalled()
    expect(setEntityProperties).not.toHaveBeenCalled()
  })

  it('removes the name from frontmatter on unlink', async () => {
    isMarkdownNote.mockReturnValue(true)
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha', 'Beta'] })

    await unlinkProjectItem({} as never, domain as never, {
      projectId: 'p1',
      itemType: 'note',
      itemId: 'n1'
    })

    expect(setEntityProperties).toHaveBeenCalledWith('n1', { project: ['Beta'] })
  })

  it('errors when the project does not exist', async () => {
    isMarkdownNote.mockReturnValue(true)
    getProjectById.mockReturnValue(undefined)

    expect(
      await linkProjectItem({} as never, domain as never, {
        projectId: 'gone',
        itemType: 'note',
        itemId: 'n1'
      })
    ).toEqual({ success: false, error: 'Project not found' })
  })
})
```

- [ ] **Step 3: Run and confirm it fails**

```bash
pnpm --filter @memry/desktop test:main -- project-links
```

Expected: FAIL — `./project-item-links` does not exist.

- [ ] **Step 4: Implement the branch**

Create `apps/desktop/src/main/ipc/project-item-links.ts`:

```ts
import { createLogger } from '../lib/logger'
import { getProject, isMarkdownNote } from '../database/queries/projects'
import { getEntityPropertiesRecord, setEntityProperties } from '../notes/entity-properties'
import { readProjectNames, withProjectName, withoutProjectName } from '../notes/project-property'
import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'
import type { DataDb } from '../database/types'

const logger = createLogger('IPC:ProjectItemLinks')

interface LinkInput {
  projectId: string
  itemType: string
  itemId: string
}

interface LinkDomain {
  linkItemToProject(input: LinkInput): Promise<{ success: boolean; error?: string }>
  unlinkItemFromProject(input: LinkInput): Promise<{ success: boolean; error?: string }>
}

type Result = { success: true } | { success: false; error: string }

async function writeNames(
  itemId: string,
  next: (names: string[], projectName: string) => string[],
  projectName: string
): Promise<Result> {
  const properties = getEntityPropertiesRecord(itemId)
  if (!properties) return { success: false, error: 'Entity not found' }

  const names = next(readProjectNames(properties), projectName)
  const result = await setEntityProperties(itemId, {
    ...properties,
    [PROJECT_PROPERTY_KEY]: names
  })
  return result.success ? { success: true } : { success: false, error: result.error }
}

/**
 * A markdown note's project membership lives in its frontmatter; the projector
 * derives the link row. Writing the row here instead would have it deleted on the
 * note's next index pass. Every other item kind keeps the table-native path.
 */
export async function linkProjectItem(
  db: DataDb,
  domain: LinkDomain,
  input: LinkInput
): Promise<Result> {
  if (!isMarkdownNote(db, input.itemId)) {
    const result = await domain.linkItemToProject(input)
    return result.success
      ? { success: true }
      : { success: false, error: result.error ?? 'Failed to link item' }
  }

  const project = getProject(db, input.projectId)
  if (!project) return { success: false, error: 'Project not found' }

  logger.debug('link via frontmatter', { itemId: input.itemId, project: project.name })
  return writeNames(input.itemId, withProjectName, project.name)
}

export async function unlinkProjectItem(
  db: DataDb,
  domain: LinkDomain,
  input: LinkInput
): Promise<Result> {
  if (!isMarkdownNote(db, input.itemId)) {
    const result = await domain.unlinkItemFromProject(input)
    return result.success
      ? { success: true }
      : { success: false, error: result.error ?? 'Failed to unlink item' }
  }

  const project = getProject(db, input.projectId)
  if (!project) return { success: false, error: 'Project not found' }

  return writeNames(input.itemId, withoutProjectName, project.name)
}
```

> `getProject` already exists in `queries/projects.ts`. If its exported name differs,
> use the real one in both the module and the test mock.

- [ ] **Step 5: Use it from the handlers**

In `apps/desktop/src/main/ipc/tasks-handlers.ts`, replace the two handler bodies:

```ts
ipcMain.handle(
  TasksChannels.invoke.PROJECT_LINK_ITEM,
  createValidatedHandler(
    ProjectLinkItemSchema,
    withDb((db, input) => linkProjectItem(db, createTaskDomain(db), input), 'Failed to link item')
  )
)

ipcMain.handle(
  TasksChannels.invoke.PROJECT_UNLINK_ITEM,
  createValidatedHandler(
    ProjectLinkItemSchema,
    withDb(
      (db, input) => unlinkProjectItem(db, createTaskDomain(db), input),
      'Failed to unlink item'
    )
  )
)
```

In the same file, the `PROJECT_CAPTURE_URL` handler calls
`domain.linkItemToProject({ projectId, itemType: 'note', itemId: noteId })` — swap it
for `linkProjectItem(db, domain, { projectId, itemType: 'note', itemId: noteId })` so a
captured note gets the frontmatter too.

- [ ] **Step 6: Run and confirm it passes**

```bash
pnpm --filter @memry/desktop test:main -- "project-links|tasks-handlers"
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS (5 new tests plus the existing tasks-handler suite).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/ipc/ apps/desktop/src/main/database/queries/projects.ts
git commit -m "feat(projects): route markdown-note links through frontmatter"
```

---

### Task 9: Rename and delete propagation

**Files:**

- Create: `apps/desktop/src/main/tasks/project-name-propagation.ts`
- Modify: `apps/desktop/src/main/ipc/tasks-handlers.ts` (project update + delete handlers)
- Modify: `apps/desktop/src/main/database/queries/projects.ts`
- Test: `apps/desktop/src/main/tasks/project-name-propagation.test.ts`

**Interfaces:**

- Consumes: `getEntityPropertiesRecord`, `setEntityProperties` (Task 6); `readProjectNames`, `withoutProjectName` (Task 7).
- Produces:
  ```ts
  export async function propagateProjectRename(
    db: DataDb,
    projectId: string,
    oldName: string,
    newName: string
  ): Promise<void>
  export async function propagateProjectDelete(
    db: DataDb,
    projectId: string,
    name: string
  ): Promise<void>
  export function listMarkdownNoteIdsForProject(db: DataDb, projectId: string): string[]
  ```

Because the name is what lives in frontmatter, a rename that is not propagated leaves
the vault naming a project that no longer exists — and a later project created with
the old name would silently re-adopt those notes.

- [ ] **Step 1: Add the query**

In `apps/desktop/src/main/database/queries/projects.ts`:

```ts
/** Markdown notes linked to a project — the ones whose frontmatter names it. */
export function listMarkdownNoteIdsForProject(db: DataDb, projectId: string): string[] {
  return db
    .select({ id: noteMetadata.id })
    .from(projectLinks)
    .innerJoin(noteMetadata, eq(noteMetadata.id, projectLinks.itemId))
    .where(and(eq(projectLinks.projectId, projectId), eq(noteMetadata.fileType, 'markdown')))
    .all()
    .map((row) => row.id)
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/tasks/project-name-propagation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMarkdownNoteIdsForProject = vi.fn()
const getEntityPropertiesRecord = vi.fn()
const setEntityProperties = vi.fn()

vi.mock('../database/queries/projects', () => ({
  listMarkdownNoteIdsForProject: (...a: unknown[]) => listMarkdownNoteIdsForProject(...a)
}))
vi.mock('../notes/entity-properties', () => ({
  getEntityPropertiesRecord: (...a: unknown[]) => getEntityPropertiesRecord(...a),
  setEntityProperties: (...a: unknown[]) => setEntityProperties(...a)
}))

describe('project name propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setEntityProperties.mockResolvedValue({ success: true })
  })

  it('rewrites the old name in every linked note', async () => {
    listMarkdownNoteIdsForProject.mockReturnValue(['n1', 'n2'])
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha', 'Beta'], status: 'Done' })
    const { propagateProjectRename } = await import('./project-name-propagation')

    await propagateProjectRename({} as never, 'p1', 'Alpha', 'Alpha v2')

    expect(setEntityProperties).toHaveBeenCalledTimes(2)
    expect(setEntityProperties).toHaveBeenCalledWith('n1', {
      project: ['Alpha v2', 'Beta'],
      status: 'Done'
    })
  })

  it('removes the name on delete and keeps the others', async () => {
    listMarkdownNoteIdsForProject.mockReturnValue(['n1'])
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha', 'Beta'] })
    const { propagateProjectDelete } = await import('./project-name-propagation')

    await propagateProjectDelete({} as never, 'p1', 'Alpha')

    expect(setEntityProperties).toHaveBeenCalledWith('n1', { project: ['Beta'] })
  })

  it('skips a note whose frontmatter never named the project', async () => {
    listMarkdownNoteIdsForProject.mockReturnValue(['n1'])
    getEntityPropertiesRecord.mockReturnValue({ project: ['Beta'] })
    const { propagateProjectRename } = await import('./project-name-propagation')

    await propagateProjectRename({} as never, 'p1', 'Alpha', 'Alpha v2')

    expect(setEntityProperties).not.toHaveBeenCalled()
  })

  it('keeps going when one note fails to write', async () => {
    listMarkdownNoteIdsForProject.mockReturnValue(['n1', 'n2'])
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha'] })
    setEntityProperties.mockRejectedValueOnce(new Error('locked'))
    const { propagateProjectDelete } = await import('./project-name-propagation')

    await propagateProjectDelete({} as never, 'p1', 'Alpha')

    expect(setEntityProperties).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 3: Run and confirm it fails**

```bash
pnpm --filter @memry/desktop test:main -- project-name-propagation
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `apps/desktop/src/main/tasks/project-name-propagation.ts`:

```ts
import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'
import { createLogger } from '../lib/logger'
import { listMarkdownNoteIdsForProject } from '../database/queries/projects'
import { getEntityPropertiesRecord, setEntityProperties } from '../notes/entity-properties'
import { readProjectNames, withoutProjectName } from '../notes/project-property'
import type { DataDb } from '../database/types'

const logger = createLogger('ProjectNamePropagation')

async function rewriteLinkedNotes(
  db: DataDb,
  projectId: string,
  rewrite: (names: string[]) => string[]
): Promise<void> {
  const noteIds = listMarkdownNoteIdsForProject(db, projectId)

  for (const noteId of noteIds) {
    const properties = getEntityPropertiesRecord(noteId)
    if (!properties) continue

    const names = readProjectNames(properties)
    const next = rewrite(names)
    if (next.length === names.length && next.every((n, i) => n === names[i])) continue

    try {
      await setEntityProperties(noteId, { ...properties, [PROJECT_PROPERTY_KEY]: next })
    } catch (err) {
      // One unwritable note must not abandon the rest — a half-propagated rename
      // is recoverable, an abandoned one leaves the vault inconsistent.
      logger.error('Failed to propagate project name to note', { noteId, err })
    }
  }
}

/** Frontmatter stores the name, so a rename must reach every linked note. */
export async function propagateProjectRename(
  db: DataDb,
  projectId: string,
  oldName: string,
  newName: string
): Promise<void> {
  if (oldName === newName) return
  await rewriteLinkedNotes(db, projectId, (names) =>
    names.map((name) => (name.toLowerCase() === oldName.toLowerCase() ? newName : name))
  )
}

export async function propagateProjectDelete(
  db: DataDb,
  projectId: string,
  name: string
): Promise<void> {
  await rewriteLinkedNotes(db, projectId, (names) => withoutProjectName(names, name))
}
```

- [ ] **Step 5: Call it from the handlers**

In `apps/desktop/src/main/ipc/tasks-handlers.ts`:

- In the `PROJECT_UPDATE` handler, read the project **before** the domain call to
  capture its current name, then after a successful update with a changed `name`,
  `await propagateProjectRename(db, input.id, previousName, input.name)`.
- In the `PROJECT_DELETE` handler, collect the note ids and the project name
  **before** `deleteProject` (the FK cascade removes the links), then
  `await propagateProjectDelete(...)` after. Since the links are gone by then, capture
  `listMarkdownNoteIdsForProject(db, id)` first and pass those ids through — add an
  optional `noteIds` parameter to `propagateProjectDelete` that short-circuits the
  lookup when provided.

Update the test for the delete path to pass explicit ids once the parameter exists.

- [ ] **Step 6: Run and confirm it passes**

```bash
pnpm --filter @memry/desktop test:main -- "project-name-propagation|tasks-handlers"
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/tasks/project-name-propagation.ts apps/desktop/src/main/tasks/project-name-propagation.test.ts apps/desktop/src/main/ipc/tasks-handlers.ts apps/desktop/src/main/database/queries/projects.ts
git commit -m "feat(projects): propagate project rename and delete into note frontmatter"
```

---

### Task 10: Sync payload split

**Files:**

- Modify: `apps/desktop/src/main/sync/item-handlers/project-handler.ts:194,234,278,293,314`
- Modify: `apps/desktop/src/main/database/queries/projects.ts`
- Test: `apps/desktop/src/main/sync/item-handlers/project-handler.test.ts`

**Interfaces:**

- Produces: `listTableOwnedProjectLinks(db, projectId)` — a project's links minus the frontmatter-owned ones.

A note's project membership now travels inside the note payload. Leaving the same
links in the project payload would make a project pull authoritative over them, and
`reconcileLinks` would delete the rows the local frontmatter had just produced.

- [ ] **Step 1: Add the filtered query**

In `apps/desktop/src/main/database/queries/projects.ts`:

```ts
/**
 * A project's links minus the frontmatter-owned ones. Markdown-note membership
 * rides along in the note payload; carrying it here too would let a project pull
 * delete rows the local frontmatter had just derived.
 */
export function listTableOwnedProjectLinks(db: DataDb, projectId: string): ProjectLink[] {
  return db
    .select()
    .from(projectLinks)
    .leftJoin(noteMetadata, eq(noteMetadata.id, projectLinks.itemId))
    .where(
      and(
        eq(projectLinks.projectId, projectId),
        or(isNull(noteMetadata.id), ne(noteMetadata.fileType, 'markdown'))
      )
    )
    .all()
    .map((row) => row.project_links)
}
```

> Add `or`, `ne`, `isNull` to the `drizzle-orm` import. Confirm the joined result key
> (`row.project_links`) against how other joined selects in this file unwrap rows.

- [ ] **Step 2: Write the failing test**

Add to `apps/desktop/src/main/sync/item-handlers/project-handler.test.ts`:

```ts
it('omits markdown-note links from the pushed payload', () => {
  // seed: project p1 with a link to markdown note n1 and to file f1
  const payload = JSON.parse(handler.serialize(db, 'p1') as string)

  expect(payload.links.map((l: { itemId: string }) => l.itemId)).toEqual(['f1'])
})

it('keeps a derived markdown-note link when a project is pulled', async () => {
  // seed: local project p1 with a derived link to markdown note n1
  await handler.applyUpsert(db, 'p1', {
    id: 'p1',
    name: 'Alpha',
    links: [{ projectId: 'p1', itemType: 'file', itemId: 'f1' }]
  })

  expect(listNoteProjectLinkIds(db, 'n1')).toHaveLength(1)
})
```

> Match the real handler API and the existing test file's seeding helpers; the two
> assertions above are the behaviours that must hold, not the exact call shapes.

- [ ] **Step 3: Run and confirm it fails**

```bash
pnpm --filter @memry/desktop test:main -- project-handler
```

Expected: FAIL — the payload carries `n1`, and `reconcileLinks` deletes the derived row.

- [ ] **Step 4: Split the push side**

In `project-handler.ts`, replace each of the four
`db.select().from(projectLinks).where(eq(projectLinks.projectId, ...)).all()` calls
(lines 278, 293, 314, and the enqueue path) with
`listTableOwnedProjectLinks(db, <projectId>)`.

- [ ] **Step 5: Preserve derived rows on the pull side**

In `reconcileLinks`, restrict the delete pass to table-owned rows so a remote payload
can never remove a locally derived one:

```ts
function reconcileLinks(db: DrizzleDb, projectId: string, remote: ProjectLink[]): void {
  const existing = listTableOwnedProjectLinks(db as unknown as DataDb, projectId)
  // ...diff `remote` against `existing` only; markdown-note rows are not in
  // `existing`, so they are neither compared nor deleted.
}
```

Remote payloads written by older builds still list markdown-note links; those entries
are skipped rather than rejected, keeping the change backward compatible in both
directions. Filter them out of `remote` before the diff:

```ts
const incoming = remote.filter((link) => !isMarkdownNote(db as unknown as DataDb, link.itemId))
```

- [ ] **Step 6: Run and confirm it passes**

```bash
pnpm --filter @memry/desktop test:main -- project-handler
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers/project-handler.ts apps/desktop/src/main/database/queries/projects.ts apps/desktop/src/main/sync/item-handlers/project-handler.test.ts
git commit -m "feat(sync): keep frontmatter-owned project links out of the project payload"
```

---

### Task 11: Project properties in templates

Added after the plan was written, on an explicit human decision. The design spec listed
template support as out of scope; that ruling is superseded — Kaan chose full support over
both removing the option and deferring it.

**Files:**

- Modify: `packages/contracts/src/templates-api.ts` — `TemplatePropertyType` + `TemplatePropertySchema`
- Modify: `apps/desktop/src/renderer/src/pages/template-editor.tsx` — the two type maps
- Test: `packages/contracts/src/templates-api.test.ts`, plus a renderer test for the maps

**Interfaces:**

- Consumes: `PROJECT_PROPERTY_KEY` and the `project` property type (Task 1); `ProjectEditor` (Task 4); the reconciler (Task 7).
- Produces: `TemplatePropertyType` includes `'project'`.

Today `template-editor.tsx` maps `project → 'text'` on save, so picking "Project" in the
template editor silently produces a text property. The apply path itself needs no change:
`apply-template.ts:30` merges `applied.properties` into the note's properties generically, so
a template carrying `project: ['Alpha']` lands in the note's frontmatter and Task 7's
projector derives the link on the next write.

- [ ] **Step 1: Establish the backward-compatibility position before writing code**

`TemplatePropertySchema` in `packages/contracts/src/templates-api.ts` is a strict `z.enum` of
eight types. A template carrying `type: 'project'` fails that validation. Before changing
anything, determine and report:

- every path on which a template is parsed through this schema (IPC input validation, file read, sync apply);
- whether any of those paths can be reached by an **older** build reading data a newer build wrote — templates on disk, or the template sync item type;
- what an older build actually does on a validation failure: skip that property, drop the whole template, or throw.

If an older build would drop or reject a whole template, **stop and report BLOCKED** with what
you found. Silently making older builds lose templates is not an acceptable cost, and the fix
would be a schema-tolerance change that needs its own decision.

If the strict enum is only ever applied to renderer→main IPC input on the current build, note
that and proceed.

- [ ] **Step 2: Write the failing contract test**

In `packages/contracts/src/templates-api.test.ts`:

```ts
it('accepts a project property', () => {
  const result = TemplatePropertySchema.safeParse({
    name: 'project',
    type: 'project',
    value: ['Alpha']
  })

  expect(result.success).toBe(true)
})
```

> Match the file's existing test style; the surrounding suite already covers the other types.

- [ ] **Step 3: Run it and confirm it fails**

```bash
pnpm --filter @memry/contracts test -- templates-api
```

Expected: FAIL — `type` is not one of the eight enum members.

- [ ] **Step 4: Widen the contract**

Add `| 'project'` to `TemplatePropertyType`, and `'project'` to the schema's `z.enum([...])`
list. Keep the existing eight members in place and in order.

- [ ] **Step 5: Stop the template editor degrading the type**

In `apps/desktop/src/renderer/src/pages/template-editor.tsx`, change the outbound map entry
from `project: 'text'` to `project: 'project'`, and add the inbound direction to
`mapFromTemplatePropertyType`.

Also check that the default value for a `project` property is `[]`, matching the array shape
the rest of the feature uses. Task 3 added that to `lib/property-utils.ts`; confirm which
helper this file actually calls rather than assuming.

- [ ] **Step 6: Write the round-trip test**

A renderer test asserting a `project` property survives `mapToTemplatePropertyType` →
`mapFromTemplatePropertyType` as `'project'`, not `'text'`. Put it beside the template
editor's existing tests; if that file has none, create `template-editor.test.tsx` covering
just the two maps.

- [ ] **Step 7: Verify end to end in the running app**

```bash
pnpm dev
```

Create a template, add a Project property, pick a project, save. Apply the template to a fresh
note. The note's `project` property carries the name, the note appears in that project's hub,
and the `.md` file on disk carries `project:` in its frontmatter.

- [ ] **Step 8: Run the gate and commit**

```bash
pnpm --filter @memry/contracts test -- templates-api
```

```bash
pnpm --filter @memry/desktop test:renderer
```

```bash
pnpm ipc:generate && pnpm ipc:check
```

```bash
git commit -am "feat(templates): support project properties in templates"
```

---

### Task 12: Full verification and docs

**Files:**

- Modify: `apps/docs/src/**` (whatever `docs:impact` names)

- [ ] **Step 1: Regenerate and check the IPC contract**

```bash
pnpm ipc:generate
pnpm ipc:check
```

Expected: clean. Commit any regenerated file.

- [ ] **Step 2: Run the full gate**

Run these one at a time — running tests and the docs build in parallel has SIGSEGV'd before.

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm --filter @memry/desktop i18n:check
```

```bash
git diff --check
```

Expected: all green. Pre-existing failures in `websocket.test.ts` and `folders.test.ts` are known and unrelated.

- [ ] **Step 3: Manual check in the running app**

```bash
pnpm dev
```

Walk through, on both a note and a journal entry:

1. The `⋯` menu no longer offers "Add to project" and no pill row appears under the title.
2. Add property → Project creates a `project` row; the type entry is disabled afterwards.
3. Picking a project shows its emoji and colour; the note appears in that project's hub.
4. `×` removes it; the note leaves the hub.
5. Dragging the note onto a project in the sidebar fills the property.
6. Renaming the project updates the property; deleting it clears the value.
7. The `.md` file on disk carries `project:` with the project name.

- [ ] **Step 4: Docs gate**

```bash
pnpm docs:impact --base origin/main --strict
```

If it reports `missing-docs`, update `apps/docs/src/**` or run
`pnpm docs:ai-update --base origin/main`, then re-run the strict check and:

```bash
pnpm docs:build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: cover the project property"
```

---

## Self-Review

**Spec coverage**

| Spec section                                          | Task                                                    |
| ----------------------------------------------------- | ------------------------------------------------------- |
| Ownership split (`file_type` discriminator)           | 8 (`isMarkdownNote`), 10 (`listTableOwnedProjectLinks`) |
| Frontmatter shape, array, `project: []`               | 2, 4, 7 (`readProjectNames`)                            |
| New property type + reserved key                      | 1, 2                                                    |
| `ProjectEditor` (emoji, colour, ×, unknown, archived) | 4                                                       |
| Removals (menu item, chips, dialog)                   | 5                                                       |
| Reconciler (resolution, duplicates, position/pinned)  | 7                                                       |
| Rerouted write paths (drag, capture, MCP)             | 8                                                       |
| Rename / delete propagation                           | 9                                                       |
| Sync payload split                                    | 10                                                      |
| Testing + i18n + docs                                 | 3, 11                                                   |

**Known follow-through inside tasks:** Task 9 Step 5 adds an optional `noteIds`
parameter to `propagateProjectDelete` because the FK cascade removes the links before
propagation can read them; the Step 2 test is updated in the same step.

**Out of scope (per spec):** files and calendar events keep the dialog and pill row;
folder-view filtering by the project property; project properties in templates.
