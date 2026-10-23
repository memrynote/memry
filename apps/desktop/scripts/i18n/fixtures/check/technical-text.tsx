export function TechnicalText() {
  return (
    <>
      {/* oxlint-disable-next-line react/jsx-no-undef -- fixture is parsed by the i18n scanner only; components are intentionally unresolved */}
      <ContextMenuShortcut>⇧⌘M</ContextMenuShortcut>
      <span>⌘⇧B</span>
      {/* oxlint-disable-next-line react/jsx-no-undef -- fixture is parsed by the i18n scanner only; components are intentionally unresolved */}
      <Input placeholder="dateDiff(due_date, today(), days)" />
      {/* oxlint-disable-next-line react/jsx-no-undef -- fixture is parsed by the i18n scanner only; components are intentionally unresolved */}
      <Input placeholder="days_until_due" />
    </>
  )
}
