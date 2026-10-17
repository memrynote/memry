// The note Maya writes before today's 11:00 design review, so the day panel that opens beside it
// shows the meeting the note is for.
export default function ({ cli }) {
  cli(
    'notes',
    'create',
    'Design review prep',
    '--folder',
    'Studio North',
    '--content',
    `## Show
- The hero: one photo, one line, one button
- Mobile nav, both versions
- The case study template

## Ask
- Photo picks from [[Lea Park]] by Friday?
- Launch two weeks after sign-off?`,
    '--properties',
    JSON.stringify({ project: ['Website Redesign'] })
  )
}
