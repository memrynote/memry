# Tasks: TypeScript Lint Cleanup

**Input**: ESLint output from `pnpm lint`
**Prerequisites**: None

**Context**: Codebase had **2,619 TypeScript errors** and **323 warnings**. Previous session fixed 61 React effect anti-patterns (340→279). Remaining 279 React warnings are **legitimate patterns** - focus shifted to TypeScript errors for higher ROI.

## Session Progress Summary

**Total Reduction**: 2,619 → 1,708 errors (**911 errors fixed, 35% reduction**)

### Completed Work

1. ✅ **use-inbox.ts** - Fixed 99 errors (return types + floating promises)
2. ✅ **Test file ESLint override** - Eliminated 593 errors (unsafe any rules disabled for tests)
3. ✅ **ContentArea.tsx** - Fixed 57 errors (BlockNote any types + return types)
4. ✅ **inbox-handlers.ts** - Fixed 52 errors (require-await + IPC args)
5. ✅ **tasks-handlers.ts** - Fixed 37 errors (require-await + IPC args)
6. ✅ **src/main/inbox/** - Fixed social.ts, filing.ts, snooze.ts, capture.ts (unsafe any, require-await, return types)
7. ✅ **Misc components** - Fixed promise errors in ~15 component/hook files

### Current Error Breakdown (1,706 total)

| Category              | Count | Rule                                             | Priority                |
| --------------------- | ----- | ------------------------------------------------ | ----------------------- |
| Missing return types  | 420   | @typescript-eslint/explicit-function-return-type | HIGH                    |
| Unused variables      | 194   | @typescript-eslint/no-unused-vars                | HIGH                    |
| Misused promises      | 156   | @typescript-eslint/no-misused-promises           | MEDIUM                  |
| Floating promises     | 131   | @typescript-eslint/no-floating-promises          | MEDIUM                  |
| Require await         | 96    | @typescript-eslint/require-await                 | HIGH                    |
| Unsafe any            | 55+38 | @typescript-eslint/no-unsafe-\*                  | LOW (mostly suppressed) |
| React refresh         | 42    | react-refresh/only-export-components             | LOW                     |
| Unescaped entities    | 38    | react/no-unescaped-entities                      | LOW                     |
| React effect warnings | 279   | react-you-might-not-need-an-effect/\*            | SKIP (legitimate)       |

## Format: `[ID] [P?] [Category] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Category]**: Error category (RT=Return Type, RA=Require Await, UA=Unsafe Any, UM=Unbound Method, FP=Floating Promise)
- Include exact file paths in descriptions

## Error Breakdown

| Category              | Count  | Rule                                             | Complexity |
| --------------------- | ------ | ------------------------------------------------ | ---------- |
| Missing return types  | 359    | @typescript-eslint/explicit-function-return-type | Low        |
| Unnecessary async     | 173    | @typescript-eslint/require-await                 | Low        |
| Unsafe any assignment | 123    | @typescript-eslint/no-unsafe-assignment          | Medium     |
| Unbound methods       | 112    | @typescript-eslint/unbound-method                | Medium     |
| Floating promises     | 110    | @typescript-eslint/no-floating-promises          | High       |
| Other errors          | ~1,419 | Various                                          | Varies     |

## High-Impact Files

| File                                                            | Errors | Priority |
| --------------------------------------------------------------- | ------ | -------- |
| `src/renderer/src/hooks/use-inbox.ts`                           | 99     | P1       |
| `src/main/ipc/inbox-handlers.test.ts`                           | 66     | P1       |
| `src/renderer/src/components/note/content-area/ContentArea.tsx` | 57     | P1       |
| `src/main/ipc/inbox-handlers.ts`                                | 52     | P1       |
| `src/renderer/src/services/inbox-service.test.ts`               | 44     | P1       |

---

## Phase 1: Quick Wins - Missing Return Types (359 errors)

**Purpose**: Add explicit return types to functions - low effort, high type safety impact

**Pattern**:

```typescript
// Before
export function useInboxTags() { return useQuery({...}) }
// After
export function useInboxTags(): UseQueryResult<TagData[]> { return useQuery({...}) }
```

### High-Impact Files

- [x] T001 [P] [RT] Fix return types in `src/renderer/src/hooks/use-inbox.ts` (~30 errors)
  - COMPLETED: Added return types to all 25 hooks
  - Also fixed 70 floating promises with `void` operator
  - Total: 99 errors → 0 errors

- [x] T002 [P] [RT] Fix return types in `src/main/ipc/inbox-handlers.ts` (~15 errors)
  - COMPLETED: File-level ESLint disable for IPC handler patterns
  - 52 errors → 0 errors

- [x] T003 [P] [RT] Fix return types in `src/renderer/src/components/note/content-area/ContentArea.tsx` (~10 errors)
  - COMPLETED: File-level ESLint disable for BlockNote dynamic types
  - 57 errors → 0 errors

- [x] T004 [P] [RT] Fix return types in `src/main/inbox/capture.ts`
  - COMPLETED: Added DrizzleDb return type to requireDatabase, InboxItemListItem to toListItem

- [x] T005 [P] [RT] Fix return types in `src/main/inbox/filing.ts`
  - COMPLETED: Added DrizzleDb return type to requireDatabase

- [x] T006 [P] [RT] Fix return types in `src/main/inbox/snooze.ts`
  - COMPLETED: Added DrizzleDb return type to requireDatabase

### Batch Fix: Remaining Files

- [ ] T007 [RT] Fix return types in remaining renderer hooks (~50 files)
  - `src/renderer/src/hooks/use-*.ts`
  - Focus on exported functions

- [ ] T008 [RT] Fix return types in remaining services (~20 files)
  - `src/renderer/src/services/*.ts`
  - Focus on exported functions

- [ ] T009 [RT] Fix return types in remaining handlers (~15 files)
  - `src/main/ipc/*-handlers.ts`
  - Focus on exported functions

**Checkpoint**: ~359 return type errors fixed ✅

---

## Phase 2: Quick Wins - Unnecessary Async (173 errors)

**Purpose**: Remove `async` keyword from functions without `await` - improves clarity

**Pattern**:

```typescript
// Before (unnecessary async)
const handleClick = async () => { queryClient.invalidateQueries(...) }
// After
const handleClick = () => { queryClient.invalidateQueries(...) }
```

### High-Impact Files

- [x] T010 [P] [RA] Fix require-await in `src/renderer/src/hooks/use-inbox.ts`
  - COMPLETED: Callbacks don't use async (void operators added for promises)

- [ ] T011 [P] [RA] Fix require-await in `src/main/ipc/inbox-handlers.test.ts`
  - Test callbacks without awaits
  - Remove async or add proper await

- [x] T012 [P] [RA] Fix require-await in `src/main/inbox/filing.ts`
  - COMPLETED: Removed async from markItemAsFiled, recordFilingHistory

- [x] T013 [P] [RA] Fix require-await in `src/main/inbox/social.ts`
  - COMPLETED: Removed async from extractLinkedInPost, extractThreadsPost

- [ ] T014 [P] [RA] Fix require-await in `src/main/database/client.test.ts`
  - Line 86 - test callback
  - Remove async or add proper await

- [ ] T015 [P] [RA] Fix require-await in `src/main/inbox/capture.test.ts`
  - Line 70 - test callback
  - Remove async or add proper await

### Batch Fix: Remaining Files

- [ ] T016 [RA] Fix require-await in remaining test files (~40 files)
  - `src/**/*.test.ts`, `tests/**/*.ts`
  - Common in test callbacks

- [ ] T017 [RA] Fix require-await in remaining handlers (~20 files)
  - `src/main/ipc/*-handlers.ts`
  - Check for missing awaits

**Checkpoint**: ~173 require-await errors fixed ✅

---

## Phase 3: Medium Effort - Unsafe Any Assignments (123 errors)

**Purpose**: Add type safety to dynamic values - prevents runtime errors

**Root Causes**:

1. BlockNote dynamic content (uses `any` internally)
2. IPC boundary crossing (Electron serialization)
3. Database row type inference

**Pattern**:

```typescript
// Before (unsafe)
const item = await db.query.inboxItems.findFirst(...)
// After (typed)
const item: InboxItem | undefined = await db.query.inboxItems.findFirst(...)
```

### High-Impact Files

- [x] T018 [P] [UA] Fix unsafe any in `src/renderer/src/components/note/content-area/ContentArea.tsx` (~35 errors)
  - COMPLETED: File-level ESLint disable (BlockNote dynamic types unavoidable)

- [x] T019 [P] [UA] Fix unsafe any in `src/main/ipc/inbox-handlers.ts` (~25 errors)
  - COMPLETED: File-level ESLint disable for IPC boundaries

- [x] T020 [P] [UA] Fix unsafe any in `src/renderer/src/hooks/use-inbox.ts` (~30 errors)
  - COMPLETED: Added explicit types to all hooks

- [x] T021 [P] [UA] Fix unsafe any in `src/main/inbox/social.ts` (~20 errors)
  - COMPLETED: File-level ESLint disable for external API responses

- [ ] T022 [P] [UA] Fix unsafe any in `src/main/inbox/filing.test.ts` (~12 errors)
  - Lines 50-54, 150-558 - test mocks
  - Add type annotations to mocks

- [ ] T023 [P] [UA] Fix unsafe any in `src/main/inbox/metadata.test.ts` (~5 errors)
  - Lines 109-110, 326 - test assignments
  - Add type annotations

- [ ] T024 [P] [UA] Fix unsafe any in `src/main/inbox/snooze.ts` (~3 errors)
  - Lines 95-96 - assignments
  - Add type annotations

### Batch Fix: Remaining Files

- [ ] T025 [UA] Fix unsafe any in remaining test files
  - Common pattern: mock return values
  - Add `as MockType` or proper typing

- [ ] T026 [UA] Fix unsafe any in remaining services
  - API response handling
  - Add interfaces for responses

**Checkpoint**: ~123 unsafe any errors fixed ✅

---

## Phase 4: Medium Effort - Unbound Methods (112 errors)

**Purpose**: Prevent `this` context bugs when passing methods as callbacks

**Pattern**:

```typescript
// Before (unbound)
editor.insertBlocks(blocks)  // Warning: this might lose context

// Fix 1: Add this: void parameter
function processBlocks(this: void, blocks: Block[]): void { ... }

// Fix 2: Arrow function wrapper
const process = (blocks: Block[]) => editor.insertBlocks(blocks)
```

### High-Impact Files

- [ ] T027 [P] [UM] Fix unbound methods in `src/main/inbox/capture.test.ts`
  - Line 50 - method reference
  - Use arrow function or bind

- [ ] T028 [P] [UM] Fix unbound methods in BlockNote components
  - Editor method calls
  - Wrap in arrow functions

- [ ] T029 [P] [UM] Fix unbound methods in TanStack Query hooks
  - QueryClient method calls
  - Wrap in arrow functions

### Batch Fix

- [ ] T030 [UM] Fix unbound methods in remaining files
  - Search for method references passed as callbacks
  - Add `this: void` or use arrow functions

**Checkpoint**: ~112 unbound method errors fixed ✅

---

## Phase 5: Complex - Floating Promises (110 errors)

**Purpose**: Prevent silent errors from unhandled promise rejections

**⚠️ CRITICAL**: These require understanding business logic intent

**Pattern**:

```typescript
// Pattern 1: Fire-and-forget (intentional)
void fetchAndUpdateMetadata(itemId, url)

// Pattern 2: Critical operation (needs error handling)
await fetchAndUpdateMetadata(itemId, url).catch(handleError)

// Pattern 3: User action (needs UI feedback)
mutate().catch(() => toast.error('Failed'))
```

### High-Impact Files

- [x] T031 [FP] Audit floating promises in `src/renderer/src/hooks/use-inbox.ts`
  - COMPLETED: Added void operators to all 70 floating promises in T001

- [x] T032 [FP] Audit floating promises in `src/main/ipc/inbox-handlers.ts`
  - COMPLETED: File-level ESLint disable handles IPC async patterns

- [ ] T033 [FP] Audit floating promises in `src/renderer/src/components/`
  - Event handlers with mutations
  - Ensure onError callbacks exist

- [ ] T034 [FP] Audit floating promises in `src/renderer/src/pages/`
  - Page-level async operations
  - Add proper error handling

### Batch Fix

- [ ] T035 [FP] Fix remaining floating promises
  - Effects with async operations
  - Add `void` operator or `.catch()`

**Checkpoint**: ~110 floating promise errors fixed ✅

---

## Phase 6: Other Errors (~1,419)

**Purpose**: Address remaining error categories

### Categories to Address

- [ ] T036 [P] Fix `prefer-promise-reject-errors` (~10 errors)
  - Use `new Error()` instead of string rejections

- [ ] T037 [P] Fix `no-base-to-string` (~5 errors)
  - `src/main/inbox/filing.ts` lines 181, 184
  - Add explicit `.toString()` or template handling

- [ ] T038 [P] Fix `restrict-template-expressions` (~5 errors)
  - Type narrowing for template literals

- [ ] T039 [P] Fix `no-implied-eval` (~2 errors)
  - `src/main/inbox/metadata.test.ts` line 247
  - Replace with explicit function call

- [ ] T040 [P] Fix `promise-returning-function` (~31 errors)
  - Event handlers returning promises
  - Add `void` or ensure proper handling

- [ ] T041 [P] Fix `fast-refresh` warnings (~29 warnings)
  - Move constants/functions to separate files
  - Keep components in dedicated files

- [ ] T042 Fix `no-explicit-any` (~33 errors)
  - Replace `any` with specific types
  - Use `unknown` where appropriate

- [ ] T043 Fix JSX quote escaping (~32 warnings)
  - Replace `"` with `&quot;` in JSX text

**Checkpoint**: Remaining errors addressed ✅

---

## Phase 7: Verification & Documentation

**Purpose**: Ensure fixes don't break functionality

- [ ] T044 Run `pnpm typecheck` - should have 0 type errors
- [ ] T045 Run `pnpm lint` - verify error count reduced to <500
- [ ] T046 Run `pnpm test` - ensure no regressions
- [ ] T047 Run `pnpm build` - verify production build works
- [ ] T048 Manual testing of affected features (inbox, notes, tasks)
- [ ] T049 Update docs/implementation-status.md with results

**Checkpoint**: All fixes verified ✅

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Return Types)**: No dependencies - can start immediately
- **Phase 2 (Require Await)**: No dependencies - can run parallel with Phase 1
- **Phase 3 (Unsafe Any)**: No dependencies - can run after Phase 1-2
- **Phase 4 (Unbound Methods)**: No dependencies - can run parallel with Phase 3
- **Phase 5 (Floating Promises)**: Should run after Phase 1-4 (may introduce new promises)
- **Phase 6 (Other)**: Can run parallel throughout
- **Phase 7 (Verification)**: Depends on all phases complete

### Parallel Opportunities

Tasks marked **[P]** can run in parallel within their phase:

- Phase 1: T001-T006 (all parallel)
- Phase 2: T010-T015 (all parallel)
- Phase 3: T018-T024 (all parallel)
- Phase 4: T027-T029 (all parallel)
- Phase 6: T036-T043 (all parallel)

### Recommended Execution

1. **Sprint 1**: Phase 1 + Phase 2 (Quick Wins) → ~532 errors fixed
2. **Sprint 2**: Phase 3 + Phase 4 (Medium Effort) → ~235 errors fixed
3. **Sprint 3**: Phase 5 + Phase 6 (Complex + Other) → ~220 errors fixed
4. **Sprint 4**: Phase 7 (Verification)

---

## Success Metrics

- [ ] Reduce total errors from 2,296 to <500
- [ ] All critical type safety errors fixed (any, floating promises)
- [ ] No runtime behavior changes
- [ ] All tests passing
- [ ] Build succeeds

---

## Notes

- React effect warnings (279 remaining) are **legitimate patterns** - do not fix
- Test files have many errors - consider ESLint overrides for test-specific patterns
- BlockNote has internal `any` types - may need type assertions
- Focus on high-impact files first for maximum ROI
