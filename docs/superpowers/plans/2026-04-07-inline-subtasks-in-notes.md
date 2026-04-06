# Inline Subtasks in Notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create 1-level subtasks in the note editor via indent + checkbox, rendered as full task rows.

**Architecture:** The existing `onChange` handler in `ContentArea.tsx` already auto-converts `checkListItem` blocks to `taskBlock` — including recursing into `block.children`. We extend this pipeline to detect parent context (is the checkListItem a child of a `taskBlock`?), pass `parentId` when creating the task, and add a `parentTaskId` prop to the block spec so the renderer can indent subtask rows. Serialization and deserialization are updated to handle the indented markdown format.

**Tech Stack:** BlockNote (custom block specs), React hooks, existing `tasksService.create({ parentId })` IPC.

**Spec:** `docs/superpowers/specs/2026-04-07-inline-subtasks-in-notes-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/desktop/src/renderer/src/components/note/content-area/task-block/index.tsx` | Modify | Add `parentTaskId` prop to `taskBlock` propSchema |
| `apps/desktop/src/renderer/src/components/note/content-area/task-block/task-block-renderer.tsx` | Modify | Read `parentTaskId`, apply `ml-7` indent when present |
| `apps/desktop/src/renderer/src/components/note/content-area/task-block/task-block-utils.ts` | Modify | Update `serializeTaskBlock` for indent, `normalizeTaskBlocks` for recursive children, add `parentTaskId` to `TaskBlockProps` |
| `apps/desktop/src/renderer/src/components/note/content-area/task-block/__tests__/task-block-utils.test.ts` | Modify | Add tests for subtask serialization/deserialization |
| `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts` | Modify | Handle subtask taskBlocks in `serializeBlocksPreservingBlanks` (children of taskBlock parent) |
| `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx` | Modify | Extend `scanBlocks` to track parent, extend `convertCheckboxToTask` to accept parent context |

---

### Task 1: Add `parentTaskId` prop to taskBlock spec

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/task-block/index.tsx`

- [ ] **Step 1: Add `parentTaskId` to propSchema**

In `apps/desktop/src/renderer/src/components/note/content-area/task-block/index.tsx`, update the `createReactBlockSpec` call:

```typescript
export const createTaskBlock = createReactBlockSpec(
  {
    type: 'taskBlock' as const,
    propSchema: {
      taskId: { default: '' },
      title: { default: '' },
      checked: { default: false },
      parentTaskId: { default: '' }
    },
    content: 'none'
  },
  {
    render: (props) => (
      <TaskBlockRenderer
        block={props.block as any}
        editor={props.editor}
        contentRef={props.contentRef}
      />
    )
  }
)
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck 2>&1 | head -30`
Expected: No new errors related to taskBlock props (pre-existing test file errors are fine).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/task-block/index.tsx
git commit -m "feat: add parentTaskId prop to taskBlock spec"
```

---

