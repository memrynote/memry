# Settings Template Preview + Close-on-Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Settings → Templates, let users drill into a read-only preview of any template (built-in or custom), and close the settings modal when an action opens a template-editor tab.

**Architecture:** Renderer-only. Add a focused `TemplatePreview` component that loads a template via the existing `getTemplate` IPC path and renders it read-only by reusing `ContentArea` (`editable={false}`). `TemplatesSettings` gains a `previewId` state that replaces the list with the preview (drill-in), and calls `useSettingsModal().close()` before opening editor tabs.

**Tech Stack:** React 19, TanStack Query, Vitest + React Testing Library, Tailwind (logical props), shadcn UI.

## Global Constraints

- **Renderer-only.** No main-process, IPC, contract, preload, or DB changes. Do NOT run `ipc:generate`/`ipc:check`.
- **New files use logical Tailwind classes** (RTL): `ms/me`, `ps/pe`, `start/end`, `text-start/end`, `border-s/e`, `rounded-s/e`. `px-*`/`py-*`/`gap-*` are allowed (axis-neutral). The renderer guard scans whole new files.
- **Prettier:** single quotes, no semicolons, 100 char width, no trailing commas.
- **No new i18n keys.** Reuse existing `settings` namespace keys: back-button label = `templates.header.title`, built-in badge = `templates.groups.builtIn`. (If their wording reads wrong in the running app, that's a trivial follow-up, not part of this plan.)
- **a11y:** a clickable row is a `role="button"` with `tabIndex={0}` and an Enter/Space `onKeyDown` handler.
- **Drill-in is pure preview** for all templates. Editing a custom template stays on the row `⋯ → Edit` path (which now also closes settings). No "Open in editor" button in the preview.
- **Reuse, don't re-mount.** Do not embed `TemplateEditorPage` in the modal. Build the focused `TemplatePreview`.

## Reference: exact current code

- `apps/desktop/src/renderer/src/pages/settings/templates-section.tsx`
  - `handleCreateTemplate` (lines 36-47): calls `openTab({ type: 'template-editor', path: '/templates/new', ... })`. No `close()`.
  - `handleEditTemplate` (lines 49-64): calls `openTab({ type: 'template-editor', entityId: id, ... })`. No `close()`.
  - `TemplateRow` (lines 221-268): row container `<div className="flex items-center justify-between h-11 py-3 px-4 shrink-0 group">`; built-in branch renders `<Lock />`, custom branch renders the `⋯` `DropdownMenu` (trigger `<button>` at lines 242-246).
- `apps/desktop/src/renderer/src/contexts/settings-modal-context.tsx`: `useSettingsModal()` returns `{ close, ... }`; `close()` sets `isOpen=false`.
- `apps/desktop/src/renderer/src/pages/template-editor.tsx` (lines 549-562): loads a template via `const { getTemplate } = useTemplates({ autoLoad: false })` + `useQuery({ queryKey: ['template-editor', templateId], queryFn: () => getTemplate(templateId), enabled: !!templateId })`; renders `<ContentArea ... editable={!isBuiltIn} />` (line 525-535). Proves `ContentArea` renders template markdown read-only outside CRDT.
- `ContentArea` (`@/components/note/content-area`) props (`content-area/types.ts:80`): all optional; relevant ones `initialContent?: string`, `contentType?: 'markdown'`, `editable?: boolean`.
- `Template` / `TemplateProperty` types: `@/services/templates-service`. `Template` has `{ id, name, description?, icon?, isBuiltIn, tags, properties, content, createdAt, modifiedAt }`. `TemplateProperty` has `{ name, type, value, options? }`.

---

### Task 1: Close settings modal on create / edit

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/settings/templates-section.tsx`
- Test: `apps/desktop/src/renderer/src/pages/settings/templates-section.test.tsx` (create)

**Interfaces:**

- Consumes: `useSettingsModal()` from `@/contexts/settings-modal-context` → `{ close: () => void }`.
- Produces: nothing new exported; behavior change only.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/settings/templates-section.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { openTabSpy, closeSpy } = vi.hoisted(() => ({
  openTabSpy: vi.fn(),
  closeSpy: vi.fn()
}))

vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ openTab: openTabSpy }) }))
vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ close: closeSpy })
}))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    templates: [
      {
        id: 'meeting-notes',
        name: 'Meeting Notes',
        description: 'desc',
        icon: null,
        isBuiltIn: true
      },
      { id: 'custom-1', name: 'My Tmpl', description: '', icon: null, isBuiltIn: false }
    ],
    isLoading: false,
    deleteTemplate: vi.fn(),
    duplicateTemplate: vi.fn()
  })
}))
// Stub the preview so list tests never mount the real BlockNote editor.
vi.mock('./template-preview', () => ({
  TemplatePreview: ({ templateId, onBack }: { templateId: string; onBack: () => void }) => (
    <div data-testid="template-preview" data-template-id={templateId}>
      <button onClick={onBack}>back</button>
    </div>
  )
}))

import { TemplatesSettings } from './templates-section'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TemplatesSettings — close on open', () => {
  it('closes settings and opens a tab when creating a template', () => {
    render(<TemplatesSettings />)
    fireEvent.click(screen.getByText('templates.actions.new'))
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(openTabSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'template-editor', path: '/templates/new' })
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- templates-section`
Expected: FAIL — `closeSpy` not called (current `handleCreateTemplate` never calls `close()`). (The `./template-preview` mock points at a module that does not exist yet; that is fine — `vi.mock` with a factory does not require the real file. If the run errors on the missing import instead of asserting, that still counts as red; proceed to Step 3.)

- [ ] **Step 3: Write minimal implementation**

In `templates-section.tsx`, add the import near the other context imports (after line 22 `import { useTabs } from '@/contexts/tabs'`):

```tsx
import { useSettingsModal } from '@/contexts/settings-modal-context'
```

Inside `TemplatesSettings`, after `const { openTab } = useTabs()` (line 31), add:

```tsx
const { close: closeSettings } = useSettingsModal()
```

In `handleCreateTemplate`, call `closeSettings()` before `openTab(...)` and add it to the dependency array:

```tsx
const handleCreateTemplate = useCallback(() => {
  closeSettings()
  openTab({
    type: 'template-editor',
    title: t('templates.newTemplateTitle'),
    icon: 'file-text',
    path: '/templates/new',
    isPinned: false,
    isModified: false,
    isPreview: false,
    isDeleted: false
  })
}, [closeSettings, openTab, t])
```

In `handleEditTemplate`, do the same — `closeSettings()` first, add to deps:

```tsx
const handleEditTemplate = useCallback(
  (id: string, name: string) => {
    closeSettings()
    openTab({
      type: 'template-editor',
      title: name,
      icon: 'file-text',
      path: `/templates/${id}`,
      entityId: id,
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  },
  [closeSettings, openTab]
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- templates-section`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/templates-section.tsx \
        apps/desktop/src/renderer/src/pages/settings/templates-section.test.tsx
git commit -m "feat(templates): close settings modal when opening template editor"
```

---

### Task 2: `TemplatePreview` read-only component

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/settings/template-preview.tsx`
- Test: `apps/desktop/src/renderer/src/pages/settings/template-preview.test.tsx`

**Interfaces:**

- Consumes: `useTemplates({ autoLoad: false }).getTemplate(id) => Promise<Template | null>`; `ContentArea` from `@/components/note/content-area`.
- Produces: `export function TemplatePreview({ templateId, onBack }: { templateId: string; onBack: () => void })`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/settings/template-preview.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type ReactElement } from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getTemplateMock } = vi.hoisted(() => ({ getTemplateMock: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({ getTemplate: getTemplateMock })
}))
vi.mock('@/components/note/content-area', () => ({
  ContentArea: (props: { initialContent?: string; editable?: boolean }) => (
    <div data-testid="content-area" data-editable={String(props.editable)}>
      {props.initialContent}
    </div>
  )
}))

