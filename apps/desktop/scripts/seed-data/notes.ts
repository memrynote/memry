import { generateNoteId } from '../../src/main/lib/id'
import type { NoteFile } from '../seed-vault/file-writer'
import { seedJournalDate, seedPastISOAt } from './date'

const dayOffset = (days: number, hour = 12): string => {
  return seedPastISOAt(days, hour, 30)
}

export const NOTE_IDS = {
  // Books
  bookDune: generateNoteId(),
  bookProjectHailMary: generateNoteId(),
  bookAtomicHabits: generateNoteId(),
  bookDeepWork: generateNoteId(),
  bookTheMartian: generateNoteId(),
  bookSapiens: generateNoteId(),
  bookMisteryHotel: generateNoteId(),
  bookOnWriting: generateNoteId(),
  bookKitchenConfidential: generateNoteId(),
  bookAlmanackOfNaval: generateNoteId(),
  bookFourThousandWeeks: generateNoteId(),
  bookManSearchMeaning: generateNoteId(),
  // Movies
  movieDune2021: generateNoteId(),
  movieInterstellar: generateNoteId(),
  movieTheMatrix: generateNoteId(),
  movieEverythingEverywhere: generateNoteId(),
  movieAnewHope: generateNoteId(),
  movieAriival: generateNoteId(),
  movieTheMartianFilm: generateNoteId(),
  movieParasite: generateNoteId(),
  movieSpiritedAway: generateNoteId(),
  movieWatchlist2026: generateNoteId(),
  movieBladerunner: generateNoteId(),
  movieGoodfellas: generateNoteId(),
  // Weight
  weightCut2026: generateNoteId(),
  weightCuttingLog: generateNoteId(),
  weightProteinTargets: generateNoteId(),
  weightTrainingSplit: generateNoteId(),
  weightSundayWeighIn: generateNoteId(),
  weightCardioPlan: generateNoteId(),
  weightFoodDiary: generateNoteId(),
  weightProgressPhotos: generateNoteId(),
  // Life
  lifeMyWhy: generateNoteId(),
  lifeOnReading: generateNoteId(),
  lifeYearReview2025: generateNoteId(),
  lifeMorningRoutine: generateNoteId(),
  lifeFinances: generateNoteId(),
  lifeOnFear: generateNoteId(),
  lifeRelationships: generateNoteId(),
  lifeWhatBringsJoy: generateNoteId(),
  // Projects
  projMemryLaunch: generateNoteId(),
  projMemryArchitecture: generateNoteId(),
  projMemryRoadmap: generateNoteId(),
  projMemryGTM: generateNoteId(),
  projGardenSchedule: generateNoteId(),
  projHomeRenovation: generateNoteId(),
  projBlogRedesign: generateNoteId(),
  projOpenSourceFork: generateNoteId(),
  projSideProjectIdeas: generateNoteId(),
  projConferenceTalk: generateNoteId(),
  projMemryMobile: generateNoteId(),
  // Tech
  techTypescriptPatterns: generateNoteId(),
  techDrizzleORM: generateNoteId(),
  techCRDTArchitecture: generateNoteId(),
  techPostgresIndexing: generateNoteId(),
  techCMUDatabaseCourse: generateNoteId(),
  techKipThorneBlackHoles: generateNoteId(),
  techElectronGotchas: generateNoteId(),
  techSqliteVec: generateNoteId(),
  techVimMotions: generateNoteId(),
  techGitWorkflow: generateNoteId(),
  techRustNotes: generateNoteId(),
  techDockerCheatsheet: generateNoteId(),
  // Travel
  travelTokyoTrip: generateNoteId(),
  travelKyotoDayTrip: generateNoteId(),
  travelIstanbul: generateNoteId(),
  travelLisbonNotes: generateNoteId(),
  travelIcelandRingRoad: generateNoteId(),
  travelPackingList: generateNoteId(),
  travelSeoulFood: generateNoteId(),
  travelMexicoCityArt: generateNoteId(),
  travelOsakaRamen: generateNoteId(),
  travelTokyoCafes: generateNoteId(),
  travelAirportLounges: generateNoteId(),
  travelRomeWeekend: generateNoteId(),
  travelLisbonFoodMap: generateNoteId(),
  // Added for a fuller vault
  projBetaFeedback: generateNoteId(),
  projNewsletterIdeas: generateNoteId(),
  techVitestPatterns: generateNoteId(),
  techKeyboardShortcuts: generateNoteId(),
  lifeWeeklyReview: generateNoteId(),
  lifePeopleILearnFrom: generateNoteId(),
  weightSleepLog: generateNoteId(),
  bookShoeDog: generateNoteId(),
  movieTheBear: generateNoteId()
} as const

export const FOLDER_CONFIGS: Array<{ path: string; icon: string }> = [
  { path: 'books', icon: '📚' },
  { path: 'movies', icon: '🎬' },
  { path: 'weight', icon: '💪' },
  { path: 'life', icon: '🌳' },
  { path: 'projects', icon: '📦' },
  { path: 'tech', icon: '💻' },
  { path: 'travel', icon: '✈️' }
]

interface NoteSpec {
  id: string
  relativePath: string
  title: string
  emoji?: string
  tags: string[]
  aliases?: string[]
  customProps?: Record<string, unknown>
  daysAgoCreated: number
  daysAgoModified: number
  body: string
}

