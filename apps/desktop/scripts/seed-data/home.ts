import type { SeedBookmark, SeedHomePage } from '../seed-vault/db-writer'
import { NOTE_IDS } from './notes'

// A curated default Home board so a freshly seeded vault opens on a full,
// nicely arranged dashboard instead of the app's bare first-run auto-seed
// (recently-edited + bookmarks only). The app only auto-seeds when zero boards
// exist, so this row is left untouched once written.
//
// Coords are react-grid-layout units on the 8-column Home grid. Every widget
// type here populates from existing seed data (tasks, calendar, inbox, journal,
// notes, folders, bookmarks).
export const HOME_PAGES: SeedHomePage[] = [
  {
    id: 'home-demo',
    name: 'Home',
    icon: '🏠',
    position: 0,
    widgets: [
      // Hero row — today's tasks + agenda, taller than the rest.
      { id: 'w-tasks', type: 'tasks', x: 0, y: 0, w: 4, h: 5, config: { dateRange: 'today' } },
      { id: 'w-calendar', type: 'calendar', x: 4, y: 0, w: 4, h: 5 },
      // Capture + reflect.
      { id: 'w-inbox', type: 'inbox', x: 0, y: 5, w: 4, h: 4 },
      { id: 'w-journal', type: 'journal', x: 4, y: 5, w: 4, h: 4 },
      // Browse.
      { id: 'w-recent', type: 'recently-edited', x: 0, y: 9, w: 4, h: 4 },
      { id: 'w-folder', type: 'folder', x: 4, y: 9, w: 4, h: 4, config: { folderPath: 'books' } },
      // Full-width footer.
      { id: 'w-bookmarks', type: 'bookmarks', x: 0, y: 13, w: 8, h: 3 }
    ]
  }
]

// Favorite notes surfaced by the bookmarks widget. Note bookmarks resolve their
// title via the index DB once the vault is indexed (ids adopted by file path —
// the same mechanism task→note links rely on). itemType 'note' matches
// BookmarkItemTypes.NOTE.
export const HOME_BOOKMARKS: SeedBookmark[] = [
  { id: 'bm-hail-mary', itemType: 'note', itemId: NOTE_IDS.bookProjectHailMary, position: 0 },
  { id: 'bm-atomic-habits', itemType: 'note', itemId: NOTE_IDS.bookAtomicHabits, position: 1 },
  { id: 'bm-dune', itemType: 'note', itemId: NOTE_IDS.bookDune, position: 2 }
]