### Task 2: Update TaskBlockRenderer for subtask indentation

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/task-block/task-block-renderer.tsx`

- [ ] **Step 1: Read `parentTaskId` from block props**

In `task-block-renderer.tsx`, update the `TaskBlockRendererProps` interface and the destructuring at line 29:

```typescript
interface TaskBlockRendererProps {
  block: { id: string; props: { taskId: string; title: string; checked: boolean; parentTaskId: string } }
  editor: any
  contentRef: React.Ref<HTMLDivElement>
}
```

And at line 29:

```typescript
const { taskId, title, checked, parentTaskId } = block.props
```

- [ ] **Step 2: Apply indent styling when parentTaskId is set**

In the final return statement (around line 391), wrap the `TaskRow` in a container that conditionally applies `ml-7` (28px) when `parentTaskId` is non-empty:

```typescript
return (
  <div
    ref={contentRef}
    contentEditable={false}
    className="w-full outline-none [&_*]:outline-none"
  >
    <style>{BLOCKNOTE_OVERRIDES}</style>
    <div className={parentTaskId ? 'ml-7' : undefined}>
      <TaskRow
        task={rowTask}
        project={rowProject}
        projects={projects}
        isCompleted={isCompleted}
        showProjectBadge
        onToggleComplete={handleToggleComplete}
        onUpdateTask={handleUpdateTask}
        onProjectChange={handleProjectChange}
        actions={navigateArrow}
        renderTitle={isEditingTitle ? titleInput : clickableTitle}
        className="px-0"
      />
    </div>
  </div>
)
```

Also apply the same `ml-7` to the deleted state and loading state renders (around lines 353 and 378) so they're consistent:

For the deleted state (around line 353):
```typescript
if (isDeleted) {
  return (
    <div
      ref={contentRef}
      contentEditable={false}
      className={cn(
        'flex items-center gap-3 rounded-md bg-stone-100 py-[7px] text-sm text-muted-foreground opacity-60 dark:bg-stone-800/50',
        parentTaskId && 'ml-7'
      )}
    >
```

For the loading state (around line 378):
```typescript
return (
  <div
    ref={contentRef}
    contentEditable={false}
    className={cn(
      'flex items-center gap-3 rounded-md py-[7px] text-sm text-muted-foreground',
      parentTaskId && 'ml-7'
    )}
  >
```

- [ ] **Step 3: Verify the app renders without errors**

Run: `pnpm typecheck 2>&1 | head -30`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/task-block/task-block-renderer.tsx
git commit -m "feat: indent subtask block rendering with ml-7 when parentTaskId set"
```

---

### Task 3: Update serialization and deserialization utilities

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/task-block/task-block-utils.ts`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/task-block/__tests__/task-block-utils.test.ts`

- [ ] **Step 1: Write failing tests for subtask serialization**

Add these tests to `__tests__/task-block-utils.test.ts`:

```typescript
describe('serializeTaskBlock with parentTaskId', () => {
  it('serializes subtask with 2-space indent', () => {
    expect(
      serializeTaskBlock({ taskId: 'sub-1', title: 'Buy milk', checked: false, parentTaskId: 'parent-1' })
    ).toBe('  - [ ] Buy milk {task:sub-1}')
  })

  it('serializes checked subtask with indent', () => {
    expect(
      serializeTaskBlock({ taskId: 'sub-2', title: 'Get bread', checked: true, parentTaskId: 'parent-1' })
    ).toBe('  - [x] Get bread {task:sub-2}')
  })

  it('serializes top-level task without indent', () => {
    expect(
      serializeTaskBlock({ taskId: 'top-1', title: 'Groceries', checked: false, parentTaskId: '' })
    ).toBe('- [ ] Groceries {task:top-1}')
  })
})

describe('normalizeTaskBlocks with nested children', () => {
  it('converts nested checkListItem with {task:id} to taskBlock with parentTaskId', () => {
    const blocks = [
      {
        id: 'parent-block',
        type: 'taskBlock',
        props: { taskId: 'task-parent', title: 'Groceries', checked: false, parentTaskId: '' },
        content: undefined,
        children: [
          {
            id: 'child-block',
            type: 'checkListItem',
            props: { isChecked: false },
            content: [{ type: 'text', text: 'Buy milk {task:sub-1}', styles: {} }],
            children: []
          }
        ]
      }
    ] as any[]

    const { blocks: result, didChange } = normalizeTaskBlocks(blocks)
    expect(didChange).toBe(true)
    const parent = result[0]
    expect(parent.children).toHaveLength(1)
    const child = parent.children![0]
    expect(child.type).toBe('taskBlock')
    expect((child.props as any).taskId).toBe('sub-1')
    expect((child.props as any).title).toBe('Buy milk')
    expect((child.props as any).parentTaskId).toBe('task-parent')
  })

  it('leaves non-task children untouched', () => {
    const blocks = [
      {
        id: 'parent-block',
        type: 'taskBlock',
        props: { taskId: 'task-parent', title: 'Groceries', checked: false, parentTaskId: '' },
        content: undefined,
        children: [
          {
            id: 'child-block',
            type: 'checkListItem',
            props: { isChecked: false },
            content: [{ type: 'text', text: 'Just a note', styles: {} }],
            children: []
          }
        ]
      }
    ] as any[]

    const { blocks: result, didChange } = normalizeTaskBlocks(blocks)
    expect(didChange).toBe(false)
    expect(result).toBe(blocks)
  })
})
```

- [ ] **Step 2: Run tests — they should fail**

Run: `pnpm test -- --run apps/desktop/src/renderer/src/components/note/content-area/task-block/__tests__/task-block-utils.test.ts 2>&1 | tail -20`
Expected: FAIL — `serializeTaskBlock` doesn't accept `parentTaskId`, `normalizeTaskBlocks` doesn't process children.

- [ ] **Step 3: Update `TaskBlockProps` and `serializeTaskBlock`**

In `task-block-utils.ts`, update the `TaskBlockProps` interface and `serializeTaskBlock`:

```typescript
export interface TaskBlockProps {
  taskId: string
  title: string
  checked: boolean
  parentTaskId?: string
}

export function serializeTaskBlock(props: TaskBlockProps): string {
  const check = props.checked ? 'x' : ' '
  const indent = props.parentTaskId ? '  ' : ''
  return `${indent}- [${check}] ${props.title} {task:${props.taskId}}`
}
```

- [ ] **Step 4: Update `normalizeTaskBlocks` to process children recursively**

Replace the `normalizeTaskBlocks` function:

```typescript
export function normalizeTaskBlocks(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  const blockStr = JSON.stringify(blocks)
  if (!blockStr.includes('{task:')) {
    return { blocks, didChange: false }
  }

  let didChange = false

  function processBlocks(blockList: Block[], parentTaskId: string): Block[] {
    return blockList.map((block) => {
      // Recursively process children of taskBlock parents
      if (block.type === 'taskBlock' && block.children?.length) {
        const taskId = (block.props as Record<string, unknown>).taskId as string
        const processedChildren = processBlocks(block.children as Block[], taskId)
        if (processedChildren !== block.children) {
          didChange = true
          return { ...block, children: processedChildren }
        }
        return block
      }

      if (block.type !== 'checkListItem') return block

      const text = extractInlineText(block.content)
      const parsed = parseTaskBlockSuffix(text)
      if (!parsed) return block

      didChange = true
      return {
        type: 'taskBlock',
        props: {
          taskId: parsed.taskId,
          title: parsed.title,
          checked: (block.props as Record<string, unknown>).isChecked ?? false,
          parentTaskId
        },
        content: undefined,
        children: [],
        id: block.id
      } as unknown as Block
    })
  }

  const nextBlocks = processBlocks(blocks, '')
  return { blocks: didChange ? nextBlocks : blocks, didChange }
}
```

- [ ] **Step 5: Run tests — they should pass**

Run: `pnpm test -- --run apps/desktop/src/renderer/src/components/note/content-area/task-block/__tests__/task-block-utils.test.ts 2>&1 | tail -20`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/task-block/task-block-utils.ts apps/desktop/src/renderer/src/components/note/content-area/task-block/__tests__/task-block-utils.test.ts
git commit -m "feat: support subtask serialization and recursive normalization in task-block-utils"
```

---

### Task 4: Update markdown serialization for subtask blocks

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts`

- [ ] **Step 1: Handle taskBlock children in `serializeBlocksPreservingBlanks`**

In `markdown-utils.ts`, update the `taskBlock` handling (around line 92) to also serialize children:

```typescript
if ((block.type as string) === 'taskBlock') {
  await flushContent()
  flushGap()
  const props = block.props as { taskId: string; title: string; checked: boolean; parentTaskId?: string }
  segments.push({ type: 'content', text: serializeTaskBlock(props) })
  // Serialize subtask children
  if (block.children?.length) {
    for (const child of block.children as Block[]) {
      if ((child.type as string) === 'taskBlock') {
        const childProps = child.props as { taskId: string; title: string; checked: boolean; parentTaskId?: string }
        segments.push({ type: 'content', text: serializeTaskBlock(childProps) })
      }
    }
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck 2>&1 | head -30`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts
git commit -m "feat: serialize subtask taskBlock children in markdown output"
```

---

### Task 5: Extend ContentArea onChange to create subtasks

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`

This is the core behavior change. The existing `scanBlocks` already recurses into `block.children`. We need to:
1. Track parent `taskBlock` context during scanning
2. Create a new `convertCheckboxToSubtask` function
3. Route nested checkboxes to the subtask path instead of the top-level task path

- [ ] **Step 1: Add `convertCheckboxToSubtask` callback**

Add a new callback after the existing `convertCheckboxToTask` (around line 349). The callback takes only `blockId` and `parentTaskId` — the parent's `projectId` is looked up asynchronously from the DB since it's not available on the block props.

```typescript
const convertCheckboxToSubtask = useCallback(
  (blockId: string, parentTaskId: string) => {
    dismissedBlocksRef.current.add(blockId)

    const block = editor.getBlock(blockId)
    if (!block) return

    const content = block.content as any[] | undefined
    const text =
      content
        ?.map((c: any) => (typeof c === 'string' ? c : (c.text ?? '')))
        .join('')
        .trim() ?? ''

    editor.updateBlock(block, {
      type: 'taskBlock' as any,
      props: { taskId: '', title: text, checked: false, parentTaskId }
    })

    void (async () => {
      try {
        const parentTask = await tasksService.get(parentTaskId)
        if (!parentTask) {
          dismissedBlocksRef.current.delete(blockId)
          return
        }

        const result = await tasksService.create({
          projectId: parentTask.projectId,
          parentId: parentTaskId,
          title: text,
          priority: 0,
          linkedNoteIds: noteId ? [noteId] : []
        })
        if (result.success && result.task) {
          const freshBlock = editor.getBlock(blockId)
          if (freshBlock) {
            const currentTitle = (freshBlock.props as any).title || text
            editor.updateBlock(freshBlock, {
              props: { taskId: result.task.id, title: currentTitle, checked: false, parentTaskId }
            })
            if (currentTitle && currentTitle !== result.task.title) {
              void tasksService.update({ id: result.task.id, title: currentTitle })
            }
          }
        }
      } catch {
        dismissedBlocksRef.current.delete(blockId)
      }
    })()
  },
  [editor, noteId]
)
```

- [ ] **Step 2: Update `scanBlocks` to track parent taskBlock context**

In the `onChange` handler (around line 452), update `scanBlocks` to accept a `parentTaskBlock` argument and route subtask candidates separately from top-level checkboxes.

Replace the existing `scanBlocks` function and the two conversion calls (`convertCheckboxToTask(firstUndismissedCheckbox)` and `createTaskForDraftBlock(...)`) with:

```typescript
let firstUndismissedCheckbox: string | null = null
let firstDraftTaskBlock: { id: string; title: string } | null = null
let firstUndismissedSubtaskCheckbox: {
  blockId: string
  parentTaskId: string
} | null = null

const scanBlocks = (blocks: any[], parentTaskBlock: any | null): void => {
  for (const b of blocks) {
    if (b.type === 'taskBlock' && b.props?.taskId) {
      currentTaskIds.add(b.props.taskId as string)
      // Only allow subtask creation under top-level tasks (enforces 1-level depth)
      const isTopLevel = !b.props.parentTaskId
      if (b.children?.length) scanBlocks(b.children, isTopLevel ? b : null)
      continue
    }

    if (
      b.type === 'taskBlock' &&
      !b.props?.taskId &&
      b.props?.title?.trim() &&
      !firstDraftTaskBlock &&
      !dismissedBlocksRef.current.has(b.id)
    ) {
      firstDraftTaskBlock = { id: b.id, title: b.props.title as string }
    }

    if (
      b.type === 'checkListItem' &&
      !dismissedBlocksRef.current.has(b.id)
    ) {
      if (parentTaskBlock && parentTaskBlock.props?.taskId) {
        // Indented checkbox under a top-level taskBlock → subtask candidate
        if (!firstUndismissedSubtaskCheckbox) {
          firstUndismissedSubtaskCheckbox = {
            blockId: b.id,
            parentTaskId: parentTaskBlock.props.taskId as string
          }
        }
      } else if (!firstUndismissedCheckbox) {
        // Top-level checkbox → regular task candidate
        firstUndismissedCheckbox = b.id
      }
    }

    if (b.children?.length) scanBlocks(b.children, null)
  }
}
scanBlocks(editor.document as any[], null)

if (firstUndismissedSubtaskCheckbox) {
  const { blockId, parentTaskId } = firstUndismissedSubtaskCheckbox
  convertCheckboxToSubtask(blockId, parentTaskId)
} else if (firstUndismissedCheckbox) {
  convertCheckboxToTask(firstUndismissedCheckbox)
}
```

**Important behaviors:**
- Subtask conversion takes precedence — we process one conversion per onChange cycle, and subtasks win.
- The `isTopLevel` check in the taskBlock branch enforces the 1-level nesting rule: checkboxes nested under a subtask taskBlock will NOT be detected as subtask candidates (they fall through to the top-level checkbox path).
- The `continue` after handling `taskBlock` prevents double-processing.

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm typecheck 2>&1 | head -30`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx
git commit -m "feat: auto-detect indented checkboxes under task blocks as subtasks"
```

---

### Task 6: Handle un-indent (Shift+Tab) promoting subtasks

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`

When a subtask block is un-indented (moves out of a parent's `children[]` to the top-level), its `parentTaskId` prop should be cleared and the DB task updated.

- [ ] **Step 1: Add orphan detection to `scanBlocks`**

After `scanBlocks` completes, iterate top-level blocks to find any `taskBlock` that still has a `parentTaskId` but is no longer nested under a parent. This means it was un-indented.

Add this block after the existing `scanBlocks` call and subtask/checkbox handling, before the orphan cleanup:

```typescript
// Detect un-indented subtask blocks (promoted to top-level)
for (const b of editor.document as any[]) {
  if (
    b.type === 'taskBlock' &&
    b.props?.taskId &&
    b.props?.parentTaskId
  ) {
    // This block has parentTaskId but is at the top level → was un-indented
    editor.updateBlock(b, {
      props: { ...b.props, parentTaskId: '' }
    })
    void tasksService.update({ id: b.props.taskId as string, parentId: null })
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck 2>&1 | head -30`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx
git commit -m "feat: promote subtask to standalone when un-indented (Shift+Tab)"
```

---

### Task 7: Verify full serialization round-trip

**Files:**
- Test: `apps/desktop/src/renderer/src/components/note/content-area/task-block/__tests__/task-block-utils.test.ts`

- [ ] **Step 1: Write round-trip tests**

Add to `__tests__/task-block-utils.test.ts`:

```typescript
describe('subtask round-trip: serialize → parse → normalize', () => {
  it('serializes parent with subtask, then normalizes back', () => {
    const parentProps = { taskId: 'p1', title: 'Groceries', checked: false, parentTaskId: '' }
    const subtaskProps = { taskId: 's1', title: 'Buy milk', checked: true, parentTaskId: 'p1' }

    const parentMd = serializeTaskBlock(parentProps)
    const subtaskMd = serializeTaskBlock(subtaskProps)

    expect(parentMd).toBe('- [ ] Groceries {task:p1}')
    expect(subtaskMd).toBe('  - [x] Buy milk {task:s1}')

    // Parse suffix extracts correctly
    const parsedParent = parseTaskBlockSuffix('Groceries {task:p1}')
    expect(parsedParent).toEqual({ taskId: 'p1', title: 'Groceries' })

    const parsedSubtask = parseTaskBlockSuffix('Buy milk {task:s1}')
    expect(parsedSubtask).toEqual({ taskId: 's1', title: 'Buy milk' })
  })

  it('normalizes a block tree with nested children correctly', () => {
    const blocks = [
      {
        id: 'b-parent',
        type: 'taskBlock',
        props: { taskId: 'p1', title: 'Groceries', checked: false, parentTaskId: '' },
        content: undefined,
        children: [
          {
            id: 'b-sub1',
            type: 'checkListItem',
            props: { isChecked: true },
            content: [{ type: 'text', text: 'Buy milk {task:s1}', styles: {} }],
            children: []
          },
          {
            id: 'b-sub2',
            type: 'checkListItem',
            props: { isChecked: false },
            content: [{ type: 'text', text: 'Get bread {task:s2}', styles: {} }],
            children: []
          }
        ]
      }
    ] as any[]

    const { blocks: result, didChange } = normalizeTaskBlocks(blocks)
    expect(didChange).toBe(true)
    expect(result[0].children).toHaveLength(2)

    const sub1 = result[0].children![0]
    expect(sub1.type).toBe('taskBlock')
    expect((sub1.props as any).taskId).toBe('s1')
    expect((sub1.props as any).parentTaskId).toBe('p1')
    expect((sub1.props as any).checked).toBe(true)

    const sub2 = result[0].children![1]
    expect(sub2.type).toBe('taskBlock')
    expect((sub2.props as any).taskId).toBe('s2')
    expect((sub2.props as any).parentTaskId).toBe('p1')
    expect((sub2.props as any).checked).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests — they should pass**

Run: `pnpm test -- --run apps/desktop/src/renderer/src/components/note/content-area/task-block/__tests__/task-block-utils.test.ts 2>&1 | tail -20`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/task-block/__tests__/task-block-utils.test.ts
git commit -m "test: add round-trip tests for subtask serialization and normalization"
```

---

### Task 8: Run full verify suite

- [ ] **Step 1: Run lint**

Run: `pnpm lint 2>&1 | tail -20`
Expected: No new lint errors in modified files.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck 2>&1 | tail -20`
Expected: No new errors (pre-existing test file errors are known).

- [ ] **Step 3: Run tests**

Run: `pnpm test 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 4: Run IPC check**

Run: `pnpm ipc:check 2>&1 | tail -10`
Expected: Pass — no IPC contract changes were made.

- [ ] **Step 5: Commit any lint/format fixes**

If any formatting changes were auto-applied:

```bash
git add -u
git commit -m "style: format changes from lint"
```