const SPECS: NoteSpec[] = [
  // ============================================================================
  // BOOKS
  // ============================================================================
  {
    id: NOTE_IDS.bookDune,
    relativePath: 'books/Dune.md',
    title: 'Dune',
    emoji: '🪐',
    tags: ['fiction', 'sci-fi', 'classic', 'reread'],
    aliases: ['Dune (1965)'],
    customProps: { author: 'Frank Herbert', year: 1965, pages: 688, status: 'done', rating: 5 },
    daysAgoCreated: -120,
    daysAgoModified: -8,
    body: `## Why it still matters

Sixty years on, *Dune* still sets the bar for political-sci-fi worldbuilding. Reread it before catching [[Dune (2021)|the film]] again.

## The lessons that stuck

- **Power is information.** The Bene Gesserit win because they think in centuries.
- **Ecology is plot.** Frank Herbert built the climate before he built the characters.
- **Fear is the mind-killer.** Best opening litany in the genre.

> "He who controls the spice controls the universe."

#books/fiction #sci-fi

## Pair with

- [[Project Hail Mary]] — same chewy hard-sci-fi appetite
- [[Sapiens]] — for the *humans-shape-environment* throughline
`
  },
  {
    id: NOTE_IDS.bookProjectHailMary,
    relativePath: 'books/Project Hail Mary.md',
    title: 'Project Hail Mary',
    emoji: '🚀',
    tags: ['fiction', 'sci-fi', 'andy-weir'],
    customProps: { author: 'Andy Weir', year: 2021, pages: 476, status: 'done', rating: 5 },
    daysAgoCreated: -90,
    daysAgoModified: -22,
    body: `## Plot stretch goal

Lone astronaut wakes up on a starship with amnesia and has to save earth. *Of course* he does.

## What worked

- The friendship is genuinely earned — most aliens-meet-humans stories skip this.
- Andy Weir does **engineering exposition** better than anyone.
- Rocky. Just Rocky.

## What dragged

The chemistry-by-flashlight beats run a touch long. Worth it.

See also: [[The Martian]] — same flavor, drier.

#books/fiction #sci-fi
`
  },
  {
    id: NOTE_IDS.bookAtomicHabits,
    relativePath: 'books/Atomic Habits.md',
    title: 'Atomic Habits',
    emoji: '⚛️',
    tags: ['nonfiction', 'productivity', 'habits'],
    customProps: { author: 'James Clear', year: 2018, pages: 320, status: 'done', rating: 4 },
    daysAgoCreated: -210,
    daysAgoModified: -45,
    body: `## The four laws

| Law | Make it | Example |
|-----|---------|---------|
| 1 | Obvious | Lay out gym clothes the night before |
| 2 | Attractive | Stack a habit you want with one you love |
| 3 | Easy | Two-minute rule |
| 4 | Satisfying | Tracker, streak, reward |

## Quotes I wrote on a sticky note

> You do not rise to the level of your goals. You fall to the level of your systems.

> Every action you take is a vote for the type of person you wish to become.

## Where I applied it

- **Reading**: kindle on the pillow → 20 minutes a night minimum
- **Strength**: see [[2026 Cut]] and [[Training Split]]
- **Writing**: morning, before the inbox opens

#books/nonfiction #habits
`
  },
  {
    id: NOTE_IDS.bookDeepWork,
    relativePath: 'books/Deep Work.md',
    title: 'Deep Work',
    emoji: '🧠',
    tags: ['nonfiction', 'productivity', 'focus'],
    customProps: {
      author: 'Cal Newport',
      year: 2016,
      pages: 304,
      status: 'done',
      rating: 4
    },
    daysAgoCreated: -300,
    daysAgoModified: -60,
    body: `## Core idea

Cognitive demand is the new luxury good. Defend three to four hours a day or surrender them.

## My deep work blocks

- 06:00–08:00 — writing, no exceptions
- 09:30–12:00 — engineering, slack closed
- 14:00–15:00 — reading

## Anti-patterns I caught myself doing

- Phantom-checking notifications mid-flow
- "Quick" Slack threads that weren't quick
- Email as a procrastination ritual

#books/nonfiction #focus
`
  },
  {
    id: NOTE_IDS.bookTheMartian,
    relativePath: 'books/The Martian.md',
    title: 'The Martian',
    emoji: '🥔',
    tags: ['fiction', 'sci-fi', 'andy-weir'],
    customProps: {
      author: 'Andy Weir',
      year: 2011,
      pages: 369,
      status: 'done',
      rating: 4
    },
    daysAgoCreated: -250,
    daysAgoModified: -150,
    body: `## The pitch

Astronaut botanist gets stranded on Mars. Survives mostly through math and stubbornness.

The film [[The Martian (Film)]] cuts the chemistry but keeps the heart. Andy Weir has clearly done this trick again with [[Project Hail Mary]].

## Lines that hit

> I'm gonna have to science the shit out of this.

## When to reread

When motivation is thin. Watney's *I-am-not-going-to-die-today* energy is contagious.

#books/fiction #sci-fi
`
  },
  {
    id: NOTE_IDS.bookSapiens,
    relativePath: 'books/Sapiens.md',
    title: 'Sapiens',
    emoji: '🌍',
    tags: ['nonfiction', 'history', 'big-ideas'],
    customProps: {
      author: 'Yuval Noah Harari',
      year: 2014,
      pages: 464,
      status: 'reading',
      rating: 4
    },
    daysAgoCreated: -45,
    daysAgoModified: -1,
    body: `## Where I am

Chapter 9. Cognitive revolution → agricultural revolution → unification of humankind.

## What I'm thinking about

- Money, religion, and limited liability companies are all *fictions we agree on*. memrynote sync is a fiction we agree on, too.
- Wheat domesticated humans, not the other way around.

## Open questions

- Does Harari oversell the wheat takeover?
- Is "happiness research" rigorous enough to lean on this much?

#books/nonfiction #history
`
  },
  {
    id: NOTE_IDS.bookMisteryHotel,
    relativePath: 'books/The Mystery Guest.md',
    title: 'The Mystery Guest',
    emoji: '🔍',
    tags: ['fiction', 'mystery', 'cozy'],
    customProps: {
      author: 'Nita Prose',
      year: 2023,
      pages: 304,
      status: 'reading',
      rating: 3
    },
    daysAgoCreated: -10,
    daysAgoModified: -1,
    body: `Cozy hotel mystery. Easy palette cleanser between heavier reads.

Half through. The narrator's voice is the appeal more than the puzzle.

#books/fiction #mystery
`
  },
  {
    id: NOTE_IDS.bookOnWriting,
    relativePath: 'books/On Writing.md',
    title: 'On Writing',
    emoji: '✍️',
    tags: ['nonfiction', 'craft', 'writing'],
    customProps: {
      author: 'Stephen King',
      year: 2000,
      pages: 288,
      status: 'done',
      rating: 5
    },
    daysAgoCreated: -400,
    daysAgoModified: -180,
    body: `## Memoir + craft, in equal parts

Read it twice now. The memoir is great; the toolkit is *brutal*:

- *Read a lot. Write a lot.* No shortcut.
- *Adverbs are not your friend.*
- *The road to hell is paved with adverbs.*
- *Write with the door closed. Edit with the door open.*

Pair with [[Deep Work]] for the *defend the time* angle.

#books/nonfiction #writing
`
  },
  {
    id: NOTE_IDS.bookKitchenConfidential,
    relativePath: 'books/Kitchen Confidential.md',
    title: 'Kitchen Confidential',
    emoji: '🔪',
    tags: ['nonfiction', 'memoir', 'food'],
    customProps: {
      author: 'Anthony Bourdain',
      year: 2000,
      pages: 312,
      status: 'done',
      rating: 5
    },
    daysAgoCreated: -340,
    daysAgoModified: -110,
    body: `## Why I love it

Bourdain wrote like he cooked: fast, no apologies, with violence and grace. Best food memoir of the century.

Also see [[Tokyo Cafes]] — different cuisine, same reverence.

> Your body is not a temple, it's an amusement park.

#books/nonfiction #memoir
`
  },
  {
    id: NOTE_IDS.bookAlmanackOfNaval,
    relativePath: 'books/The Almanack of Naval Ravikant.md',
    title: 'The Almanack of Naval Ravikant',
    emoji: '🧭',
    tags: ['nonfiction', 'philosophy', 'wealth'],
    customProps: {
      author: 'Eric Jorgenson',
      year: 2020,
      pages: 244,
      status: 'reading',
      rating: 4
    },
    daysAgoCreated: -30,
    daysAgoModified: -3,
    body: `Notes-as-essays from Naval Ravikant. The wealth section is fine. The happiness section is the part to reread.

> Desire is a contract you make with yourself to be unhappy until you get what you want.

Pairs with [[On Reading]] and [[My Why]].

#books/nonfiction #philosophy
`
  },
  {
    id: NOTE_IDS.bookFourThousandWeeks,
    relativePath: 'books/Four Thousand Weeks.md',
    title: 'Four Thousand Weeks',
    emoji: '⏳',
    tags: ['nonfiction', 'productivity', 'mortality'],
    customProps: {
      author: 'Oliver Burkeman',
      year: 2021,
      pages: 288,
      status: 'done',
      rating: 5
    },
    daysAgoCreated: -160,
    daysAgoModified: -90,
    body: `## The reframe

You only get ~4000 weeks. The "productivity stack" is, mostly, a way to pretend you don't.

Hard counterweight to [[Atomic Habits]] and [[Deep Work]] — those say *get more out of every hour*. This one says *give up first*.

#books/nonfiction #mortality
`
  },
  {
    id: NOTE_IDS.bookManSearchMeaning,
    relativePath: "books/Man's Search for Meaning.md",
    title: "Man's Search for Meaning",
    emoji: '🕯️',
    tags: ['nonfiction', 'philosophy', 'memoir'],
    customProps: {
      author: 'Viktor Frankl',
      year: 1946,
      pages: 200,
      status: 'done',
      rating: 5
    },
    daysAgoCreated: -700,
    daysAgoModified: -360,
    body: `## Logotherapy in 200 pages

Frankl's central claim: *meaning* — not pleasure, not even purpose — is what carries you. Pair with [[On Reading]].

> When we are no longer able to change a situation, we are challenged to change ourselves.

#books/nonfiction #philosophy
`
  },

  // ============================================================================
  // MOVIES
  // ============================================================================
  {
    id: NOTE_IDS.movieDune2021,
    relativePath: 'movies/Dune (2021).md',
    title: 'Dune (2021)',
    emoji: '🪐',
    tags: ['movies/sci-fi', 'denis-villeneuve', 'rewatch'],
    aliases: ['Dune Part One'],
    customProps: {
      year: 2021,
      director: 'Denis Villeneuve',
      genre: 'sci-fi',
      status: 'watched',
      rating: 5
    },
    daysAgoCreated: -120,
    daysAgoModified: -8,
    body: `## The adaptation that finally landed

After 56 years and several misfires, Villeneuve cracked it. The film is the [[Dune|book]] in spirit, not in plot density. That's the right call.

## What sells it

- Hans Zimmer's score — unsettling without being theatrical
- The sandworm reveal: lit in negative space, doesn't show too much
- Stilgar's restraint. Bardem refused to ham it up.

Watch trailer: https://www.youtube.com/watch?v=8g18jFHCLXk

## What I'd cut

The Salusa Secundus scene needs ten more seconds. Hardly a crime.

#movies/sci-fi #adaptation
`
  },
  {
    id: NOTE_IDS.movieInterstellar,
    relativePath: 'movies/Interstellar.md',
    title: 'Interstellar',
    emoji: '🌌',
    tags: ['movies/sci-fi', 'christopher-nolan', 'rewatch'],
    customProps: {
      year: 2014,
      director: 'Christopher Nolan',
      genre: 'sci-fi',
      status: 'watched',
      rating: 5
    },
    daysAgoCreated: -280,
    daysAgoModified: -40,
    body: `## Nolan's most emotional film

Nolan turned Kip Thorne's whitepaper into the most *devastating* sci-fi film since 2001. The black hole render is the work of [[Kip Thorne — Black Holes]] himself.

## The bookcase scene

Plot-mechanically nonsense. Emotionally undefeated. I will fight on this.

> Do not go gentle into that good night.

#movies/sci-fi #emotional
`
  },
  {
    id: NOTE_IDS.movieTheMatrix,
    relativePath: 'movies/The Matrix.md',
    title: 'The Matrix',
    emoji: '💊',
    tags: ['movies/sci-fi', 'wachowski', 'classic'],
    customProps: {
      year: 1999,
      director: 'Wachowski Sisters',
      genre: 'sci-fi',
      status: 'watched',
      rating: 5
    },
    daysAgoCreated: -500,
    daysAgoModified: -200,
    body: `Still holds up. The bullet-time was the marketing; the philosophy was the staying power.

> What is real? How do you define real?

#movies/sci-fi #classic
`
  },
  {
    id: NOTE_IDS.movieEverythingEverywhere,
    relativePath: 'movies/Everything Everywhere All at Once.md',
    title: 'Everything Everywhere All at Once',
    emoji: '🥯',
    tags: ['movies/scifi', 'a24', 'absurd'],
    customProps: { year: 2022, director: 'Daniels', genre: 'sci-fi', status: 'watched', rating: 5 },
    daysAgoCreated: -180,
    daysAgoModified: -55,
    body: `## Why it works

Multiverse-as-feeling instead of multiverse-as-plot. Michelle Yeoh as the laundromat lady saving the universe by **doing taxes** is the joke that becomes the heart.

## What it owes

- Wong Kar-wai for the longing scenes
- Hong Kong action choreography for the fanny-pack fight
- Pixar for the rocks

#movies/sci-fi #a24
`
  },
  {
    id: NOTE_IDS.movieAnewHope,
    relativePath: 'movies/Star Wars Episode IV.md',
    title: 'Star Wars Episode IV',
    emoji: '⚔️',
    tags: ['movies/sci-fi', 'star-wars', 'classic'],
    aliases: ['A New Hope', 'Star Wars (1977)'],
    customProps: {
      year: 1977,
      director: 'George Lucas',
      genre: 'sci-fi',
      status: 'watched',
      rating: 4
    },
    daysAgoCreated: -650,
    daysAgoModified: -300,
    body: `Hero's journey, as catalogued by Joseph Campbell, with laser swords. Still works.

#movies/sci-fi #classic
`
  },
  {
    id: NOTE_IDS.movieAriival,
    relativePath: 'movies/Arrival.md',
    title: 'Arrival',
    emoji: '🛸',
    tags: ['movies/sci-fi', 'denis-villeneuve', 'thoughtful'],
    customProps: {
      year: 2016,
      director: 'Denis Villeneuve',
      genre: 'sci-fi',
      status: 'watched',
      rating: 5
    },
    daysAgoCreated: -370,
    daysAgoModified: -120,
    body: `Sapir-Whorf as a love letter. Best contact-with-aliens movie since 2001. Pair with [[Dune (2021)]] — same director, same ear for silence.

#movies/sci-fi #thoughtful
`
  },
  {
    id: NOTE_IDS.movieTheMartianFilm,
    relativePath: 'movies/The Martian (Film).md',
    title: 'The Martian (Film)',
    emoji: '🥔',
    tags: ['movies/sci-fi', 'ridley-scott'],
    customProps: {
      year: 2015,
      director: 'Ridley Scott',
      genre: 'sci-fi',
      status: 'watched',
      rating: 4
    },
    daysAgoCreated: -240,
    daysAgoModified: -150,
    body: `Cleaner than [[The Martian|the book]] but loses the chemistry monologues. Watney is still Watney.

#movies/sci-fi
`
  },
  {
    id: NOTE_IDS.movieParasite,
    relativePath: 'movies/Parasite.md',
    title: 'Parasite',
    emoji: '🪳',
    tags: ['movies/drama', 'bong-joon-ho', 'foreign'],
    customProps: {
      year: 2019,
      director: 'Bong Joon-ho',
      genre: 'thriller',
      status: 'watched',
      rating: 5
    },
    daysAgoCreated: -310,
    daysAgoModified: -100,
    body: `Class warfare as black comedy as horror. The pivot at the basement reveal is the best plot turn of the decade.

#movies/foreign
`
  },
  {
    id: NOTE_IDS.movieSpiritedAway,
    relativePath: 'movies/Spirited Away.md',
    title: 'Spirited Away',
    emoji: '🐉',
    tags: ['movies/animation', 'studio-ghibli'],
    customProps: {
      year: 2001,
      director: 'Hayao Miyazaki',
      genre: 'animation',
      status: 'watched',
      rating: 5
    },
    daysAgoCreated: -380,
    daysAgoModified: -200,
    body: `Watching it after [[Tokyo Trip]] hit different — the bathhouse aesthetic isn't a fantasy, it's a memory.

#movies/animation #ghibli
`
  },
  {
    id: NOTE_IDS.movieWatchlist2026,
    relativePath: 'movies/Watchlist 2026.md',
    title: 'Watchlist 2026',
    emoji: '🎞️',
    tags: ['movies', 'watchlist'],
    customProps: { year: 2026, status: 'active' },
    daysAgoCreated: -125,
    daysAgoModified: -2,
    body: `## Want to watch

- [ ] **Dune: Part Two** — bumped because [[Dune (2021)]] was so good
- [ ] **Poor Things** — Yorgos Lanthimos
- [ ] **Past Lives** — heard it's devastating
- [x] **Everything Everywhere All at Once** — see [[Everything Everywhere All at Once]]
- [ ] **Anatomy of a Fall** — French legal thriller
- [ ] **The Zone of Interest** — quiet horror
- [x] **Parasite** — see [[Parasite]]

## Comparison

| Film | Year | Genre | Length |
|------|------|-------|--------|
| Dune Part Two | 2024 | sci-fi | 166 min |
| Poor Things | 2023 | drama | 141 min |
| Past Lives | 2023 | romance | 105 min |
| Anatomy of a Fall | 2023 | thriller | 152 min |

#movies #watchlist
`
  },
  {
    id: NOTE_IDS.movieBladerunner,
    relativePath: 'movies/Blade Runner 2049.md',
    title: 'Blade Runner 2049',
    emoji: '🌆',
    tags: ['movies/sci-fi', 'denis-villeneuve'],
    customProps: {
      year: 2017,
      director: 'Denis Villeneuve',
      genre: 'sci-fi',
      status: 'watched',
      rating: 5
    },
    daysAgoCreated: -290,
    daysAgoModified: -120,
    body: `Slow. Achingly beautiful. The yellow-fog Las Vegas sequence is one of the most committed visuals in the medium.

#movies/sci-fi
`
  },
  {
    id: NOTE_IDS.movieGoodfellas,
    relativePath: 'movies/Goodfellas.md',
    title: 'Goodfellas',
    emoji: '🍝',
    tags: ['movies/crime', 'scorsese'],
    customProps: {
      year: 1990,
      director: 'Martin Scorsese',
      genre: 'crime',
      status: 'watched',
      rating: 5
    },
    daysAgoCreated: -460,
    daysAgoModified: -260,
    body: `The Copacabana tracking shot does in three minutes what most films can't do in three hours.

> As far back as I can remember, I always wanted to be a gangster.

#movies/crime
`
  },

  // ============================================================================
  // WEIGHT
  // ============================================================================
  {
    id: NOTE_IDS.weightCut2026,
    relativePath: 'weight/2026 Cut.md',
    title: '2026 Cut',
    emoji: '💪',
    tags: ['fitness', 'cut'],
    customProps: {
      status: 'active',
      startDate: seedJournalDate('2026-04-01'),
      endDate: seedJournalDate('2026-06-15'),
      weight: 82.4,
      bodyFat: 18,
      mood: 4
    },
    daysAgoCreated: -38,
    daysAgoModified: 0,
    body: `## Targets

- **Start**: 87.1 kg / 21% BF (${seedJournalDate('2026-04-01')})
- **Target**: 78 kg / 14% BF (by ${seedJournalDate('2026-06-15')})
- **Pace**: ~0.5 kg / week — sustainable, hold strength

## Strategy

- 2200 kcal weekdays, 2400 weekends
- Protein floor 180g — see [[Protein Targets]]
- 4×5 strength + 2×low-impact cardio per [[Training Split]]
- Sunday weigh-in only — see [[Sunday Weigh-in]]

## Progress

See running table in [[Cutting Log]]. Wikilinked journal entries: [[${seedJournalDate('2026-04-22')}]], [[${seedJournalDate('2026-05-01')}]], [[${seedJournalDate('2026-05-08')}]].

> [!info]
> The cut isn't the diet. The cut is *not getting bored*.

#fitness #cut
`
  },
  {
    id: NOTE_IDS.weightCuttingLog,
    relativePath: 'weight/Cutting Log.md',
    title: 'Cutting Log',
    emoji: '📊',
    tags: ['fitness', 'log'],
    customProps: { status: 'active' },
    daysAgoCreated: -38,
    daysAgoModified: 0,
    body: `## Weekly weigh-in

| Date | Weight (kg) | BF % | Notes |
|------|-------------|------|-------|
| ${seedJournalDate('2026-04-05')} | 87.1 | 21.0 | Starting line |
| ${seedJournalDate('2026-04-12')} | 86.4 | 20.4 | Easy week |
| ${seedJournalDate('2026-04-19')} | 85.5 | 19.6 | Cardio added |
| ${seedJournalDate('2026-04-26')} | 85.0 | 19.1 | Stalled, kept patient |
| ${seedJournalDate('2026-05-03')} | 84.0 | 18.4 | Whoosh |
| ${seedJournalDate('2026-05-08')} | 82.4 | 18.0 | On pace |

## Observations

- Protein at 180g is non-negotiable; below it I lose strength
- 7 hours sleep correlates with better Sunday numbers
- Travel weeks ≠ progress weeks (see [[Tokyo Trip]])

#fitness #log
`
  },
  {
    id: NOTE_IDS.weightProteinTargets,
    relativePath: 'weight/Protein Targets.md',
    title: 'Protein Targets',
    emoji: '🍳',
    tags: ['fitness', 'nutrition'],
    customProps: { status: 'active' },
    daysAgoCreated: -38,
    daysAgoModified: -12,
    body: `## Daily floor: 180g

Spread across 4 meals (~45g each):

- **Breakfast** — 4 eggs + Greek yogurt + cottage cheese (~50g)
- **Lunch** — 200g chicken or 250g cod (~45g)
- **Snack** — protein shake (~30g)
- **Dinner** — 200g lean beef or salmon (~45g)

## Whey is a tool not a crutch

Real food first. Powder fills gaps after lifting.

#fitness #nutrition
`
  },
  {
    id: NOTE_IDS.weightTrainingSplit,
    relativePath: 'weight/Training Split.md',
    title: 'Training Split',
    emoji: '🏋️',
    tags: ['fitness', 'strength'],
    customProps: { status: 'active' },
    daysAgoCreated: -90,
    daysAgoModified: -10,
    body: `## 4-day upper/lower

- **Mon** — Lower (squat heavy, RDL, walking lunges)
- **Tue** — Upper (bench, weighted pull-ups, DB row)
- **Thu** — Lower (DL heavy, front squat, leg curl)
- **Fri** — Upper (OHP, pull-ups, dips, curls)

Wed and Sat are [[Cardio Plan]]. Sun rest.

## Cues

- Squat: brace, feet wide enough to see toes
- DL: bar over mid-foot, lats engaged before lift
- Bench: tucked elbows, leg drive

#fitness #strength
`
  },
  {
    id: NOTE_IDS.weightSundayWeighIn,
    relativePath: 'weight/Sunday Weigh-in.md',
    title: 'Sunday Weigh-in',
    emoji: '⚖️',
    tags: ['fitness', 'tracking'],
    customProps: { status: 'active' },
    daysAgoCreated: -150,
    daysAgoModified: -7,
    body: `Once a week. Sunday morning, after the bathroom, before water.

Daily weighing is noise.

Goes into [[Cutting Log]].

#fitness
`
  },
  {
    id: NOTE_IDS.weightCardioPlan,
    relativePath: 'weight/Cardio Plan.md',
    title: 'Cardio Plan',
    emoji: '🏃',
    tags: ['fitness', 'cardio'],
    customProps: { status: 'active' },
    daysAgoCreated: -90,
    daysAgoModified: -25,
    body: `Two sessions per week:

- Wed — 30 min zone-2 (treadmill, easy nose-breathing)
- Sat — 20 min interval (8 × 30s sprint / 60s walk)

Heart rate monitor on, not optional.

#fitness #cardio
`
  },
  {
    id: NOTE_IDS.weightFoodDiary,
    relativePath: 'weight/Food Diary.md',
    title: 'Food Diary',
    emoji: '🥗',
    tags: ['fitness', 'food'],
    customProps: { status: 'active' },
    daysAgoCreated: -38,
    daysAgoModified: -1,
    body: `Loose log — only the meals that surprised me.

- ${seedJournalDate('2026-05-06')} — Korean BBQ. Stayed lean by stacking veg first; came in under 1100 kcal.
- ${seedJournalDate('2026-05-04')} — Pizza Saturday. Two slices, walked an hour after.
- ${seedJournalDate('2026-05-02')} — Found a great mackerel teishoku spot near the office.

#fitness #food
`
  },
  {
    id: NOTE_IDS.weightProgressPhotos,
    relativePath: 'weight/Progress Photos.md',
    title: 'Progress Photos',
    emoji: '📸',
    tags: ['fitness', 'tracking'],
    customProps: { status: 'active' },
    daysAgoCreated: -38,
    daysAgoModified: -1,
    body: `Friday morning, kitchen window light, same angles. No flexing for the front shot — natural shoulders.

Compares to [[2026 Cut]] start.

![Front ${seedJournalDate('2026-05-08')}](attachments/weight-front-may.jpg)

#fitness
`
  },

  // ============================================================================
  // LIFE
  // ============================================================================
  {
    id: NOTE_IDS.lifeMyWhy,
    relativePath: 'life/My Why.md',
    title: 'My Why',
    emoji: '🌳',
    tags: ['life', 'reflection', 'mission'],
    customProps: { mood: 5 },
    daysAgoCreated: -700,
    daysAgoModified: -7,
    body: `## Why I'm building [[memrynote Launch|memrynote]]

I lost five years of journal entries to a SaaS that pivoted, then sunset their consumer product. Two months notice and a CSV that didn't include any of the formatting.

I'm building memrynote so my **future self** can read my **current self** without asking permission from a vendor.

Local first. End-to-end encrypted. Open file format. Sync optional.

> The default settings of the universe should not include "your data is at risk because we ran out of runway."

#life #mission
`
  },
  {
    id: NOTE_IDS.lifeOnReading,
    relativePath: 'life/On Reading.md',
    title: 'On Reading',
    emoji: '📖',
    tags: ['life', 'reading', 'reflection'],
    customProps: { mood: 4 },
    daysAgoCreated: -200,
    daysAgoModified: -20,
    body: `## Why I keep at it

Three reasons, in increasing order of importance:

1. **Information** — useful, but Wikipedia handles this
2. **Empathy** — fiction is a flight simulator for other lives
3. **Slowness** — books make me *think slower*, which I cannot get anywhere else

## What I avoid

~~Self-help books that should have been blog posts.~~ Most of them.

I'd rather read [[Atomic Habits]] (one good idea, executed well) than another *7 Habits Of...* knockoff.

## What I keep coming back to

- [[Deep Work]] — for the *defend the time* argument
- [[Man's Search for Meaning]] — when things are hard

#life #reading
`
  },
  {
    id: NOTE_IDS.lifeYearReview2025,
    relativePath: 'life/Year in Review 2025.md',
    title: 'Year in Review 2025',
    emoji: '📅',
    tags: ['life', 'annual', 'reflection'],
    customProps: { mood: 4 },
    daysAgoCreated: -130,
    daysAgoModified: -125,
    body: `## What I shipped

- memrynote MVP, sync v1
- 12kg lost (and kept off through holidays)
- Trip to [[Tokyo Trip]] — first long flight since 2019

## What I read (highlights)

- [[Project Hail Mary]] — best fiction of the year
- [[Four Thousand Weeks]] — the book I needed
- [[On Writing]] — second time, hit harder

## What didn't work

- Two side projects abandoned at 60% — see [[Side Project Ideas]]
- Three-month gap in journaling (Q3, no good reason)

## 2026 themes

- *Ship memrynote to friends*
- *Lose the last 6kg*
- *Write more in public*

#life #annual
`
  },
  {
    id: NOTE_IDS.lifeMorningRoutine,
    relativePath: 'life/Morning Routine.md',
    title: 'Morning Routine',
    emoji: '☀️',
    tags: ['life', 'habits'],
    customProps: { mood: 5 },
    daysAgoCreated: -150,
    daysAgoModified: -30,
    body: `## 05:45 — 08:00

- 05:45 — Up, water, no phone
- 06:00 — 20 min journal — see today's entry
- 06:30 — Coffee + read 30 min
- 07:00 — Write (memrynote, blog, journal)
- 08:00 — Shower, breakfast, day starts

## Rules

1. No notifications until 09:00
2. Phone in another room until 06:30
3. *Coffee is the reward, not the start*

Inspired by [[Deep Work]]. Codified after [[Atomic Habits]].

#life #habits
`
  },
  {
    id: NOTE_IDS.lifeFinances,
    relativePath: 'life/Finances.md',
    title: 'Finances',
    emoji: '💸',
    tags: ['life', 'money'],
    customProps: { mood: 4 },
    daysAgoCreated: -300,
    daysAgoModified: -10,
    body: `## Allocation (target)

| Bucket | % | Vehicle |
|--------|---|---------|
| Index funds | 60 | Boring 3-fund portfolio |
| Cash buffer | 20 | 6 months expenses |
| Speculative | 10 | Crypto, individual stocks |
| Cause/giving | 5 | Effective altruism + local |
| Fun | 5 | Travel + a guilt-free buffer |

## Rules I keep

- *Pay myself first.* Auto-transfer on payday.
- *No new credit cards.* The points game is a tax on attention.
- *One big purchase per year* — last year was the [[Tokyo Trip]].

#life #money
`
  },
  {
    id: NOTE_IDS.lifeOnFear,
    relativePath: 'life/On Fear.md',
    title: 'On Fear',
    emoji: '🌑',
    tags: ['life', 'reflection'],
    customProps: { mood: 3 },
    daysAgoCreated: -90,
    daysAgoModified: -45,
    body: `## What I'm afraid of, in 2026

- Building memrynote "wrong" — the wrong abstractions, the wrong scope
- Going public before it's ready
- Going public after it's *too* ready (waited too long)

## What I do about it

Read [[Man's Search for Meaning]] when it's bad. Talk to my partner. Run hard. Sleep more.

> The fear of suffering is worse than the suffering itself.

#life #reflection
`
  },
  {
    id: NOTE_IDS.lifeRelationships,
    relativePath: 'life/Relationships.md',
    title: 'Relationships',
    emoji: '🫶',
    tags: ['life', 'people'],
    customProps: { mood: 5 },
    daysAgoCreated: -250,
    daysAgoModified: -10,
    body: `## Inner ring

People I want to invest in this year:

- M. — see them every quarter, not less
- D. — one long phone call per month
- Two old friends I haven't seen since 2023

## Mid ring

Birthdays, occasional dinners. Loose contact, real warmth.

## "Calendar weight"

If a relationship is important, it should show up *in the calendar*, not just in my head.

#life #people
`
  },
  {
    id: NOTE_IDS.lifeWhatBringsJoy,
    relativePath: 'life/What Brings Me Joy.md',
    title: 'What Brings Me Joy',
    emoji: '😄',
    tags: ['life', 'gratitude', 'joy'],
    customProps: { mood: 5 },
    daysAgoCreated: -45,
    daysAgoModified: -3,
    body: `Running list. Adding when something hits, never editing.

- The sound of espresso pulling
- A good problem at 06:30 with no one awake
- [[Spirited Away]] for the tenth time
- The smell of a new bookstore (looking at you, [[Tokyo Cafes|Tokyo book cafes]])
- The first 5 minutes of a long walk
- Discovering my younger self made a smart decision I'd forgotten

#life #joy
`
  },

  // ============================================================================
  // PROJECTS
  // ============================================================================
  {
    id: NOTE_IDS.projMemryLaunch,
    relativePath: 'projects/memrynote Launch.md',
    title: 'memrynote Launch',
    emoji: '🚀',
    tags: ['projects/memry', 'projects/active'],
    customProps: {
      status: 'active',
      priority: 'high',
      deadline: seedJournalDate('2026-07-01'),
      owner: 'Kaan'
    },
    daysAgoCreated: -90,
    daysAgoModified: 0,
    body: `## Launch plan

Aim for ${seedJournalDate('2026-07-01')}. Soft launch to ~50 friends + IndieHackers.

## What's left

- [x] Sync v1 — see [[CRDT Architecture]]
- [x] Calendar v1
- [x] Inbox capture
- [ ] Mobile read-only
- [ ] Public landing
- [ ] Pricing decision
- [ ] Launch post on HN — see [[Conference Talk]] for the speech version

## Risks

> [!warning]
> The biggest risk is *scope creep*, not bugs. Every "what about graph view 2.0" is two weeks I don't have.

## Tech debts I'm carrying

- See [[Drizzle ORM]] for the JSON-column gotcha
- See [[Electron Gotchas]] for native-build pain
- Postgres was almost the choice — see [[Postgres Indexing]]

## Linked tasks

Tasks tagged \`#projects/memry\` show up under "memrynote Launch" project — these are the granular execution items.

#projects/memry #active
`
  },
  {
    id: NOTE_IDS.projMemryArchitecture,
    relativePath: 'projects/memrynote Architecture.md',
    title: 'memrynote Architecture',
    emoji: '🏛️',
    tags: ['projects/memry', 'architecture'],
    customProps: {
      status: 'active',
      priority: 'high',
      deadline: seedJournalDate('2026-06-01'),
      owner: 'Kaan'
    },
    daysAgoCreated: -200,
    daysAgoModified: -3,
    body: `## Boundaries

- **Renderer** — React 19, no Node access
- **Main** — Electron, owns SQLite + Y.Docs
- **Sync** — Cloudflare Workers + D1 + R2; never sees plaintext
- **Contracts** — Zod-typed IPC + API

See [[CRDT Architecture]] and [[Drizzle ORM]] for the data layer.

## Why Electron

Local-first means *all* data is on disk. Browser sandbox is a non-starter.

#projects/memry #architecture
`
  },
  {
    id: NOTE_IDS.projMemryRoadmap,
    relativePath: 'projects/memrynote Roadmap.md',
    title: 'memrynote Roadmap',
    emoji: '🗺️',
    tags: ['projects/memry', 'planning'],
    customProps: {
      status: 'active',
      priority: 'medium',
      deadline: seedJournalDate('2026-12-31'),
      owner: 'Kaan'
    },
    daysAgoCreated: -150,
    daysAgoModified: -7,
    body: `## Q2 2026

- v0.1 launch — see [[memrynote Launch]]
- Mobile read-only
- iCal sync polish

## Q3 2026

- Mobile capture
- Plugin API draft
- First paid tier

## Q4 2026

- Plugin marketplace
- Workspace sharing (selective)

#projects/memry #planning
`
  },
  {
    id: NOTE_IDS.projMemryGTM,
    relativePath: 'projects/memrynote GTM.md',
    title: 'memrynote GTM',
    emoji: '📣',
    tags: ['projects/memry', 'gtm'],
    customProps: {
      status: 'active',
      priority: 'medium',
      deadline: seedJournalDate('2026-07-01'),
      owner: 'Kaan'
    },
    daysAgoCreated: -60,
    daysAgoModified: -2,
    body: `## Audience

People who already journal but resent their tool. Bonus: programmers, researchers, knowledge workers.

## Channels

1. HN launch post — see [[Conference Talk]] for the long-form version
2. IndieHackers + Twitter
3. One thoughtful blog post per month

## Anti-patterns

- No paid ads. Not yet.
- No "cheaper alternative" framing. We stand on our own.

#projects/memry #gtm
`
  },
  {
    id: NOTE_IDS.projMemryMobile,
    relativePath: 'projects/memrynote Mobile.md',
    title: 'memrynote Mobile',
    emoji: '📱',
    tags: ['projects/memry', 'mobile', 'architecture'],
    customProps: {
      status: 'active',
      priority: 'high',
      deadline: seedJournalDate('2026-09-15'),
      owner: 'Kaan',
      platform: 'iOS + Android'
    },
    daysAgoCreated: -75,
    daysAgoModified: -1,
    body: `The desktop app is where the vault lives. The phone is where the thought *arrives* — in a queue, on a walk, ten seconds before it evaporates. This note is the whole plan for closing that gap.

## Why a phone app at all

> [!info]
> Capture in under three seconds, or it is not capture. Every decision below is downstream of that one number.

- Capture first, edit second — the desktop keeps the editing crown
- Read the entire vault offline, on a plane, with no account check
- Never the place where a note gets damaged

## Stack

| Layer | Choice | Why |
| ----- | ------ | --- |
| Runtime | Expo SDK 54 | EAS builds, OTA updates, no Xcode babysitting |
| Language | TypeScript strict | Shares \`packages/contracts\` with desktop |
| Storage | expo-sqlite + FTS5 | Same schema shape as the desktop data DB |
| Crypto | libsodium (RN) | XChaCha20-Poly1305, byte-identical to desktop |
| UI | React Native + Reanimated | 120 Hz gestures, native feel |

### Runtime

- Expo Router — file-based navigation, deep links for free
- Hermes engine, bytecode precompiled at build time
- Dev client, never Expo Go: native modules are the whole point

### Data

- Drizzle schema mirrored from desktop, migrations hand-written
- Field-level vector clocks for tasks — see [[CRDT Architecture]]
- FTS5 index rebuilt incrementally, never on cold start

### UI

- Tokens ported from [[memrynote Architecture]]
- Logical properties everywhere — RTL from day one
- One accent, no gradients, no shadow deeper than 8dp

## Architecture

The phone is a **peer**, not a client. It talks to the same sync server every desktop install talks to, and it holds the same encrypted bytes.

### Boundaries

- **Screens** — Expo Router routes, zero direct DB access
- **Stores** — one Zustand store per domain
  - Selectors are the only read path
  - No store reads another store
- **Repos** — the only code that touches SQLite
- **Sync** — a background task, pull then push

### The sync seam

\`\`\`ts
// mobile/src/sync/pull.ts
export async function pull(vaultId: string, since: Cursor): Promise<PullResult> {
  const page = await api.pull({ vaultId, since, types: SUPPORTED_TYPES })
  for (const item of page.items) {
    const plain = await decrypt(item.payload, await vaultKey(vaultId))
    await repo(item.type).upsert(plain)
  }
  return { cursor: page.cursor, applied: page.items.length }
}
\`\`\`

- The pull cursor is per vault, per type
- Payloads land in SQLite; note bodies decrypt lazily on open
- A rejected item is recorded as \`skipped\` — never retried blindly, because blind retry is how one malformed timestamp becomes a permanent sync loop

### Offline and storage

1. Every screen reads from SQLite, always
2. The network only ever *fills* the database
3. A failed sync is a banner, never a blocked screen

- Attachment cache capped at 512 MB, LRU eviction
- Bodies over 4 MB are fetched on demand, not on sync
- Cold start never waits on a request

### Performance budget

| Metric | Budget | Measured on |
| ------ | ------ | ----------- |
| Cold start → first paint | 400 ms | Release build, iPhone 12 |
| Note open, cached | 80 ms | In-app instrumentation |
| Search keystroke → results | 50 ms | FTS5, 5k notes |
| Full sync, 1k notes | 20 s | Wi-Fi, staging server |

> A budget nobody measures is a wish. These four numbers go on the dashboard before the first beta build ships.

## Editor on device

<details data-memry-toggle open>
<summary>Why not render BlockNote natively?</summary>

- The block schema is 30+ custom blocks; porting them twice is two products
- A WebView bridge keeps one schema, one serializer, one bug surface
- Read mode stays native, so most sessions never touch the WebView

</details>

- **Read mode** renders markdown natively — instant, no WebView cost
- **Edit mode** loads the shared web editor behind a typed bridge
- The bridge speaks the same block JSON the desktop writes to disk

## Tables you can actually work in

The table work landed on desktop before mobile started, so the phone inherits all of it. Put images in cells, colour cells, and reach the row, column and cell menus from handles on the border lines. Add and remove rows and columns from the keyboard. Drag across cells and you select just those cells instead of grabbing the whole table. A column width you dragged survives reopening the note.

<!-- table-colors:{"0:0":{"textColor":"blue"},"0:1":{"textColor":"blue"},"0:2":{"textColor":"blue"},"0:3":{"textColor":"blue"},"1:2":{"backgroundColor":"green"},"2:2":{"backgroundColor":"yellow"},"3:2":{"backgroundColor":"red"},"3:3":{"textColor":"red"}} -->
<!-- table-layout:{"columnWidths":[200,170,130,null]} -->
| Screen | Preview | Status | Owner |
| ------ | ------- | ------ | ----- |
| Notes list | ![Notes list](https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?auto=format&fit=crop&w=200&q=60) | Shipped | Native list |
| Capture sheet | ![Capture sheet](https://images.unsplash.com/photo-1585060544812-6b45742d762f?auto=format&fit=crop&w=200&q=60) | In review | Native + keyboard |
| Note editor | ![Note editor](https://images.unsplash.com/photo-1510557880182-3d4d3cba35a5?auto=format&fit=crop&w=200&q=60) | Blocked | WebView bridge |

### What the handles do

- **Row handle** — insert above or below, delete the row, colour the whole row
- **Column handle** — insert left or right, delete the column, drag the edge to resize
- **Cell menu** — text colour, background colour, clear formatting
  - Opens from the border line, so it never covers the cell you are editing
  - The same menu on phone, opened by long-press instead of hover

### From the keyboard

| Action | Shortcut |
| ------ | -------- |
| Row below | Cmd + Enter |
| Row above | Cmd + Shift + Enter |
| Column right | Cmd + Shift + = |
| Delete row or column | Cmd + Backspace |

### What survived the round trip

- [x] Cell colours, written as a \`table-colors\` marker line
- [x] Column widths, written as a \`table-layout\` marker line
- [x] Images inside cells, as plain \`![alt](src)\` a phone can render
- [ ] Merged cells — parked, the markdown form is not settled yet

> [!success]
> Every one of those is a marker line a plain markdown reader ignores. Nothing about the file format changed — the vault stays portable.

<details data-memry-toggle>
<summary>Why the widths live in a marker line</summary>

BlockNote's markdown serializer drops \`columnWidths\` entirely, so a dragged width has nowhere to live in GFM. The marker sits on the line above the table, is ignored by every other markdown reader, and comes back onto the block on parse — the same trick the callout and alignment markers use.

</details>

## Screens

### Notes

- Folder tree, same row contract as the desktop sidebar
- Row = emoji + title + one-line snippet
- Swipe to file, long-press for the action sheet

### Capture

- Opens straight into the keyboard, no chrome
- Voice memo → transcript → inbox item
- Share-sheet target from any app on the phone

### Tasks

- Today · Upcoming · Done
- The checkbox writes markdown, not a DB flag — see [[memrynote Launch]]

### Settings

- Vault, sync, appearance, about
- Face ID lock, shipped off by default

## Release plan

- [x] Expo shell, navigation, design tokens
- [x] Read-only vault browsing
- [x] Sync pull path against staging
- [ ] Capture + inbox
- [ ] Push path for tasks and journals
- [ ] TestFlight beta — see [[memrynote Roadmap]]
- [ ] App Store review pass
- [ ] Android build on the same binary contract

## Risks

> [!warning]
> The WebView editor is the single largest bet in this plan. If the bridge feels laggy on a three-year-old Android, read mode has to carry the product alone until v2.

<details data-memry-toggle>
<summary>Quieter risks worth writing down</summary>

- Background sync on iOS is a suggestion, not a schedule
- Keychain migration across reinstalls can lose the vault key
- Two stores means two review queues on every release day — see [[Electron Gotchas]] for the desktop version of this pain

</details>

## Open questions

1. Does capture live in the app, or in a widget and share sheet only?
2. Android at launch, or six weeks behind iOS?
3. Is mobile a separate tier, or bundled with the desktop plan? — [[memrynote GTM]]

## Links

- Parent project: [[memrynote Launch]]
- Long game: [[memrynote Roadmap]]
- Data layer: [[CRDT Architecture]] and [[Drizzle ORM]]
- Native build pain, desktop edition: [[Electron Gotchas]]
- Review notes: [[${seedJournalDate('2026-05-13')}]]

#projects/memry #mobile #active
`
  },
  {
    id: NOTE_IDS.projGardenSchedule,
    relativePath: 'projects/Garden Schedule.md',
    title: 'Garden Schedule',
    emoji: '🌱',
    tags: ['projects/home', 'garden'],
    customProps: {
      status: 'active',
      priority: 'low',
      deadline: seedJournalDate('2026-09-15'),
      owner: 'Self'
    },
    daysAgoCreated: -45,
    daysAgoModified: -1,
    body: `## Spring

- [x] Tomato seedlings — done ${seedJournalDate('2026-04-12')}
- [x] Basil — three pots
- [ ] Bell peppers — week of 5/15
- [ ] Mint divider barriers (it'll take over otherwise)

## Summer plan

Focus on what survives a heat dome: peppers, eggplant, zucchini.

#projects/home
`
  },
  {
    id: NOTE_IDS.projHomeRenovation,
    relativePath: 'projects/Home Renovation.md',
    title: 'Home Renovation',
    emoji: '🔨',
    tags: ['projects/home', 'renovation'],
    customProps: {
      status: 'backlog',
      priority: 'medium',
      deadline: seedJournalDate('2026-10-01'),
      owner: 'Self'
    },
    daysAgoCreated: -30,
    daysAgoModified: -15,
    body: `## Punch list

- [ ] Replace kitchen lights (LED retrofit)
- [ ] Sand and stain back deck
- [ ] Insulate attic crawl-space
- [ ] Replace bathroom fan

## Budget

| Item | Estimate |
|------|----------|
| Kitchen lights | $400 |
| Deck refinish | $800 |
| Attic insulation | $1500 |
| Bathroom fan | $250 |
| **Total** | **$2950** |

#projects/home
`
  },
  {
    id: NOTE_IDS.projBlogRedesign,
    relativePath: 'projects/Blog Redesign.md',
    title: 'Blog Redesign',
    emoji: '✏️',
    tags: ['projects/personal', 'web'],
    customProps: {
      status: 'active',
      priority: 'low',
      deadline: seedJournalDate('2026-06-15'),
      owner: 'Self'
    },
    daysAgoCreated: -25,
    daysAgoModified: -3,
    body: `Migrating from a static-site to Astro. Mostly to relearn the tooling, partly because I want better RSS.

Tracking related work: [[TypeScript Patterns]], [[Vim Motions]].

#projects/personal #web
`
  },
  {
    id: NOTE_IDS.projOpenSourceFork,
    relativePath: 'projects/Open Source Fork.md',
    title: 'Open Source Fork',
    emoji: '🌿',
    tags: ['projects/personal', 'oss'],
    customProps: {
      status: 'idea',
      priority: 'low',
      owner: 'Self'
    },
    daysAgoCreated: -10,
    daysAgoModified: -2,
    body: `Considering a fork of an inactive markdown-link-checker. Not much code — but it'd save the team 30 minutes a week.

Move only if a real maintainer disappears for ~6 months.

#projects/oss
`
  },
  {
    id: NOTE_IDS.projSideProjectIdeas,
    relativePath: 'projects/Side Project Ideas.md',
    title: 'Side Project Ideas',
    emoji: '💡',
    tags: ['projects/personal', 'ideas'],
    customProps: {
      status: 'idea',
      priority: 'low',
      owner: 'Self'
    },
    daysAgoCreated: -180,
    daysAgoModified: -3,
    body: `Running list — most won't ship, that's fine.

- **CSV → graph** — drop a CSV, get an opinionated chart
- **Reading retreats** — a service that books you a forced offline weekend
- **Espresso log** — local-first, niche, mine
- **Anti-newsletter** — subscriptions you *cancel* together
- **Calendar diff tool** — compare meetings between two weeks

Linked: [[Year in Review 2025]] (the *abandoned-at-60%* problem).

#projects/personal #ideas
`
  },
  {
    id: NOTE_IDS.projConferenceTalk,
    relativePath: 'projects/Conference Talk.md',
    title: 'Conference Talk',
    emoji: '🎤',
    tags: ['projects/personal', 'speaking'],
    customProps: {
      status: 'active',
      priority: 'medium',
      deadline: seedJournalDate('2026-09-15'),
      owner: 'Self'
    },
    daysAgoCreated: -55,
    daysAgoModified: -5,
    body: `## Title (working)

*Local-first is a choice, not a feature.*

## Outline

1. The cloud is a great default — most of the time
2. The four times it isn't (vendor death, churn, latency, jurisdiction)
3. What "local-first" actually means (Kleppmann, 2019)
4. memrynote as a worked example
5. The trade-offs nobody likes to talk about

## Submitted to

- StrangeLoop — pending
- LocalFirst Conf — accepted, talk on ${seedJournalDate('2026-09-15')}

#projects/personal #speaking
`
  },

  // ============================================================================
  // TECH
  // ============================================================================
  {
    id: NOTE_IDS.techTypescriptPatterns,
    relativePath: 'tech/TypeScript Patterns.md',
    title: 'TypeScript Patterns',
    emoji: '🟦',
    tags: ['tech/typescript', 'reference'],
    customProps: { language: 'typescript', level: 'intermediate', status: 'active' },
    daysAgoCreated: -240,
    daysAgoModified: -2,
    body: `## Discriminated unions for IPC

\`\`\`typescript
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

function parse(json: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(json) }
  } catch (e) {
    return { ok: false, error: e as Error }
  }
}
\`\`\`

## Branded types for IDs

\`\`\`typescript
type NoteId = string & { readonly _brand: unique symbol }
const asNoteId = (s: string): NoteId => s as NoteId
\`\`\`

## Why I don't use \`any\`

Because the moment I do, I've thrown away the only reason to write TypeScript. Use \`unknown\` and refine.

Linked: [[Drizzle ORM]] for type inference details, [[memrynote Architecture]] for the IPC boundary.

#tech/typescript #reference
`
  },
  {
    id: NOTE_IDS.techDrizzleORM,
    relativePath: 'tech/Drizzle ORM.md',
    title: 'Drizzle ORM',
    emoji: '🦉',
    tags: ['tech/sql', 'tech/typescript', 'reference'],
    customProps: { language: 'typescript', level: 'intermediate', status: 'active' },
    daysAgoCreated: -180,
    daysAgoModified: -1,
    body: `## Why I picked it

Type-safe, no codegen runtime, ergonomics close to writing SQL by hand. Pairs well with [[TypeScript Patterns]].

## Schema example

\`\`\`typescript
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').$type<TaskStatus>(),
  metadata: text('metadata', { mode: 'json' }).$type<Metadata | null>()
})
\`\`\`

> [!warning]
> Nullable JSON columns require \`null\` not \`undefined\` in \`.values()\` inserts. Otherwise Drizzle silently drops them and SQLite stores \`'undefined'\` as a string. Burned me twice.

## Migrations

Hand-written since 0020 — see commit \`b4c3f2\`. The autogenerated diffs got noisy after meta snapshots stopped being honest.

\`\`\`bash
pnpm db:generate    # schema → SQL
pnpm db:push        # apply
pnpm db:studio      # browse
\`\`\`

#tech/sql #tech/typescript
`
  },
  {
    id: NOTE_IDS.techCRDTArchitecture,
    relativePath: 'tech/CRDT Architecture.md',
    title: 'CRDT Architecture',
    emoji: '🧩',
    tags: ['tech/sync', 'tech/architecture'],
    customProps: { level: 'advanced', status: 'active' },
    daysAgoCreated: -120,
    daysAgoModified: -2,
    body: `## Why Yjs

CRDT for rich text. Built-in awareness. Battle-tested.

## Sync flow

\`\`\`mermaid
sequenceDiagram
    participant A as Device A
    participant S as Sync Server
    participant B as Device B
    A->>S: push update (encrypted)
    S->>B: notify
    B->>S: pull updates
    S-->>B: encrypted bytes
    B->>B: decrypt + apply
\`\`\`

## Field-level vector clocks

For tasks/projects — see the [[Drizzle ORM]] schema for \`field_clocks\` JSON column. This avoids whole-row LWW for structured records.

## Footnote on naming

Yes, "CRDT" is overloaded[^1]. Yjs implements a state-based CRDT (specifically a YATA variant).

[^1]: Operational vs state vs delta-state CRDTs are all called "CRDTs" in conversation. Worth being precise in PR reviews.

#tech/sync #tech/architecture
`
  },
  {
    id: NOTE_IDS.techPostgresIndexing,
    relativePath: 'tech/Postgres Indexing.md',
    title: 'Postgres Indexing',
    emoji: '🐘',
    tags: ['tech/sql', 'tech/postgres'],
    customProps: { language: 'sql', level: 'intermediate' },
    daysAgoCreated: -160,
    daysAgoModified: -50,
    body: `## When B-tree isn't enough

\`\`\`sql
-- Partial index for hot path
CREATE INDEX idx_tasks_active
  ON tasks (project_id, modified_at DESC)
  WHERE archived_at IS NULL;

-- GIN for tag arrays
CREATE INDEX idx_tasks_tags
  ON tasks USING GIN (tags);

-- BRIN for time-series, low maintenance
CREATE INDEX idx_events_brin
  ON events USING BRIN (created_at);
\`\`\`

## Pair with EXPLAIN ANALYZE

Always. Otherwise you're index-cargo-culting.

## Reference

[[CMU Database Course]] — the deep dive that finally made this stick.

#tech/sql #tech/postgres
`
  },
  {
    id: NOTE_IDS.techCMUDatabaseCourse,
    relativePath: 'tech/CMU Database Course.md',
    title: 'CMU Database Course',
    emoji: '🎓',
    tags: ['tech/sql', 'learning'],
    customProps: { level: 'advanced' },
    daysAgoCreated: -210,
    daysAgoModified: -90,
    body: `Andy Pavlo's *Intro to Database Systems* (15-445). Watched all of fall 2024.

The B+ tree section unstuck me. The query optimizer one terrified me — in a good way.

Pair with [[Postgres Indexing]] for practice.

#tech/sql #learning
`
  },
  {
    id: NOTE_IDS.techKipThorneBlackHoles,
    relativePath: 'tech/Kip Thorne — Black Holes.md',
    title: 'Kip Thorne — Black Holes',
    emoji: '⚫',
    tags: ['tech/physics', 'reference'],
    customProps: { level: 'intermediate' },
    daysAgoCreated: -290,
    daysAgoModified: -100,
    body: `## Why I read this in 2026

Watched [[Interstellar]] for the fourth time. Wanted to understand Gargantua, not just gawk at it.

## Highlights

- Schwarzschild radius is *that* simple: $r_s = \\frac{2GM}{c^2}$
- Spinning black holes have an ergosphere — energy can be extracted
- The hairy theorem: a black hole has only mass, charge, and spin[^1]

[^1]: Kerr-Newman, technically.

> Black holes are not dragons. They are *predictions*.

#tech/physics
`
  },
  {
    id: NOTE_IDS.techElectronGotchas,
    relativePath: 'tech/Electron Gotchas.md',
    title: 'Electron Gotchas',
    emoji: '⚡',
    tags: ['tech/electron', 'reference'],
    customProps: { language: 'javascript', level: 'intermediate' },
    daysAgoCreated: -100,
    daysAgoModified: -5,
    body: `## Native module ABI

\`better-sqlite3\` must be rebuilt against the *target* runtime.

\`\`\`bash
# For node tests
pnpm rebuild better-sqlite3

# For electron app
pnpm exec electron-rebuild -f -o better-sqlite3
\`\`\`

> [!error]
> Forget this and you'll get \`ERR_DLOPEN_FAILED\` and the app falls through to the welcome screen. Spent two hours on this once.

## IPC contract drift

Run \`pnpm ipc:check\` after editing any contract type. Renderer will lie about preload until you do.

#tech/electron
`
  },
  {
    id: NOTE_IDS.techSqliteVec,
    relativePath: 'tech/sqlite-vec.md',
    title: 'sqlite-vec',
    emoji: '🧮',
    tags: ['tech/sql', 'tech/embeddings'],
    customProps: { language: 'sql', level: 'intermediate' },
    daysAgoCreated: -50,
    daysAgoModified: -8,
    body: `## Setup

\`\`\`typescript
import * as sqliteVec from 'sqlite-vec'
sqliteVec.load(sqliteDb)

sqliteDb.exec(\`
  CREATE VIRTUAL TABLE vec_notes USING vec0(
    note_id TEXT PRIMARY KEY,
    embedding float[384] distance_metric=cosine
  )
\`)
\`\`\`

## Querying

\`\`\`sql
SELECT note_id, distance
FROM vec_notes
WHERE embedding MATCH ?
  AND k = 10
ORDER BY distance;
\`\`\`

#tech/sql #tech/embeddings
`
  },
  {
    id: NOTE_IDS.techVimMotions,
    relativePath: 'tech/Vim Motions.md',
    title: 'Vim Motions',
    emoji: '⌨️',
    tags: ['tech/editor', 'reference'],
    customProps: { level: 'intermediate' },
    daysAgoCreated: -800,
    daysAgoModified: -30,
    body: `## Motions I use daily

- \`ciw\` — change inner word
- \`dap\` — delete a paragraph
- \`%\` — match brace
- \`f<char>\` and \`t<char>\` — jump to char
- \`gd\` — go to definition

## Plugins

- vim-surround
- vim-commentary
- fzf.vim

#tech/editor
`
  },
  {
    id: NOTE_IDS.techGitWorkflow,
    relativePath: 'tech/Git Workflow.md',
    title: 'Git Workflow',
    emoji: '🌿',
    tags: ['tech/git', 'reference'],
    customProps: { level: 'intermediate' },
    daysAgoCreated: -350,
    daysAgoModified: -14,
    body: `## Daily

\`\`\`bash
git switch -c feat/inbox-snooze
# work...
git add -p
git commit -m "feat: snooze inbox items with reason"
git push -u origin HEAD
gh pr create --fill
\`\`\`

## Rebase, don't merge

Until the branch lands. After that, it's history.

#tech/git
`
  },
  {
    id: NOTE_IDS.techRustNotes,
    relativePath: 'tech/Rust Notes.md',
    title: 'Rust Notes',
    emoji: '🦀',
    tags: ['tech/rust', 'learning'],
    customProps: { language: 'rust', level: 'beginner', status: 'active' },
    daysAgoCreated: -75,
    daysAgoModified: -10,
    body: `Picking it up for fun and possible memrynote-CLI tooling.

\`\`\`rust
fn main() {
    let nums = vec![1, 2, 3, 4, 5];
    let sum: i32 = nums.iter().sum();
    println!("sum: {}", sum);
}
\`\`\`

Borrow checker is exactly as advertised. The first week is rough; the second week clicks.

#tech/rust #learning
`
  },
  {
    id: NOTE_IDS.techDockerCheatsheet,
    relativePath: 'tech/Docker Cheatsheet.md',
    title: 'Docker Cheatsheet',
    emoji: '🐳',
    tags: ['tech/docker', 'reference'],
    customProps: { language: 'shell', level: 'intermediate' },
    daysAgoCreated: -420,
    daysAgoModified: -25,
    body: `\`\`\`bash
docker ps -a
docker logs -f <container>
docker exec -it <container> /bin/bash
docker compose up -d
docker compose down -v
docker system prune -af --volumes
\`\`\`

#tech/docker
`
  },

  // ============================================================================
  // TRAVEL
  // ============================================================================
  {
    id: NOTE_IDS.travelIstanbul,
    relativePath: 'travel/Istanbul.md',
    title: 'Istanbul',
    emoji: '🌉',
    tags: ['travel', 'istanbul', 'planning'],
    aliases: ['Istanbul weekend', 'Istanbul city guide'],
    customProps: {
      location: 'Istanbul, Turkey',
      startDate: seedJournalDate('2026-05-23'),
      endDate: seedJournalDate('2026-05-25'),
      status: 'planning'
    },
    daysAgoCreated: -3,
    daysAgoModified: 0,
    body: `![Bosphorus ferry at sunset](https://images.unsplash.com/photo-1524231757912-21f4fe3a7200?auto=format&fit=crop&w=1400&q=80)

> [!info] Keep the first morning slow
> Ferry, simit, coffee, then one neighborhood at a time.

## Plan

| Day | Area | Anchor |
|-----|------|--------|
| Saturday | Karaköy + Galata | Coffee, galleries, sunset walk |
| Sunday | Kadıköy | Market breakfast, ferry back at golden hour |
| Monday | Sultanahmet | Hagia Sophia early, Basilica Cistern after lunch |

## Shortlist

- Çiya Sofrası for lunch
- Arter if it rains
- Moda Sahili for a long walk
- Turkish coffee near Galata before sunset

## Before we go

- [x] Save ferry times: https://sehirhatlari.istanbul
- [ ] Pack light layers from [[Packing List]]
- [ ] Add one easy dinner to [[Food Diary]]
- [ ] Screenshot the hotel address for offline use

## Links

- Journal: [[${seedJournalDate('2026-05-17')}]]
- Travel checklist: [[Packing List]]
- Food notes: [[Food Diary]]

#travel #istanbul #planning
`
  },
  {
    id: NOTE_IDS.travelTokyoTrip,
    relativePath: 'travel/Tokyo Trip.md',
    title: 'Tokyo Trip',
    emoji: '🗼',
    tags: ['travel/asia', 'travel/japan', 'memoir'],
    customProps: {
      location: 'Tokyo, Japan',
      startDate: seedJournalDate('2026-04-12'),
      endDate: seedJournalDate('2026-04-19'),
      status: 'done'
    },
    daysAgoCreated: -60,
    daysAgoModified: -19,
    body: `## Day-by-day

- **Day 1** — Land at Haneda 16:00. Tokyo Tower. Onigiri at Narita-zushi.
- **Day 2** — Shibuya, Meiji Jingu, late ramen at [[Osaka Ramen|the place I keep going to]] (technically Tokyo branch).
- **Day 3** — Ghibli Museum. See [[Spirited Away]] before the trip — pays off here.
- **Day 4** — Day trip to Kyoto — see [[Kyoto Day Trip]].
- **Day 5** — Tsukiji. Coffee crawl — see [[Tokyo Cafes]].
- **Day 6** — Disney Sea (yes).
- **Day 7** — Last day. Souvenirs. Cried at Tokyo Station.
- **Day 8** — Fly home.

## Spending

| Bucket | ¥ | $ |
|--------|---|---|
| Flights | 145000 | 970 |
| Hotel | 110000 | 735 |
| Food | 75000 | 500 |
| Trains | 25000 | 165 |
| Souvenirs | 30000 | 200 |
| **Total** | **385000** | **2570** |

## Photos

![Tokyo Tower at dusk](attachments/tokyo-tower.jpg)

Linked journal entries: [[${seedJournalDate('2026-04-15')}]], [[${seedJournalDate('2026-04-17')}]].

#travel/asia #japan
`
  },
  {
    id: NOTE_IDS.travelKyotoDayTrip,
    relativePath: 'travel/Kyoto Day Trip.md',
    title: 'Kyoto Day Trip',
    emoji: '⛩️',
    tags: ['travel/asia', 'travel/japan'],
    customProps: {
      location: 'Kyoto, Japan',
      startDate: seedJournalDate('2026-04-15'),
      endDate: seedJournalDate('2026-04-15'),
      status: 'done'
    },
    daysAgoCreated: -23,
    daysAgoModified: -23,
    body: `06:30 Shinkansen. Sit on the right side for Fuji.

## Hits

- Fushimi Inari at 09:00 — climb the back path, skip the gates Instagrammers
- Coffee + matcha at Kurasu (near the station)
- Kinkaku-ji in the afternoon light

## Misses

- Skipped Arashiyama on purpose. Save for a longer trip.

Linked: [[Tokyo Trip]] (the parent), journal [[${seedJournalDate('2026-04-15')}]].

#travel/asia
`
  },
  {
    id: NOTE_IDS.travelLisbonNotes,
    relativePath: 'travel/Lisbon Notes.md',
    title: 'Lisbon Notes',
    emoji: '🐠',
    tags: ['travel/europe', 'travel/portugal'],
    customProps: {
      location: 'Lisbon, Portugal',
      startDate: seedJournalDate('2025-11-08'),
      endDate: seedJournalDate('2025-11-13'),
      status: 'done'
    },
    daysAgoCreated: -190,
    daysAgoModified: -180,
    body: `## What I'd repeat

- Tram 28 — but at 07:30, not 11:00
- Pastel de nata at Manteigaria, not the famous one
- Sunset at Miradouro da Senhora do Monte

## What I'd skip

- Time-out market — fine but tourist-priced

#travel/europe
`
  },
  {
    id: NOTE_IDS.travelIcelandRingRoad,
    relativePath: 'travel/Iceland Ring Road.md',
    title: 'Iceland Ring Road',
    emoji: '🌋',
    tags: ['travel/europe', 'travel/iceland', 'planning'],
    customProps: {
      location: 'Iceland',
      startDate: seedJournalDate('2026-08-12'),
      endDate: seedJournalDate('2026-08-22'),
      status: 'planning'
    },
    daysAgoCreated: -40,
    daysAgoModified: -2,
    body: `## Plan

10 days, counterclockwise. Camper van with kitchen.

## Key stops

- Snæfellsnes peninsula
- Westfjords (extra 2 days, worth it)
- Lake Mývatn
- Höfn (lobster)
- Vik

## Watchlist before going

- *The Secret Life of Walter Mitty*
- *Fjall* documentary
- See [[Packing List]] — different from Tokyo

#travel/europe #planning
`
  },
  {
    id: NOTE_IDS.travelPackingList,
    relativePath: 'travel/Packing List.md',
    title: 'Packing List',
    emoji: '🎒',
    tags: ['travel', 'reference'],
    customProps: { status: 'active' },
    daysAgoCreated: -180,
    daysAgoModified: -10,
    body: `## Always

- Passport, IDs, two credit cards (separate bags)
- Phone, charger, plug adapter
- Kindle (loaded), eye mask, earplugs
- Two t-shirts, one nice shirt, jeans, gym shorts
- Running shoes (always)

## Trip-specific

- Tokyo: light layers, walking shoes — see [[Tokyo Trip]]
- Iceland: rain shell, gloves, base layers — see [[Iceland Ring Road]]
- Lisbon: linen everything — see [[Lisbon Notes]]

#travel #reference
`
  },
  {
    id: NOTE_IDS.travelSeoulFood,
    relativePath: 'travel/Seoul Food.md',
    title: 'Seoul Food',
    emoji: '🌶️',
    tags: ['travel/asia', 'travel/korea', 'food'],
    customProps: {
      location: 'Seoul, South Korea',
      startDate: seedJournalDate('2025-09-12'),
      endDate: seedJournalDate('2025-09-18'),
      status: 'done'
    },
    daysAgoCreated: -240,
    daysAgoModified: -200,
    body: `Best meals:

- **Mapo Galbi** — Mapo-gu. Ribs at 22:00, no English menu.
- **Café Onion** — yes it's instagrammed. Yes, the bread is still that good.
- **Tteokbokki street stalls** — the one in Myeongdong with the ahjumma in the orange apron.

#travel/asia #food
`
  },
  {
    id: NOTE_IDS.travelMexicoCityArt,
    relativePath: 'travel/Mexico City Art.md',
    title: 'Mexico City Art',
    emoji: '🎨',
    tags: ['travel/americas', 'travel/mexico', 'art'],
    customProps: {
      location: 'Mexico City',
      startDate: seedJournalDate('2025-06-04'),
      endDate: seedJournalDate('2025-06-10'),
      status: 'done'
    },
    daysAgoCreated: -340,
    daysAgoModified: -310,
    body: `Casa Estudio Luis Barragán was the trip. The water on the staircase. The pink wall. Architecture as quiet drama.

#travel/americas #art
`
  },
  {
    id: NOTE_IDS.travelOsakaRamen,
    relativePath: 'travel/Osaka Ramen.md',
    title: 'Osaka Ramen',
    emoji: '🍜',
    tags: ['travel/asia', 'travel/japan', 'food'],
    customProps: {
      location: 'Osaka, Japan',
      status: 'reference'
    },
    daysAgoCreated: -60,
    daysAgoModified: -19,
    body: `## Spots that earned a return

- **Kamukura** — light shoyu, weirdly veggie-forward. Tokyo branch shows up in [[Tokyo Trip]].
- **Ichiran** — yeah it's a chain. The booths still rule for jet-lagged solo eating.
- **Ramen Yashichi** — taiwanese-style. Spicy.

#travel/asia #food
`
  },
  {
    id: NOTE_IDS.travelTokyoCafes,
    relativePath: 'travel/Tokyo Cafes.md',
    title: 'Tokyo Cafes',
    emoji: '☕',
    tags: ['travel/asia', 'travel/japan', 'coffee'],
    customProps: {
      location: 'Tokyo, Japan',
      status: 'reference'
    },
    daysAgoCreated: -50,
    daysAgoModified: -19,
    body: `Working list. Tokyo coffee is *peculiar* — slow, careful, Sunday-mass quiet.

| Cafe | Neighborhood | What to order |
|------|--------------|---------------|
| Glitch Coffee | Jimbocho | Filter, single origin |
| Onibus Coffee | Nakameguro | Espresso outside |
| Fuglen | Shibuya | Norwegian-Japanese fusion vibe |
| % Arabica | Various | Insta but yes, the latte |
| Bear Pond | Shimokitazawa | Closes at noon — show up |

Pair with [[Kitchen Confidential]] for the *travel-as-eating* mindset.

#travel/asia #coffee
`
  },
  {
    id: NOTE_IDS.travelAirportLounges,
    relativePath: 'travel/Airport Lounges.md',
    title: 'Airport Lounges',
    emoji: '🛫',
    tags: ['travel', 'logistics'],
    customProps: { status: 'reference' },
    daysAgoCreated: -300,
    daysAgoModified: -19,
    body: `## Worth a visit

- Cathay Pacific The Pier — HKG. The cabanas are real.
- ANA Suite — HND. The dining room.

## Skip

- Most "premier" Priority Pass options. Fine, not great.

#travel #logistics
`
  },
  {
    id: NOTE_IDS.travelRomeWeekend,
    relativePath: 'travel/Weekend in Rome.md',
    title: 'Weekend in Rome',
    emoji: '🏛️',
    tags: ['travel/europe', 'food', 'city-break', 'favorites'],
    aliases: ['Rome trip', 'Rome city break'],
    customProps: {
      location: 'Rome, Italy',
      startDate: seedJournalDate('2026-09-18'),
      endDate: seedJournalDate('2026-09-20'),
      status: 'planning'
    },
    daysAgoCreated: -2,
    daysAgoModified: 0,
    body: `Three slow days — old streets in the morning, long lunches, golden-hour walks. The trip where we finally don't over-plan.

> [!tip] One neighborhood a day
> Pick an anchor sight, then wander the rest on foot. Rome is best with frequent coffee stops.

## Trip snapshot

| Day | Morning | Afternoon | Evening |
|----------|---------|-----------|---------|
| Friday | Land, drop bags in Trastevere | Wander the lanes + first gelato | Dinner on a piazza |
| Saturday | Colosseum & Forum (go early) | Pantheon → Trevi Fountain | Sunset from Gianicolo hill |
| Sunday | Vatican Museums (book ahead) | Long lunch, slow espresso | Fly home |

## Must-eat

- **Cacio e pepe** — the whole reason we're here
- Supplì from a street counter
- A maritozzo for breakfast
- Gelato, twice a day (rules don't apply on holiday)

## Before we go

- [x] Book Vatican tickets — skip-the-line
- [x] Download an offline map of the center
- [ ] Break in the comfortable shoes — see [[Packing List]]
- [ ] Learn five words of Italian
- [ ] Save the hotel address for offline

## Links

- Journal: [[${seedJournalDate('2026-05-15')}]]
- Packing: [[Packing List]]
- Food notes: [[Food Diary]]

#travel/europe #food #city-break
`
  },

  // ============================================================================
  // ADDED — a fuller vault: the working notes a real person accumulates around
  // the projects above.
  // ============================================================================
  {
    id: NOTE_IDS.projBetaFeedback,
    relativePath: 'projects/Beta Feedback.md',
    title: 'Beta Feedback',
    emoji: '🗣️',
    tags: ['projects/memry', 'launch', 'reference'],
    customProps: { status: 'active', priority: 'high', owner: 'me' },
    daysAgoCreated: -14,
    daysAgoModified: 0,
    body: `Everything the first twelve testers said, in their words, sorted by how often it came up.

> [!important] The rule
> A quote goes in verbatim. My interpretation goes in the right-hand column, clearly marked as mine.

## Themes

| Theme | Said by | What they actually want | Status |
|-------|---------|-------------------------|--------|
| "Where did my note go?" | 7 | Recently-edited, always visible | shipped |
| Sync anxiety | 5 | A visible last-synced timestamp | in progress |
| Too many empty states | 4 | Sensible starting content | planning |
| Mobile, please | 9 | Read-only is enough for now | backlog |
| Keyboard-only flow | 3 | Command palette for everything | planning |

## Quotes worth keeping

> "I trusted it the moment I saw the files sitting in a normal folder."

> "The encryption thing matters to me but I don't want to *think* about it."

> "I closed the laptop mid-sentence and it was still there. That's the whole pitch."

## What I am not doing

- Not adding a web clipper this cycle — see [[memrynote Roadmap]]
- Not chasing the one request for a Kanban board
- Not rewriting the graph view because two people found it slow; the graph gets pagination instead

## Next

- [ ] Turn the top three themes into issues
- [x] Reply to everyone individually
- [ ] Second round of invites after the sync timestamp lands

#projects/memry #launch
`
  },
  {
    id: NOTE_IDS.projNewsletterIdeas,
    relativePath: 'projects/Newsletter Ideas.md',
    title: 'Newsletter Ideas',
    emoji: '✉️',
    tags: ['writing', 'ideas', 'gtm'],
    customProps: { status: 'idea', priority: 'low' },
    daysAgoCreated: -21,
    daysAgoModified: -3,
    body: `A holding pen. Nothing here is committed to; most of it will never be written.

## Drafts in the drawer

1. **"Your notes should outlive your app."** — the local-first argument without the jargon
2. **"I read 24 books and remembered four."** — retention, not consumption; pairs with [[On Reading]]
3. **"What a cut taught me about shipping."** — the [[2026 Cut]] as a delivery metaphor, if I can keep it from being insufferable
4. **"Twelve testers, one week."** — the honest version of [[Beta Feedback]]

## Format I keep coming back to

- One idea, 800 words, no roundups
- Every issue ends with a single thing to try
- Ship on a schedule I can hold in a bad week, not a good one

## Open question

Do I want an audience, or do I want an excuse to write? Answering that honestly changes the whole thing.

#writing #ideas
`
  },
  {
    id: NOTE_IDS.techVitestPatterns,
    relativePath: 'tech/Vitest Patterns.md',
    title: 'Vitest Patterns',
    emoji: '🧪',
    tags: ['tech/typescript', 'tests', 'reference'],
    customProps: { status: 'reference' },
    daysAgoCreated: -47,
    daysAgoModified: -6,
    body: `The handful of things I re-look-up every time.

## Mock a module, keep one real export

\`\`\`ts
vi.mock('./logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logger')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
\`\`\`

## Fake timers without deadlocking async code

\`\`\`ts
vi.useFakeTimers({ shouldAdvanceTime: true })
await vi.advanceTimersByTimeAsync(1_000)
\`\`\`

## Rules I learned the hard way

| Rule | Why |
|------|-----|
| Reset module state in \`beforeEach\` | Singletons leak between files, not just tests |
| Never assert on a snapshot you did not read | It will happily record a bug |
| One behavior per test name | A failing name should tell you the bug |
| Prefer a real object over a mock | A mock only proves the mock works |

> [!warning] Partial mocks are a trap
> Mock a module partially and every *new* export silently becomes \`undefined\` for that file. Prefer building a real fixture.

See also: [[TypeScript Patterns]], [[Electron Gotchas]].

#tech/typescript #tests
`
  },
  {
    id: NOTE_IDS.techKeyboardShortcuts,
    relativePath: 'tech/Keyboard Shortcuts.md',
    title: 'Keyboard Shortcuts',
    emoji: '⌨️',
    tags: ['tech/editor', 'tooling', 'reference'],
    customProps: { status: 'reference' },
    daysAgoCreated: -60,
    daysAgoModified: -11,
    body: `The ones I actually use, not the ones I keep meaning to learn.

## Editor

| Keys | Does |
|------|------|
| \`⌘K\` | Command palette — the only one that matters |
| \`⌘P\` | Jump to a note by name |
| \`⌘⇧F\` | Search the whole vault |
| \`⌘[\` / \`⌘]\` | Back and forward through what I opened |
| \`⌘\\\` | Split the editor |

## Terminal

| Keys | Does |
|------|------|
| \`⌃R\` | Reverse search — still the best shortcut ever shipped |
| \`⌃A\` / \`⌃E\` | Start and end of line |
| \`⌥←\` / \`⌥→\` | Move by word |

## Still not automatic

- Multi-cursor by pattern
- Anything involving marks in vim — see [[Vim Motions]]

#tech/editor #tooling
`
  },
  {
    id: NOTE_IDS.lifeWeeklyReview,
    relativePath: 'life/Weekly Review.md',
    title: 'Weekly Review',
    emoji: '🔁',
    tags: ['reflection', 'habits', 'recurring'],
    customProps: { status: 'active' },
    daysAgoCreated: -110,
    daysAgoModified: -2,
    body: `Sunday evening, twenty minutes, same four questions. The consistency is the whole feature.

## The questions

1. **What actually moved?** Not what I was busy with — what moved.
2. **What did I avoid, and why?** The why is where the information is.
3. **What am I carrying that I can put down?**
4. **What is the one thing next week is *for*?**

## The pass

- [ ] Empty the inbox to zero
- [ ] Reschedule anything that slipped twice — twice means it is not real
- [ ] Skim this week's journal entries
- [ ] Write the one-thing sentence at the top of Monday

> [!note] The failure mode
> When this becomes a status report to myself, it stops working. Keep it a conversation.

## Feeds into

- [[Year in Review 2025]] at the end of the year
- [[Morning Routine]] the next day

#reflection #habits
`
  },
  {
    id: NOTE_IDS.lifePeopleILearnFrom,
    relativePath: 'life/People I Learn From.md',
    title: 'People I Learn From',
    emoji: '👥',
    tags: ['people', 'learning', 'reference'],
    customProps: { status: 'active' },
    daysAgoCreated: -160,
    daysAgoModified: -19,
    body: `Not a network. A short list of people whose thinking changes mine, and what specifically I take from each.

| Who | What I take | Where |
|-----|-------------|-------|
| M. | Says the uncomfortable thing first, kindly | Weekly coffee |
| D. | Refuses to be impressed by complexity | Work |
| My brother | Long-horizon patience about money | Sunday calls |
| A former manager | Asks "and then what?" three times | Occasional email |

## What I am borrowing this year

- **From M.** — name the actual objection instead of hedging around it
- **From D.** — "can you draw it?" as a bullshit detector
- **From the internet, carefully** — read the people who show their work, ignore the ones who show their results

> "You are the average of the five people you spend the most time with" is too neat, but the direction is right.

See also: [[Relationships]], [[My Why]].

#people #learning
`
  },
  {
    id: NOTE_IDS.weightSleepLog,
    relativePath: 'weight/Sleep Log.md',
    title: 'Sleep Log',
    emoji: '😴',
    tags: ['fitness', 'health', 'tracking', 'log'],
    customProps: { status: 'active' },
    daysAgoCreated: -30,
    daysAgoModified: 0,
    body: `Tracking sleep because [[Cutting Log]] made it obvious that the bad weeks were the short-sleep weeks.

## Last two weeks

| Night | Hours | Woke up | Note |
|-------|-------|---------|------|
| Mon | 7.4 | once | Normal |
| Tue | 6.1 | twice | Late screen, obviously |
| Wed | 8.0 | no | Best lift of the week followed |
| Thu | 7.2 | once | — |
| Fri | 6.4 | once | Dinner ran late |
| Sat | 8.3 | no | No alarm |
| Sun | 7.6 | no | Back on schedule |

## What correlates

- **Under 7 hours** → weigh-in stalls and the squat feels heavy
- **Screens after 22:30** → 40 minutes longer to fall asleep, every time
- Caffeine after 14:00 is not the problem I assumed it was

## Rules that stuck

- [x] Phone charges outside the bedroom
- [x] Same wake time on weekends, within an hour
- [ ] Actually go to bed when the light goes on — still 0 for 12

#fitness #health #tracking
`
  },
  {
    id: NOTE_IDS.bookShoeDog,
    relativePath: 'books/Shoe Dog.md',
    title: 'Shoe Dog',
    emoji: '👟',
    tags: ['nonfiction', 'memoir', 'favorites'],
    customProps: {
      author: 'Phil Knight',
      year: 2016,
      pages: 400,
      status: 'done',
      rating: 5,
      genre: 'memoir'
    },
    daysAgoCreated: -75,
    daysAgoModified: -30,
    body: `The most honest founder memoir I have read, mostly because it is written by someone with nothing left to prove.

## What stayed with me

- **It was nearly over, constantly.** For a decade. The version told in retrospect always flattens that.
- **The bank was the antagonist**, not the competitor. Cash flow is the plot.
- He never sounds like he enjoyed it, and he never suggests he would trade it.

> "Don't tell people how to do things, tell them what to do and let them surprise you with their results."

## Where it argues with [[The Almanack of Naval Ravikant]]

Naval's version is leverage and calm. Knight's is grinding and terror. Both are true; the second one is less quotable, which is exactly why it is worth reading.

## Pair with

- [[On Writing]] — same trick, a craft memoir that refuses to be inspirational
- [[Four Thousand Weeks]] — for the counter-argument

#books/nonfiction #memoir
`
  },
  {
    id: NOTE_IDS.movieTheBear,
    relativePath: 'movies/The Bear.md',
    title: 'The Bear',
    emoji: '🔪',
    tags: ['movies', 'movies/drama', 'craft', 'favorites'],
    customProps: {
      director: 'Christopher Storer',
      year: 2022,
      status: 'watched',
      rating: 5,
      genre: 'drama'
    },
    daysAgoCreated: -55,
    daysAgoModified: -12,
    body: `Not a film, but it lives here anyway.

## Why it works

- The kitchen is loud and the show is *quiet* about what it means. It trusts you.
- Every episode is about a system failing under load. I recognize the feeling professionally.
- The one-take episode is the flex everyone talks about; the still one after it is the better hour.

## The line I keep

> "Every second counts."

Used as encouragement in season one and as a threat by season two, which is the whole thesis.

## Pair with

- [[Kitchen Confidential]] — the nonfiction source of this energy
- [[Goodfellas]] — for the same chaos filmed as pleasure instead of pressure

#movies #craft
`
  },
  {
    id: NOTE_IDS.travelLisbonFoodMap,
    relativePath: 'travel/Lisbon Food Map.md',
    title: 'Lisbon Food Map',
    emoji: '🥐',
    tags: ['travel/europe', 'travel/portugal', 'food', 'city-break'],
    customProps: {
      status: 'planning',
      location: 'Lisbon, Portugal',
      startDate: seedJournalDate('2026-05-23'),
      endDate: seedJournalDate('2026-05-25')
    },
    daysAgoCreated: -9,
    daysAgoModified: 0,
    body: `Companion to [[Lisbon Notes]] — this one is only food, ordered by neighborhood so it works while walking.

> [!tip] Two rules
> One planned meal a day, maximum. The rest is whatever is open and full of locals.

## Alfama

| Place | What | When |
|-------|------|------|
| A corner tasca, no sign | Grilled sardines | Lunch, early |
| Pastelaria near the cathedral | Pastel de nata, still warm | Any time |

## Príncipe Real

| Place | What | When |
|-------|------|------|
| The natural wine bar | Petiscos, standing up | Before dinner |
| Bakery on the square | Sourdough, take it to the park | Morning |

## Cais do Sodré

- Seafood, late, loud
- The market hall for the one meal where we cannot agree

## Non-negotiable

- [ ] Bifana from a counter, eaten standing
- [ ] Ginjinha in a chocolate cup, once, ironically, then again sincerely
- [ ] Coffee at least four times a day — it is 80 cents, this is the whole reason to be here

## Links

- Trip: [[Lisbon Notes]]
- Journal: [[${seedJournalDate('2026-05-15')}]]
- Running list: [[Food Diary]]

#travel/europe #food #city-break
`
  }
]

