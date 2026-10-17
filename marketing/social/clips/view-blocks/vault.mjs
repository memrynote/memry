// Studio North, the client's hub note, ends on a Meetings heading: the clip puts a view of every
// note tagged meeting under it. The base vault already has three (the kickoff, the weekly sync
// with Sam, the brand workshop with Lea).
export default function ({ cli }) {
  const note = cli('notes', 'list', '--limit', '500').find((n) => n.title === 'Studio North')
  cli('notes', 'update', note.id, '--append', '\n## Meetings\n')
}
