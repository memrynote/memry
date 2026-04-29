export function TechnicalText() {
  return (
    <>
      <ContextMenuShortcut>⇧⌘M</ContextMenuShortcut>
      <span>⌘⇧B</span>
      <Input placeholder="dateDiff(due_date, today(), days)" />
      <Input placeholder="days_until_due" />
    </>
  )
}
