// The Lisbon week Maya's calendar lands on after the subscription: flights, a dinner and the
// Sintra day around the all-day trip, so the holidays arrive in a week that is already hers.
// She has also answered the app's one-time question about subscribed calendars ("Don't allow"
// AI to read them), which would otherwise cover the week view the first time it opens.
export default function ({ cli, at, TIMEZONE }) {
  const event = (title, offset, start, end) =>
    cli(
      'calendar',
      'events',
      'create',
      title,
      '--start',
      at(offset, start),
      '--end',
      at(offset, end),
      '--timezone',
      TIMEZONE
    )
  event('Flight to Lisbon', 9, '07:30', '10:15')
  event('Dinner at Time Out Market', 10, '19:30', '21:30')
  event('Sintra day trip', 11, '09:00', '18:00')
  event('Flight home', 12, '18:00', '21:00')
  cli('settings', 'set', 'calendar.ics', JSON.stringify({ agentReadEventsConsent: false }))
}
