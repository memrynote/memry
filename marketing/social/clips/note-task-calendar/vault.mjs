// Today's two untimed tasks get times, so the Day view's all-day row is empty until the task
// written in the note lands in it.
export default function ({ cli }) {
  const byTitle = Object.fromEntries(
    cli('tasks', 'list', '--limit', '500').map((t) => [t.title, t])
  )
  cli('tasks', 'update', byTitle['Reply to Jonas about the workshop'].id, '--due-time', '09:30')
  cli('tasks', 'update', byTitle['Book apartment in Alfama'].id, '--due-time', '17:00')
}
