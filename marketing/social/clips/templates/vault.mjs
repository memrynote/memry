// Two meeting notes in Meetings. Design review is the structure Maya wants to reuse (agenda,
// decisions, next steps), tagged meeting with a client property, so saving it as a template
// carries a tag and a property. Review with Jonas is the next meeting, two lines so far; the
// template goes in between them.
export default function ({ cli }) {
  const note = (title, content, props) =>
    cli(
      'notes',
      'create',
      title,
      '--folder',
      'Meetings',
      '--content',
      content,
      '--tag',
      'meeting',
      '--properties',
      JSON.stringify(props)
    )
  note(
    'Design review',
    `## Agenda
- What changed since last time
- Questions from the team

## Decisions
- One line per decision

## Next steps
- Who does what, by when`,
    { client: 'Studio North' }
  )
  note(
    'Review with Jonas',
    `Thursday 14:00 at the Studio North office.

Bring the printed case studies.`,
    { client: 'Studio North' }
  )
}
