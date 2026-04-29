export function Allowed({ noteTitle }: { noteTitle: string }) {
  return (
    <article data-testid="note-card" role="article">
      <h2>{noteTitle}</h2>
      <kbd>N</kbd>
    </article>
  )
}