/**
 * Project membership, by project name.
 *
 * `project` is the reserved frontmatter key the note-project-links projector
 * reads to derive `project_links` rows, so this — not the pre-seeded rows in
 * ./project-links — is what survives the note's next index pass. A project's own
 * overview note is deliberately absent: Project Home already renders it at the
 * top and would otherwise list it twice.
 */
const NOTE_PROJECTS: Record<string, string[]> = {
  [NOTE_IDS.projMemryRoadmap]: ['memrynote Launch'],
  [NOTE_IDS.projMemryArchitecture]: ['memrynote Launch'],
  [NOTE_IDS.projMemryGTM]: ['memrynote Launch'],
  [NOTE_IDS.techCRDTArchitecture]: ['memrynote Launch'],
  [NOTE_IDS.techElectronGotchas]: ['memrynote Launch'],
  [NOTE_IDS.techSqliteVec]: ['memrynote Launch'],
  [NOTE_IDS.projMemryMobile]: ['memrynote Launch'],
  [NOTE_IDS.projConferenceTalk]: ['memrynote Launch', 'Side Projects'],

  [NOTE_IDS.travelPackingList]: ['Istanbul Weekend', 'Travel: Tokyo'],
  [NOTE_IDS.travelAirportLounges]: ['Istanbul Weekend'],

  [NOTE_IDS.bookDune]: ['Reading'],
  [NOTE_IDS.bookProjectHailMary]: ['Reading'],
  [NOTE_IDS.bookFourThousandWeeks]: ['Reading'],
  [NOTE_IDS.bookAtomicHabits]: ['Reading'],
  [NOTE_IDS.bookOnWriting]: ['Reading'],
  [NOTE_IDS.bookSapiens]: ['Reading'],
  [NOTE_IDS.bookManSearchMeaning]: ['Reading'],

  [NOTE_IDS.weightTrainingSplit]: ['Fitness 2026'],
  [NOTE_IDS.weightCardioPlan]: ['Fitness 2026'],
  [NOTE_IDS.weightProteinTargets]: ['Fitness 2026'],
  [NOTE_IDS.weightSundayWeighIn]: ['Fitness 2026'],
  [NOTE_IDS.weightCuttingLog]: ['Fitness 2026'],
  [NOTE_IDS.weightFoodDiary]: ['Fitness 2026'],

  [NOTE_IDS.travelKyotoDayTrip]: ['Travel: Tokyo'],
  [NOTE_IDS.travelOsakaRamen]: ['Travel: Tokyo'],
  [NOTE_IDS.travelTokyoCafes]: ['Travel: Tokyo'],

  [NOTE_IDS.projBlogRedesign]: ['Side Projects'],
  [NOTE_IDS.projOpenSourceFork]: ['Side Projects'],
  [NOTE_IDS.techRustNotes]: ['Side Projects'],
  [NOTE_IDS.projGardenSchedule]: ['Side Projects'],
  [NOTE_IDS.projHomeRenovation]: ['Side Projects'],

  [NOTE_IDS.projBetaFeedback]: ['memrynote Launch'],
  [NOTE_IDS.projNewsletterIdeas]: ['Side Projects'],
  [NOTE_IDS.techVitestPatterns]: ['memrynote Launch'],
  [NOTE_IDS.weightSleepLog]: ['Fitness 2026'],
  [NOTE_IDS.bookShoeDog]: ['Reading']
}

