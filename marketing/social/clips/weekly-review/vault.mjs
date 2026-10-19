// A week that slipped: two more overdue tasks on top of the base vault's two, so Sunday's review
// has a pile to go through. Dates are offsets from the recording day.
export default function ({ cli, day }) {
  const projects = Object.fromEntries(cli('projects', 'list').map((p) => [p.name, p.id]))
  const make = (title, project, due, priority) =>
    cli(
      'tasks',
      'create',
      title,
      '--project',
      projects[project],
      '--due',
      day(due),
      '--priority',
      String(priority)
    )
  make('Chase the Studio North invoice', 'Website Redesign', -6, 3)
  make('Reply to the Lisbon hostel', 'Lisbon Trip', -3, 2)
}