import { TemplatePreview } from './template-preview'

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const template = {
  id: 'meeting-notes',
  name: 'Meeting Notes',
  description: 'Capture agenda',
  icon: null,
  isBuiltIn: true,
  tags: [],
  properties: [{ name: 'date', type: 'date', value: null }],
  content: '# Meeting\n## Notes',
  createdAt: 0,
  modifiedAt: 0
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TemplatePreview', () => {
  it('renders content read-only with a built-in badge and properties', async () => {
    getTemplateMock.mockResolvedValue(template)
    renderWithQuery(<TemplatePreview templateId="meeting-notes" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Meeting Notes')).toBeInTheDocument())
    const content = screen.getByTestId('content-area')
    expect(content).toHaveAttribute('data-editable', 'false')
    expect(content).toHaveTextContent('# Meeting')
    expect(screen.getByText('templates.groups.builtIn')).toBeInTheDocument()
    expect(screen.getByText('date')).toBeInTheDocument()
  })

  it('calls onBack when the back button is clicked', async () => {
    getTemplateMock.mockResolvedValue(template)
    const onBack = vi.fn()
    renderWithQuery(<TemplatePreview templateId="meeting-notes" onBack={onBack} />)
    await waitFor(() => expect(screen.getByText('Meeting Notes')).toBeInTheDocument())
    fireEvent.click(screen.getByText('templates.header.title'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- template-preview`
Expected: FAIL — `./template-preview` module does not exist / `TemplatePreview` is not defined.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/renderer/src/pages/settings/template-preview.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Lock, Loader2, FileText } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { ContentArea } from '@/components/note/content-area'
import { useTemplates } from '@/hooks/use-templates'
import { useT } from '@memry/i18n/renderer'

interface TemplatePreviewProps {
  templateId: string
  onBack: () => void
}

export function TemplatePreview({ templateId, onBack }: TemplatePreviewProps) {
  const { t } = useT('settings')
  const { getTemplate } = useTemplates({ autoLoad: false })

  const { data: template, isLoading } = useQuery({
    queryKey: ['template-preview', templateId],
    queryFn: () => getTemplate(templateId)
  })

  return (
    <div className="flex flex-col text-xs/4">
      <div className="mb-3">
        <Button variant="ghost" size="sm" className="gap-1.5 -ms-2" onClick={onBack}>
          <ArrowLeft className="w-3.5 h-3.5" />
          {t('templates.header.title')}
        </Button>
      </div>

      {isLoading || !template ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2.5 mb-1">
            <span className="text-muted-foreground shrink-0">
              {template.icon || <FileText className="w-4 h-4" />}
            </span>
            <h2 className="font-semibold text-sm text-foreground">{template.name}</h2>
            {template.isBuiltIn && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
                <Lock className="w-3 h-3" />
                {t('templates.groups.builtIn')}
              </span>
            )}
          </div>
          {template.description && (
            <p className="text-xs/4 text-muted-foreground mb-4">{template.description}</p>
          )}

          {/* ponytail: minimal read-only property list; swap for InfoSection if exact editor parity is wanted */}
          {template.properties.length > 0 && (
            <div className="mb-4 rounded-md border border-border divide-y divide-border">
              {template.properties.map((prop) => (
                <div key={prop.name} className="flex items-center justify-between px-3 py-1.5">
                  <span className="text-foreground">{prop.name}</span>
                  <span className="text-muted-foreground">{prop.type}</span>
                </div>
              ))}
            </div>
          )}

          <div className="min-h-[200px] rounded-md border border-border p-4 bg-card">
            <ContentArea
              key={templateId}
              initialContent={template.content}
              contentType="markdown"
              editable={false}
            />
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- template-preview`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/template-preview.tsx \
        apps/desktop/src/renderer/src/pages/settings/template-preview.test.tsx
git commit -m "feat(templates): add read-only template preview component"
```

---

### Task 3: Wire drill-in into `TemplatesSettings`

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/settings/templates-section.tsx`
- Test: `apps/desktop/src/renderer/src/pages/settings/templates-section.test.tsx` (extend Task 1 file)

**Interfaces:**

- Consumes: `TemplatePreview` from `./template-preview` (Task 2).
- Produces: `TemplateRow` gains an `onSelect: () => void` prop; row body is clickable.

- [ ] **Step 1: Write the failing tests**

Append to `templates-section.test.tsx` (inside the file, after the existing `describe`):

```tsx
describe('TemplatesSettings — drill-in preview', () => {
  it('replaces the list with a preview when a row is clicked', () => {
    render(<TemplatesSettings />)
    fireEvent.click(screen.getByText('Meeting Notes'))
    const preview = screen.getByTestId('template-preview')
    expect(preview).toHaveAttribute('data-template-id', 'meeting-notes')
    expect(screen.queryByText('templates.actions.new')).not.toBeInTheDocument()
  })

  it('returns to the list from the preview via back', () => {
    render(<TemplatesSettings />)
    fireEvent.click(screen.getByText('Meeting Notes'))
    fireEvent.click(screen.getByText('back'))
    expect(screen.queryByTestId('template-preview')).not.toBeInTheDocument()
    expect(screen.getByText('templates.actions.new')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:renderer -- templates-section`
Expected: FAIL — clicking the row does nothing (no `onSelect`), so no `template-preview` element appears.

- [ ] **Step 3: Write minimal implementation**

In `templates-section.tsx`:

(a) Add the import after the Task 1 import line:

```tsx
import { TemplatePreview } from './template-preview'
```

(b) Add preview state next to the other `useState` calls (after line 34 `const [duplicateId, setDuplicateId] = useState<string | null>(null)`):

```tsx
const [previewId, setPreviewId] = useState<string | null>(null)
```

(c) Wrap the header + groups block so the preview replaces them. Replace the opening of the returned JSX — change:

```tsx
  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader
```

into:

```tsx
  if (previewId) {
    return (
      <div className="flex flex-col text-xs/4">
        <TemplatePreview templateId={previewId} onBack={() => setPreviewId(null)} />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader
```

(The two `AlertDialog`s stay in the non-preview branch; they are only triggered from list rows, so they do not need to render during preview.)

(d) Pass `onSelect` to both `TemplateRow` usages. In the built-in map (line 118-129) and the custom map (line 135-146), add the prop:

```tsx
<TemplateRow
  key={template.id}
  template={template}
  onSelect={() => setPreviewId(template.id)}
  onEdit={() => handleEditTemplate(template.id, template.name)}
  onDuplicate={() => {
    setDuplicateId(template.id)
    setDuplicateName(t('templates.copySuffix', { name: template.name }))
  }}
  onDelete={/* keep existing: null for built-in, setDeleteConfirm for custom */ null}
/>
```

(Keep each map's existing `onDelete` value — `null` for built-in, `() => setDeleteConfirm(template.id)` for custom. Only `onSelect` is added.)

(e) Update `TemplateRowProps` (line 208) to add `onSelect`:

```tsx
interface TemplateRowProps {
  template: {
    id: string
    name: string
    description?: string
    icon?: string | null
    isBuiltIn: boolean
  }
  onSelect: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: (() => void) | null
}
```

(f) Make the row container clickable and stop the menu trigger from bubbling. Change `function TemplateRow({ template, onEdit, onDuplicate, onDelete }: TemplateRowProps)` to destructure `onSelect`, and change the container `<div>` (line 225) plus the menu trigger `<button>` (line 243):

```tsx
function TemplateRow({ template, onSelect, onEdit, onDuplicate, onDelete }: TemplateRowProps) {
  const { t } = useT('settings')

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className="flex items-center justify-between h-11 py-3 px-4 shrink-0 group cursor-pointer hover:bg-muted/40"
    >
```

And the menu trigger button gets `onClick` stop-propagation (so opening the `⋯` menu does not also trigger the row select):

```tsx
<DropdownMenuTrigger asChild>
  <button
    onClick={(e) => e.stopPropagation()}
    className="p-1 rounded text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground transition-all"
  >
    <MoreHorizontal className="w-3.5 h-3.5" />
  </button>
</DropdownMenuTrigger>
```

(The `DropdownMenuItem` handlers — `onEdit`/`onDuplicate`/`onDelete` — render in a Radix portal outside the row, so they do not bubble to `onSelect`; no change needed there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- templates-section`
Expected: PASS (3 tests total: the Task 1 create test + the 2 drill-in tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/templates-section.tsx \
        apps/desktop/src/renderer/src/pages/settings/templates-section.test.tsx
git commit -m "feat(templates): drill into read-only template preview from settings"
```

---

### Task 4: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the web/renderer project**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: exits 0. (Pre-existing unrelated errors per CLAUDE.md gotchas — e.g. shiki in `message.tsx` — may appear; confirm none reference `template-preview.tsx` or `templates-section.tsx`.)

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: 0 errors. In particular the renderer guard must not flag physical Tailwind classes in the new `template-preview.tsx` (only logical/axis-neutral classes were used).

- [ ] **Step 3: Run the two test files together**

Run: `pnpm --filter @memry/desktop test:renderer -- templates-section template-preview`
Expected: PASS (5 tests). If `better-sqlite3` `ERR_DLOPEN_FAILED` appears, run `pnpm --filter @memry/desktop rebuild:node` once in the same shell and re-run.

- [ ] **Step 4: i18n check**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: no NEW failures (this change adds no i18n keys). A pre-existing failure unrelated to templates is acceptable per CLAUDE.md.

- [ ] **Step 5: Manual GUI QA (record results, do not auto-check)**

1. Open Settings → Templates → click **Meeting Notes** row body → read-only BlockNote content + `date`/`attendees` properties + 🔒 built-in badge.
2. Click the back button (`← Templates`) → returns to the list.
3. Click a custom template row body → read-only preview → back.
4. Click **+ New** → settings modal closes → a new editable `template-editor` tab is focused.
5. On a custom row, open `⋯` → **Edit** → settings modal closes → that template's editor tab is focused. Opening `⋯` itself must NOT drill into the preview.

- [ ] **Step 6: Commit (only if Steps 1-4 required incidental fixes)**

```bash
git add -A
git commit -m "chore(templates): verification fixes for template preview"
```

---

## Self-Review

**Spec coverage:**

- Spec §1 (no way to see inside a template) → Task 2 (`TemplatePreview`) + Task 3 (row click drills in). ✓
- Spec §2 (New/Edit open behind modal) → Task 1 (`close()` in `handleCreateTemplate` + `handleEditTemplate`). ✓
- Spec "drill-in replaces list" → Task 3 step 3(c). ✓
- Spec "read-only for all templates; reuse `ContentArea` `editable={false}`" → Task 2 impl. ✓
- Spec "custom row `⋯` keeps Edit/Duplicate/Delete; menu does not trigger drill-in" → Task 3 step 3(f) stop-propagation. ✓
- Spec "pure preview, no Open-in-editor button" → Task 2 omits it. ✓
- Spec verification (typecheck:web, test:renderer, GUI) → Task 4. ✓

**Placeholder scan:** No TBD/TODO. The single inline comment in `template-preview.tsx` is a deliberate `ponytail:` marker, not a deferred requirement. The `onDelete` note in Task 3 step 3(d) explicitly says "keep existing value" and the surrounding tasks show both values — not a placeholder.

**Type consistency:** `getTemplate(id) => Promise<Template | null>` is used identically in Task 2 impl and test. `TemplatePreview` prop shape `{ templateId: string; onBack: () => void }` matches the Task 1 stub mock, the Task 2 component, and the Task 3 wiring. `onSelect: () => void` added to `TemplateRowProps` and passed in both row maps. `ContentArea` props (`initialContent`, `contentType`, `editable`) all exist as optional props in `content-area/types.ts`. ✓
