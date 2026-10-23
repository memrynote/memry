export function Allowed({ noteTitle }: { noteTitle: string }) {
  return (
    // oxlint-disable-next-line jsx-a11y/no-redundant-roles -- fixture exercises explicit technical attributes for the i18n scanner
    <article data-testid="note-card" role="article">
      <h2>{noteTitle}</h2>
      <kbd>N</kbd>
    </article>
  )
}
