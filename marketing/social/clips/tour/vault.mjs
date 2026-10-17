// Bookmarks for Home's Bookmarks widget, which is otherwise an empty state, and a fuller journal
// page for today.
export default function ({ cli, day }) {
  const byTitle = Object.fromEntries(
    cli('notes', 'list', '--limit', '500').map((n) => [n.title, n])
  )
  for (const title of ['Website Redesign Brief', 'Lisbon Itinerary', 'Design Principles'])
    cli('bookmarks', 'add', 'note', byTitle[title].id)
  cli('journal', 'append', day(0), 'Yoga first, then two quiet hours on the homepage hero.')
  cli('journal', 'append', day(0), 'Lisbon in nine days. Ask Sam about the Sintra day.')
}
