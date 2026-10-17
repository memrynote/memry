// A Gratitude note written once, and the journal template that pulls one of its lines into
// every new day. Days without an entry (tomorrow onwards) are seeded from the template when
// they are first opened, which is when {{random-line:Gratitude}} picks its line.
export default function ({ cli }) {
  cli(
    'notes',
    'create',
    'Gratitude',
    '--content',
    [
      "- Sam's hand-drawn map of Lisbon",
      "- Lea's feedback, always in numbered lists",
      '- Morning light on my desk',
      '- A client who wants fewer pages',
      '- Long walks by the water',
      '- The new sketchbook',
      '- Invoice #1, paid on time',
      "- Mom's Sunday calls"
    ].join('\n')
  )
  const template = cli(
    'templates',
    'create',
    'Daily page',
    '--icon',
    '🌿',
    '--description',
    'Gratitude first, then the day',
    '--content',
    '## Grateful for\n\n{{random-line:Gratitude}}\n\n## Today\n\n'
  )
  cli('settings', 'set-group', 'journal', JSON.stringify({ defaultTemplate: template.id }))
}
