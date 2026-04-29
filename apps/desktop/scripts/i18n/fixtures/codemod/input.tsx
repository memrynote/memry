export function Example({ noteTitle }: { noteTitle: string }) {
  return (
    <section>
      <h1>Create Note</h1>
      <p>{noteTitle}</p>
      <button aria-label="Close dialog">Close</button>
      <kbd>N</kbd>
    </section>
  )
}
