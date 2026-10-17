// Maya's December 2026, so the last page of the year sits after a month of journaling: entries on
// most December days and New Year's Eve dinner on the 31st. Fixed dates, since the clip is posted
// on Dec 31, 2026.
const pad = (n) => String(n).padStart(2, '0')
/** Local ISO time with offset for a fixed date ("2026-12-31", "20:00"). */
function local(date, hhmm) {
  const d = new Date(`${date}T${hhmm}:00`)
  const tz = -d.getTimezoneOffset()
  return `${date}T${hhmm}:00${tz >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`
}

const DECEMBER = {
  2: 'Studio North site is live. Jonas sent flowers to the whole team, and one bunch to me.',
  4: 'Quiet day. Sketched the workshop exercises.',
  7: 'Workshop sign-ups opened. Eleven people in the first hour!',
  9: "Invoice #4 paid. That's the last big one this year.",
  12: 'Workshop, day one. Tokens went better than expected.',
  13: 'Day two. Tired and happy. Sam ran the code part brilliantly.',
  16: 'Portfolio: picked Studio North and the harbour library.',
  18: 'Lunch with [[Lea Park]]. She wants a second phase in spring.',
  21: 'Shortest day. Long walk at noon to catch the light.',
  23: 'Wrapped the presents, and the client archive.',
  26: 'Did nothing at all. Perfect.',
  28: 'Finished Four Thousand Weeks. Sam was right about it.',
  30: 'Cleaned the desk. Tomorrow: the last page.'
}

export default function ({ cli, TIMEZONE }) {
  for (const [d, text] of Object.entries(DECEMBER))
    cli('journal', 'write', `2026-12-${pad(d)}`, text)
  cli(
    'calendar',
    'events',
    'create',
    "New Year's Eve dinner",
    '--start',
    local('2026-12-31', '20:00'),
    '--end',
    local('2026-12-31', '23:30'),
    '--timezone',
    TIMEZONE,
    '--location',
    "Sam's place"
  )
}
