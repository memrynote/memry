// The weekly sync gets an "Action items" heading, where Maya writes the task on camera.
export default function ({ cli }) {
  const sync = cli('notes', 'list', '--limit', '500').find(
    (n) => n.title === 'Weekly sync with Sam'
  )
  cli('notes', 'update', sync.id, '--append', '\n## Action items\n')
}
