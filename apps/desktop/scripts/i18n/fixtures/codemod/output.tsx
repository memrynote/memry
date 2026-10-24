export function Example({ noteTitle }: { noteTitle: string }) {
  return (
    <section>
      <h1>{/* TODO(i18n): wrap in t() */}Create Note</h1>
      <p>{noteTitle}</p>
      <button aria-label={'Close dialog' /* TODO(i18n): wrap aria-label in t() */}>{/* TODO(i18n): wrap in t() */}Close</button>
      <kbd>N</kbd>
    </section>
  )
}
