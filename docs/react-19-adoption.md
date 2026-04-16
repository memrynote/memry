# React 19 Adoption

Status as of 2026-04-16: running React 19.2.3 across the renderer, but no 19-specific APIs were adopted until Phase 6 U6. This PR pilots two of the three idioms below. Adopt the rest incrementally — there is no reason to do a repo-wide sweep.

## Three idioms worth adopting

### 1. `ref` as a prop (no more `forwardRef`)

Every DOM-wrapping UI primitive that was `React.forwardRef<Element, Props>` can now accept `ref` as a plain prop. The call site is unchanged, and we no longer need `React.ElementRef` / `React.ComponentPropsWithoutRef` gymnastics for trivial wrappers.

Before:

```tsx
const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(base, className)} {...props} />
)
Textarea.displayName = 'Textarea'
```

After (pilot: `components/ui/textarea.tsx`):

```tsx
type TextareaProps = React.ComponentProps<'textarea'> & { ref?: React.Ref<HTMLTextAreaElement> }

function Textarea({ className, ref, ...props }: TextareaProps) {
  return <textarea ref={ref} className={cn(base, className)} {...props} />
}
```

Callers like `<Textarea ref={textareaRef} />` keep working with zero changes.

### 2. `useActionState` for simple async forms

When a component has an async handler plus manual `isSubmitting` state, `useActionState` folds both into a single hook. The returned `isPending` handles the in-flight flag, and the action is automatically batched under a transition.

Before:

```tsx
const [submitting, setSubmitting] = useState(false)
const handleConfirm = async () => {
  setSubmitting(true)
  try { await onConfirm(); onOpenChange(false) } finally { setSubmitting(false) }
}
```

After (pilot: `components/sidebar/tag-delete-dialog.tsx`):

```tsx
const [, deleteAction, isPending] = useActionState<null, void>(async () => {
  try { await onConfirm(); onOpenChange(false) } catch (err) { log.error('Delete tag failed', err) }
  return null
}, null)
const handleConfirm = () => React.startTransition(() => deleteAction())
```

Wins: no manual `submitting` state, pending flag is driven by React, and we made the silent `finally`-only error swallow into an explicit `log.error` call.

### 3. `use(promise)` for suspense-wrapped async

Unblocks `<Suspense>`-based data fetching: `const data = use(somePromise)` inside a Suspense boundary replaces `useEffect + useState + loading flags`. No pilot in this PR — the renderer does not currently use `<Suspense>` boundaries, so there is no clean 1:1 migration target. Revisit when we introduce a suspense-driven route or panel.

```tsx
// Illustrative only:
function NoteBody({ notePromise }: { notePromise: Promise<Note> }) {
  const note = use(notePromise)
  return <article>{note.body}</article>
}
// Parent: <Suspense fallback={<Skeleton />}><NoteBody notePromise={p} /></Suspense>
```

## When NOT to migrate

- **Components with complex reset semantics around open/close.** `TagRenameDialog` was a tempting `useActionState` target but fights the hook: it needs to reset error state on reopen, clear errors while typing, and block ESC/outside-click while submitting. Keeping `useState` there is clearer than keying a subcomponent + carrying a `pendingRef`. Rule of thumb: if the migration grows line count, stop.
- **Crypto-adjacent renderer code** (sync payload handling, recovery phrase input, OTP entry). Do not introduce new render-timing behavior in anything that touches libsodium, nonces, or key material. Stick with explicit `useState` flows until we have dedicated test coverage for the pending-transition edge cases.
- **Electron bootstrap / auth flows.** Vault open, sign-in, setup wizard — stay away from the happy-path for app launch. The cost of a regression (locked vault, blank window) far outweighs the tidiness win.
- **`forwardRef` with a custom generic type parameter** (e.g., a polymorphic `as` prop, generic item type). Re-typing these for ref-as-prop is non-trivial; you must reproduce the generic inference the `forwardRef<A, B>` overload gave you. If it needs `any`, abandon.
- **Radix/shadcn wrappers that use `React.ElementRef<typeof PrimitiveRoot>`.** These work fine as-is and the migration adds no clarity. Only convert if you were already touching the file.

## Rollout guidance

- Migrate opportunistically, not in a sweep. Touch a file for another reason → convert while you are there.
- Keep diffs tight. A ref-as-prop migration should be a <20-line diff. A `useActionState` migration should shrink the file.
- Preserve behavior exactly. Errors that were caught must stay caught. Submit-in-flight guards (ESC, outside click) must survive. Run the owning component's tests if they exist.
- Do not add `any` to make a migration compile. If strict types push back, the component is in the "not yet" bucket.

## References

- React 19 release notes: [react.dev/blog/2024/12/05/react-19](https://react.dev/blog/2024/12/05/react-19)
- `useActionState`: [react.dev/reference/react/useActionState](https://react.dev/reference/react/useActionState)
- `use`: [react.dev/reference/react/use](https://react.dev/reference/react/use)
- Ref as a prop: [react.dev/blog/2024/12/05/react-19#ref-as-a-prop](https://react.dev/blog/2024/12/05/react-19#ref-as-a-prop)
