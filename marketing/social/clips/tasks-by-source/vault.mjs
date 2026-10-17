// Action items written inside three meeting notes, the way the app stores them: a task row whose
// source note is the meeting, and a `- [ ] title {task:<id>}` line in that note's body.
export default function ({ cli, day }) {
  const notes = cli('notes', 'list', '--limit', '500')
  const projects = Object.fromEntries(cli('projects', 'list').map((p) => [p.name, p.id]))
  const PRIORITY = { none: 0, low: 1, medium: 2, high: 3 }

  const meeting = (note, body, items) => {
    const lines = items.map(([title, o]) => {
      const t = cli(
        'tasks',
        'create',
        title,
        '--project',
        projects[o.project],
        '--due',
        day(o.due),
        '--priority',
        String(PRIORITY[o.priority ?? 'none']),
        '--source-note',
        note.id
      )
      return `- [ ] ${title} {task:${t.id}}`
    })
    cli(
      'notes',
      'update',
      note.id,
      '--content',
      `${body}\n\n## Action items\n\n${lines.join('\n')}\n`
    )
  }
  const byTitle = (title) => notes.find((n) => n.title === title)

  meeting(
    byTitle('Weekly sync with Sam'),
    `- Mobile nav: prototype both the menu and a bottom bar
- [[Homepage Ideas]] approved for build`,
    [
      ['Export the hero assets for Sam', { project: 'Website Redesign', due: 1, priority: 'high' }],
      ['Prototype the bottom bar', { project: 'Website Redesign', due: 3, priority: 'medium' }],
      ['Ask Sam about the Sintra day', { project: 'Lisbon Trip', due: 5 }]
    ]
  )
  meeting(
    byTitle('Brand workshop with Lea'),
    `- Headings stay in their serif, body text goes system
- Colors stay as they are`,
    [
      [
        'Switch body text to the system font',
        { project: 'Website Redesign', due: 2, priority: 'medium' }
      ],
      ["Pick three photos from Lea's archive", { project: 'Website Redesign', due: 4 }]
    ]
  )
  const jonas = cli(
    'notes',
    'create',
    'Call with Jonas',
    '--folder',
    'Meetings',
    '--content',
    'placeholder',
    '--tag',
    'meeting'
  )
  meeting(
    jonas,
    `- Case studies first, the rest can wait
- Wants to see the mobile layout before Friday`,
    [
      ['Outline the case study page', { project: 'Website Redesign', due: 2, priority: 'high' }],
      ['Send Jonas the mobile mockups', { project: 'Website Redesign', due: 4, priority: 'medium' }]
    ]
  )
}
