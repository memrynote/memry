// Maya's big thing for 2027: opening her own studio. One project holds the plan note and the
// dated steps; the first step is due on Jan 1, 2027, the day the clip is posted.
const pad = (n) => String(n).padStart(2, '0')
/** Local ISO time with offset for a fixed date ("2027-03-05", "18:30"). */
function local(date, hhmm) {
  const d = new Date(`${date}T${hhmm}:00`)
  const tz = -d.getTimezoneOffset()
  return `${date}T${hhmm}:00${tz >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`
}

export default function ({ cli, TIMEZONE }) {
  const project = cli(
    'projects',
    'create',
    'Studio launch 2027',
    '--color',
    '#f97316',
    '--icon',
    '🌱'
  )
  const task = (title, due, extra = []) =>
    cli('tasks', 'create', title, '--project', project.id, '--due', due, ...extra)

  const plan = cli(
    'notes',
    'create',
    'Studio launch plan',
    '--folder',
    'Ideas',
    '--content',
    `From freelancer to a small studio, by spring.

- A name that still works with two people
- Three case studies, Studio North first
- Launch with a short note to every past client`,
    '--properties',
    JSON.stringify({ project: ['Studio launch 2027'] })
  )

  task('Pick the studio name', '2027-01-01', ['--priority', '3', '--link-note', plan.id])
  task('Register the business', '2027-01-15', ['--priority', '2'])
  const cases = task('Write three case studies', '2027-02-12', ['--priority', '2'])
  for (const t of ['Studio North', 'Harbour library', 'Ferry terminal'])
    cli('tasks', 'create', t, '--project', project.id, '--parent', cases.id)
  task('Launch the new website', '2027-03-01', ['--priority', '3'])
  task('Tell every past client', '2027-03-03')

  cli(
    'calendar',
    'events',
    'create',
    'Studio launch drinks',
    '--start',
    local('2027-03-05', '18:30'),
    '--end',
    local('2027-03-05', '21:00'),
    '--timezone',
    TIMEZONE
  )
}
