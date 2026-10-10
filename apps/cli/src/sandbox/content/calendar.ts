import type { Clock } from '../clock.ts'
import type { EventSpec } from '../specs.ts'
import { lastMonday, launchDay, reviewDay, workdayFrom } from './dates.ts'

/**
 * Local events from two weeks ago to five weeks ahead. Desktop does not expand
 * local recurrence (apps/desktop/src/main/calendar/projection.ts), so repeating
 * meetings are written as concrete instances.
 */
export function eventSpecs(clock: Clock): EventSpec[] {
  const mon = lastMonday(clock)
  const standups: EventSpec[] = clock.workdays(-7, 7).map((day) => ({
    key: `standup-${day}`,
    title: 'Studio standup',
    day,
    start: '09:30',
    end: '09:45',
    location: 'Studio, front table'
  }))
  const syncs: EventSpec[] = [mon - 14, mon - 7, mon, mon + 7].map((day) => ({
    key: `weekly-${day}`,
    title: 'Aurora weekly sync',
    day,
    start: '10:00',
    end: '11:00',
    location: 'Big room',
    description: 'Lena, Theo, Priya, Maya. Notes go in Work/Aurora/Meetings.'
  }))
  const oneOnOnes: EventSpec[] = [-11, -4, 3, 10].map((offset) => {
    const day = workdayFrom(clock, offset)
    return {
      key: `one-on-one-${offset}`,
      title: '1:1 with Lena',
      day,
      start: '15:00',
      end: '15:30'
    }
  })

  return [
    ...standups,
    ...syncs,
    ...oneOnOnes,
    {
      key: 'design-review',
      title: 'Aurora design review',
      day: reviewDay(clock),
      start: '14:00',
      end: '15:30',
      location: 'Big room',
      description: 'Sign off the reading view and onboarding. Prep: Design review prep.'
    },
    {
      key: 'critique',
      title: 'Reading view critique',
      day: -7,
      start: '13:00',
      end: '14:30',
      location: 'Big room'
    },
    {
      key: 'beta-retro',
      title: 'Beta retro',
      day: workdayFrom(clock, -10),
      start: '11:00',
      end: '12:00'
    },
    {
      key: 'dentist',
      title: 'Dentist',
      day: workdayFrom(clock, 6),
      start: '08:30',
      end: '09:15',
      location: 'Tandartspraktijk Noord'
    },
    {
      key: 'dinner',
      title: 'Dinner with Jonah and Ines',
      day: -3,
      start: '19:30',
      end: '22:30',
      description: 'Risotto night. Plan the trip.'
    },
    {
      key: 'library',
      title: 'Library: return books, pick up Hidden Figures',
      day: 1,
      start: '17:30',
      end: '18:00'
    },
    {
      key: 'flight',
      title: 'Flight to Jackson Hole',
      day: 20,
      start: '07:10',
      end: '13:40',
      location: 'Gate info in the airline app'
    },
    {
      key: 'trip',
      title: 'Grand Teton trip',
      day: 20,
      days: 5,
      location: 'Grand Teton National Park',
      description: 'Plan: Grand Teton trip note.'
    },
    { key: 'essay-due', title: 'Essay draft due to editor', day: 14 },
    { key: 'launch-day', title: 'Aurora 1.0 launch', day: launchDay(clock) },
    {
      key: 'show-and-tell',
      title: 'Studio show and tell',
      day: workdayFrom(clock, 8),
      start: '16:00',
      end: '17:00'
    }
  ]
}
