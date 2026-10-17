// The trip's paperwork in the Lisbon folder and the flight on the calendar. scenes.mjs setup files
// both PDFs and both trip events into the Lisbon Trip project through the app's own menus.
import * as fs from 'node:fs'
import * as path from 'node:path'

export default function ({ cli, write, assets, at, TIMEZONE }) {
  write(
    'Lisbon/Flight confirmation.pdf',
    fs.readFileSync(path.join(assets, 'project-hub-flight-confirmation.pdf'))
  )
  write(
    'Lisbon/Apartment booking.pdf',
    fs.readFileSync(path.join(assets, 'project-hub-apartment-booking.pdf'))
  )
  cli(
    'calendar',
    'events',
    'create',
    'Flight to Lisbon',
    '--start',
    at(9, '07:15'),
    '--end',
    at(9, '09:40'),
    '--timezone',
    TIMEZONE
  )
}