/**
 * Folder-wide `area` so every note carries at least one select property — the
 * options come from `.memry/properties.md`, so these render as colored chips
 * rather than inferred text.
 */
const FOLDER_AREAS: Record<string, string> = {
  books: 'Learning',
  movies: 'Learning',
  weight: 'Health',
  life: 'Learning',
  projects: 'Work',
  tech: 'Learning',
  travel: 'Travel'
}

/**
 * Per-note extras layered on top of `customProps`: the multi-value and
 * relation-ish properties that make the info panel look like a vault someone
 * actually keeps, without editing 74 literals by hand.
 */
const EXTRA_PROPS: Record<string, Record<string, unknown>> = {
  [NOTE_IDS.bookDune]: { format: ['Hardcover', 'Audiobook'], source: ['Rewatch'], shared: false },
  [NOTE_IDS.bookProjectHailMary]: { format: ['Kindle'], source: ['Recommended'] },
  [NOTE_IDS.bookAtomicHabits]: { format: ['Kindle'], source: ['Recommended'] },
  [NOTE_IDS.bookDeepWork]: { format: ['Hardcover'], source: ['Bookclub'] },
  [NOTE_IDS.bookSapiens]: { format: ['Audiobook'], source: ['Bookclub'] },
  [NOTE_IDS.bookFourThousandWeeks]: { format: ['Kindle'], source: ['Recommended'] },
  [NOTE_IDS.bookManSearchMeaning]: { format: ['Hardcover'], source: ['Rewatch'] },
  [NOTE_IDS.bookOnWriting]: { format: ['Kindle'], source: ['Backlog'] },
  [NOTE_IDS.bookTheMartian]: { format: ['Kindle'], source: ['Backlog'] },

  [NOTE_IDS.movieDune2021]: { format: ['Cinema'], source: ['Rewatch'] },
  [NOTE_IDS.movieInterstellar]: { format: ['Streaming'], source: ['Rewatch'] },
  [NOTE_IDS.movieParasite]: { format: ['Streaming'], source: ['Recommended'] },
  [NOTE_IDS.movieSpiritedAway]: { format: ['Streaming'], source: ['Rewatch'] },
  [NOTE_IDS.movieWatchlist2026]: { source: ['Backlog'], reviewOn: seedJournalDate('2026-05-24') },

  [NOTE_IDS.techTypescriptPatterns]: { language: 'typescript', level: 'advanced' },
  [NOTE_IDS.techRustNotes]: { language: 'rust', level: 'beginner' },
  [NOTE_IDS.techPostgresIndexing]: { language: 'sql', level: 'intermediate' },
  [NOTE_IDS.techSqliteVec]: { language: 'sql', level: 'advanced' },
  [NOTE_IDS.techDrizzleORM]: { language: 'typescript', level: 'intermediate' },
  [NOTE_IDS.techDockerCheatsheet]: { language: 'shell', level: 'beginner' },
  [NOTE_IDS.techGitWorkflow]: { language: 'shell', level: 'intermediate' },
  [NOTE_IDS.techCMUDatabaseCourse]: {
    language: 'sql',
    level: 'advanced',
    url: 'https://15445.courses.cs.cmu.edu/'
  },

  [NOTE_IDS.projMemryLaunch]: {
    energy: 'deep',
    priority: 'high',
    reviewOn: seedJournalDate('2026-05-12'),
    shared: true
  },
  [NOTE_IDS.projMemryRoadmap]: { energy: 'deep', reviewOn: seedJournalDate('2026-05-12') },
  [NOTE_IDS.projMemryGTM]: { energy: 'shallow', shared: true },
  [NOTE_IDS.projMemryMobile]: {
    energy: 'deep',
    priority: 'high',
    reviewOn: seedJournalDate('2026-05-17'),
    shared: true
  },
  [NOTE_IDS.projConferenceTalk]: { energy: 'deep', priority: 'high' },
  [NOTE_IDS.projHomeRenovation]: { area: 'Home', energy: 'admin' },
  [NOTE_IDS.projGardenSchedule]: { area: 'Home', energy: 'shallow' },

  [NOTE_IDS.lifeFinances]: { area: 'Money', energy: 'admin' },
  [NOTE_IDS.lifeMorningRoutine]: { energy: 'shallow' },
  [NOTE_IDS.lifeYearReview2025]: { energy: 'deep', reviewOn: seedJournalDate('2026-05-31') },

  [NOTE_IDS.travelLisbonNotes]: { energy: 'shallow', shared: true },
  [NOTE_IDS.travelIstanbul]: { energy: 'shallow', shared: true },
  [NOTE_IDS.travelPackingList]: { energy: 'admin' },

  [NOTE_IDS.projBetaFeedback]: { energy: 'deep', shared: true },
  [NOTE_IDS.projNewsletterIdeas]: { energy: 'shallow' },
  [NOTE_IDS.techVitestPatterns]: { language: 'typescript', level: 'intermediate' },
  [NOTE_IDS.techKeyboardShortcuts]: { level: 'beginner' },
  [NOTE_IDS.lifeWeeklyReview]: { energy: 'shallow', reviewOn: seedJournalDate('2026-05-10') },
  [NOTE_IDS.bookShoeDog]: { format: ['Hardcover'], source: ['Recommended'] },
  [NOTE_IDS.movieTheBear]: { format: ['Streaming'], source: ['Recommended'] },
  [NOTE_IDS.travelLisbonFoodMap]: { energy: 'shallow', shared: true }
}

/** Canonical note_metadata rows so note ids stay stable across indexing. */
export const NOTE_METADATA = SPECS.map((spec) => ({
  id: spec.id,
  path: spec.relativePath,
  title: spec.title,
  emoji: spec.emoji ?? null,
  createdAt: dayOffset(spec.daysAgoCreated),
  modifiedAt: dayOffset(spec.daysAgoModified)
}))

export const NOTES: NoteFile[] = SPECS.map((spec) => {
  const modified = dayOffset(spec.daysAgoModified)
  return {
    relativePath: spec.relativePath,
    // User keys only — no Memry keys in files; dates land on the file via mtime
    frontmatter: {
      ...(spec.tags.length > 0 ? { tags: spec.tags } : {}),
      ...(spec.aliases ? { aliases: spec.aliases } : {}),
      ...(NOTE_PROJECTS[spec.id] ? { project: NOTE_PROJECTS[spec.id] } : {}),
      ...(FOLDER_AREAS[spec.relativePath.split('/')[0]]
        ? { area: FOLDER_AREAS[spec.relativePath.split('/')[0]] }
        : {}),
      ...(spec.customProps ?? {}),
      ...(EXTRA_PROPS[spec.id] ?? {})
    },
    body: spec.body,
    modified
  }
})
