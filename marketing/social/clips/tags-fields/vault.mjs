// Studio North is already tagged company, so the clip never opens it before Lea points at it.
export default function ({ cli }) {
  const studio = cli('notes', 'list', '--limit', '500').find((n) => n.title === 'Studio North')
  cli('notes', 'update', studio.id, '--tag', 'client', '--tag', 'company')
}
