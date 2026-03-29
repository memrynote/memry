export interface FolderDef {
  name: string
  icon: string
  properties: Record<string, { type: string; options?: (string | number)[] }>
}

export interface NoteDef {
  folder: string
  title: string
  emoji?: string
  tags: string[]
  aliases?: string[]
  properties: Record<string, unknown>
  body: string
}

export const FOLDERS: FolderDef[] = [
  {
    name: 'movies',
    icon: '🎬',
    properties: {
      rating: { type: 'select', options: [1, 2, 3, 4, 5] },
      status: { type: 'select', options: ['watched', 'want-to-watch', 'watching'] },
      genre: { type: 'text' }
    }
  },
  {
    name: 'books',
    icon: '📚',
    properties: {
      rating: { type: 'select', options: [1, 2, 3, 4, 5] },
      status: { type: 'select', options: ['reading', 'read', 'want-to-read'] },
      author: { type: 'text' }
    }
  },
  {
    name: 'places',
    icon: '📍',
    properties: {
      city: { type: 'text' },
      country: { type: 'text' },
      visited: { type: 'checkbox' }
    }
  },
  {
    name: 'projects',
    icon: '🚀',
    properties: {
      status: { type: 'select', options: ['active', 'paused', 'completed'] },
      stack: { type: 'text' }
    }
  },
  {
    name: 'recipes',
    icon: '🍳',
    properties: {
      cuisine: { type: 'text' },
      prepTime: { type: 'text' },
      difficulty: { type: 'select', options: ['easy', 'medium', 'hard'] }
    }
  },
  {
    name: 'travel',
    icon: '✈️',
    properties: {
      destination: { type: 'text' },
      dates: { type: 'text' },
      budget: { type: 'number' }
    }
  },
  {
    name: 'tech',
    icon: '💻',
    properties: {
      category: { type: 'select', options: ['language', 'tool', 'framework', 'concept'] },
      proficiency: { type: 'select', options: ['beginner', 'intermediate', 'advanced'] }
    }
  },
  {
    name: 'personal',
    icon: '📝',
    properties: {}
  }
]

export const NOTES: NoteDef[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // Movies
  // ═══════════════════════════════════════════════════════════════════════════
  {
    folder: 'movies',
    title: 'Interstellar',
    emoji: '🌌',
    tags: ['sci-fi', 'favorite', 'nolan'],
    aliases: ['Interstellar 2014'],
    properties: { rating: 5, status: 'watched', genre: 'sci-fi' },
    body: `## Why It Matters

Christopher Nolan turned a Kip Thorne whitepaper into one of the most **emotionally devastating** sci-fi films ever made. The docking scene alone is worth the ticket price.

## Themes

- Time dilation as a metaphor for **parental sacrifice**
- Humanity's stubborn refusal to go quietly
- The tension between survival instinct and collective good

## Favorite Scenes

1. Miller's planet — the ticking clock scoring every second
2. The docking sequence — Hans Zimmer's organ at full tilt
3. Cooper watching 23 years of messages

> "We used to look up at the sky and wonder at our place in the stars. Now we just look down and worry about our place in the dirt."

The soundtrack alone changed how I think about film scoring. See also [[Blade Runner 2049]] for another visually stunning sci-fi experience, and [[Designing Data-Intensive Applications]] for the real-world distributed systems that inspired some of the ship's computing.

#film-score #must-rewatch`
  },
  {
    folder: 'movies',
    title: 'Blade Runner 2049',
    emoji: '🤖',
    tags: ['sci-fi', 'cyberpunk', 'villeneuve'],
    properties: { rating: 5, status: 'watched', genre: 'sci-fi' },
    body: `## Overview

Denis Villeneuve did the impossible — made a worthy sequel to a film that didn't need one. Roger Deakins' cinematography is *absurd*. Every frame could hang in a gallery.

## Visual Language

The color grading tells the story before the dialogue does:

- **Orange wasteland** — Las Vegas, decay, the past
- **Cold blue/grey** — LA, control, the present
- **White sterility** — Wallace Corp, manufactured perfection

## What Makes It Work

K's arc is a masterclass in subverting the "chosen one" trope. He spends the entire film believing he's special, only to discover he's not — and *that's* what makes his final act meaningful.

The relationship with Joi raises questions that [[Yjs CRDT]] couldn't solve — what counts as "real" in a world of synthetic everything?

| Aspect | Rating |
|--------|--------|
| Cinematography | 10/10 |
| Score | 9/10 |
| Pacing | 8/10 |
| Story | 9/10 |

See [[Interstellar]] for another sci-fi film that earns its runtime. Also connects thematically with [[Rust Ownership]] — who truly "owns" a memory?

#visual-masterpiece #replicant`
  },
  {
    folder: 'movies',
    title: 'Parasite',
    emoji: '🪳',
    tags: ['thriller', 'bong-joon-ho', 'favorite'],
    properties: { rating: 5, status: 'watched', genre: 'thriller' },
    body: `## The Staircase Motif

Every vertical movement in this film is *deliberate*. The Kims climb up to the Park house; they descend into the basement. The rain flows downhill from the rich neighborhood to the semi-basement.

## Genre Shifts

What starts as a **dark comedy** pivots into horror without you noticing. The tonal shift at the birthday party is one of the best-executed genre transitions in modern cinema.

## Why the Ending Works

The son's plan to buy the house is simultaneously:
- Hopeful — he *believes* he can do it
- Devastating — we know he can't

> "You know what kind of plan never fails? No plan at all."

Connects to the economic themes in [[Sapiens]] — the invention of hierarchy. If you're planning a trip to Seoul, see [[Tokyo]] for another East Asian city worth exploring.

#class-divide #genre-bending`
  },
  {
    folder: 'movies',
    title: 'The Grand Budapest Hotel',
    emoji: '🏨',
    tags: ['comedy', 'wes-anderson', 'visual'],
    properties: { rating: 4, status: 'watched', genre: 'comedy-drama' },
    body: `## Anderson's Aspect Ratio Trick

Three time periods, three aspect ratios:

1. **1930s** — 1.37:1 Academy ratio (boxy, nostalgic)
2. **1960s** — 2.39:1 anamorphic widescreen
3. **1980s** — 1.85:1 standard widescreen

This isn't just style — it *tells you when you are* before a single word of dialogue.

## Production Design

The miniatures in this film are **handcrafted**, not CGI. The hotel exterior, the cable car, the monastery — all physical models shot on a soundstage. There's a warmth to practical effects that CG can't replicate.

## Gustave H.

Ralph Fiennes delivers every line like he's conducting an orchestra. Gustave is vain, snobbish, and entirely sincere in his devotion to a dying world of manners.

The layered storytelling reminds me of the narrative structure in [[The Remains of the Day]] — both are about people devoted to institutions that don't deserve their loyalty.

See [[Lisbon]] for a European city with architecture that feels like a Wes Anderson set.

#production-design #symmetry`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Books
  // ═══════════════════════════════════════════════════════════════════════════
  {
    folder: 'books',
    title: 'Sapiens',
    emoji: '🧬',
    tags: ['history', 'anthropology', 'non-fiction'],
    aliases: ['Sapiens: A Brief History of Humankind'],
    properties: { rating: 4, status: 'read', author: 'Yuval Noah Harari' },
    body: `## Core Argument

Harari's central thesis: *Homo sapiens* conquered the world because we can cooperate flexibly in large numbers, thanks to our ability to believe in **shared fictions** — money, nations, religions, corporations.

## Key Concepts

### The Cognitive Revolution (~70,000 years ago)
Language evolved beyond basic communication to include **gossip** and **fiction**. This let us coordinate in groups larger than ~150 (Dunbar's number).

### The Agricultural Revolution
Harari calls it "history's biggest fraud." Wheat domesticated *us*, not the other way around. Quality of life arguably declined for most people.

### The Scientific Revolution
The admission of ignorance. For the first time, humans said: "We don't know — let's find out."

> "How do you cause people to believe in an imagined order such as Christianity, democracy, or capitalism? First, you never admit that the order is imagined."

## Criticisms

- Oversimplifies complex historical processes
- Cherry-picks evidence to fit narrative
- The "shared fictions" framework is powerful but not original (see Searle's social ontology)

Connects well with the systems thinking in [[Designing Data-Intensive Applications]] and the economic dynamics explored in [[Parasite]].

#big-history #must-read`
  },
  {
    folder: 'books',
    title: 'Designing Data-Intensive Applications',
    emoji: '📊',
    tags: ['engineering', 'distributed-systems', 'reference'],
    aliases: ['DDIA', 'Kleppmann'],
    properties: { rating: 5, status: 'read', author: 'Martin Kleppmann' },
    body: `## Why Every Engineer Should Read This

DDIA doesn't teach you a specific technology — it teaches you **how to think about data systems**. After reading it, you'll never look at a database the same way.

## Structure

### Part I: Foundations of Data Systems
- Reliability, Scalability, Maintainability
- Data models: relational vs document vs graph
- Storage engines: B-trees vs LSM-trees

### Part II: Distributed Data
- Replication (single-leader, multi-leader, leaderless)
- Partitioning strategies
- Transactions and consensus

### Part III: Derived Data
- Batch processing (MapReduce, Spark)
- Stream processing (Kafka, Flink)
- The future of data systems

## Key Takeaways

\`\`\`
Correctness > Performance > Features
\`\`\`

The chapter on **CRDTs and conflict resolution** directly influenced my understanding of [[Yjs CRDT]]. The replication chapter maps perfectly to the sync architecture in [[memry]].

| Chapter | Topic | Re-read? |
|---------|-------|----------|
| 5 | Replication | Yes, annually |
| 7 | Transactions | When debugging |
| 9 | Consistency | Before system design |
| 11 | Stream Processing | For event-driven work |

Also see [[SQLite WAL Mode]] for a concrete implementation of the write-ahead logging concepts discussed in Chapter 3.

#distributed-systems #bible`
  },
  {
    folder: 'books',
    title: 'The Remains of the Day',
    emoji: '🫖',
    tags: ['fiction', 'literary', 'ishiguro'],
    properties: { rating: 5, status: 'read', author: 'Kazuo Ishiguro' },
    body: `## The Unreliable Butler

Stevens narrates his life with the same meticulous care he brings to silver polishing — and it's precisely this care that reveals everything he can't say directly.

## What the Book Is Really About

On the surface: a butler drives across England.
Underneath: a man realizes he **wasted his life** serving someone who didn't deserve it, and suppressed the one relationship that could have saved him.

> "Indeed — why should I not admit it? — at that moment, my heart was breaking."

The single most devastating line in English literature, delivered with characteristic Ishiguro restraint.

## The Dignity Question

Stevens' entire philosophy rests on "dignity" — the ability to inhabit one's role completely. But Ishiguro shows us that this "dignity" is actually **emotional cowardice** dressed up as professionalism.

## Parallels

The devotion to a crumbling institution echoes [[The Grand Budapest Hotel]] — Gustave H. and Stevens would understand each other perfectly. The theme of looking backward connects to the nostalgia in [[Japan 2025]].

#unreliable-narrator #quiet-devastation`
  },
  {
    folder: 'books',
    title: 'Project Hail Mary',
    emoji: '🚀',
    tags: ['sci-fi', 'fiction', 'weir'],
    properties: { rating: 4, status: 'read', author: 'Andy Weir' },
    body: `## The Best Buddy Comedy in Space

What starts as a solo survival story becomes an unlikely friendship between a human and an alien who communicates through musical tones. Rocky is one of the best fictional characters in years.

## Hard Science Done Right

Weir's background in physics shows:

- **Astrophage**: a microorganism that eats stellar energy — scientifically plausible enough to suspend disbelief
- **Orbital mechanics**: every maneuver follows real physics
- **The Petrova line**: extinction-level threat grounded in actual stellar dimming models

## Memory Structure

The dual timeline (present mission + recovered memories) keeps the pacing tight. You learn *why* Ryland is there at exactly the same rate he does.

\`\`\`python
# Rocky's temperature conversion
def eridian_to_celsius(temp_e):
    return (temp_e - 200) * 0.6  # approximate
\`\`\`

Thematically pairs well with [[Interstellar]] — both are about scientists making impossible choices to save humanity. The engineering mindset reminds me of the pragmatism in [[Home Lab Setup]].

> "I penetrated the outer hull of an alien ship with a rock. I am the worst astronaut ever."

#found-family #hard-sci-fi`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Places
  // ═══════════════════════════════════════════════════════════════════════════
  {
    folder: 'places',
    title: 'Tokyo',
    emoji: '🗼',
    tags: ['japan', 'city', 'food'],
    properties: { city: 'Tokyo', country: 'Japan', visited: true },
    body: `## Neighborhoods Worth Exploring

### Shimokitazawa
The anti-Shibuya. Narrow streets, vintage shops, tiny live-music venues. Best for a slow afternoon with no agenda.

### Yanaka
Old Tokyo — survived the war and the bubble. Temple cats, wooden houses, and the best *kakigori* (shaved ice) in the city.

### Akihabara
Sensory overload in the best way. Six floors of retro games, maid cafes, and electronic components you didn't know you needed.

## Food Highlights

- **Tsukiji Outer Market** — tamagoyaki (rolled omelette) at Shoei, seared tuna on a stick
- **Fuunji (Shinjuku)** — tsukemen with pork broth thick enough to stand a spoon in
- **Afuri** — yuzu shio ramen, refreshingly light

## Transit Tips

Get a **Suica/Pasmo** card on arrival. Works on all trains, buses, and most vending machines. Avoid rush hour (7:30–9:30 AM) on the Chuo line unless you enjoy being compressed.

![Tokyo Tower at dusk](https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=800)

Detailed trip planning in [[Japan 2025]]. For another vibrant city experience, compare with [[Istanbul]]. The food scene rivals what you can cook at home with [[Homemade Ramen]].

#transit #street-food #neon`
  },
  {
    folder: 'places',
    title: 'Istanbul',
    emoji: '🕌',
    tags: ['turkey', 'city', 'history'],
    properties: { city: 'Istanbul', country: 'Turkey', visited: true },
    body: `## A City on Two Continents

Istanbul is the only city that straddles Europe and Asia. The Bosphorus is not just geography — it's the city's central character. Every ferry ride is a meditation.

## Must-Visit

### Hagia Sophia
1,500 years old. Cathedral, mosque, museum, mosque again. The sheer *scale* of the dome silences everyone who walks in.

### Grand Bazaar
4,000+ shops. Get lost on purpose. The **jewelry corridors** in the center are the oldest; the leather and textile sections sprawl outward.

### Karakoy & Galata
The creative district. Specialty coffee, contemporary galleries, and the Galata Tower view at sunset.

## Food

| Dish | Where | Price |
|------|-------|-------|
| Lahmacun | Halil Lahmacun, Fatih | ~40 TL |
| Balik ekmek | Eminonu fish boats | ~80 TL |
| Kunefe | Hafiz Mustafa | ~120 TL |
| Breakfast spread | Van Kahvalti Evi | ~200 TL |

> Turkish breakfast isn't a meal — it's an *event*. Expect 15+ small plates, unlimited cay, and at least 90 minutes.

The historical layers remind me of the themes in [[Sapiens]] — every empire left its mark here. For a contrasting European city, see [[Lisbon]]. The spice markets will inspire your [[Shakshuka]].

#bosphorus #tea-culture #history`
  },
  {
    folder: 'places',
    title: 'Lisbon',
    emoji: '🚋',
    tags: ['portugal', 'city', 'europe'],
    properties: { city: 'Lisbon', country: 'Portugal', visited: false },
    body: `## Why Lisbon Is on My List

Everyone who visits says the same thing: "I didn't expect to love it *this much*." The light, the tiles, the hills, the pasteis de nata — it's a city that rewards aimless wandering.

## Neighborhoods to Explore

- **Alfama** — oldest district, Fado music drifting from tiny bars, labyrinthine streets
- **Belem** — Jeronimos Monastery, the Tower, and the original Pasteis de Belem
- **LX Factory** — converted industrial complex with bookshops, restaurants, and weekend markets
- **Principe Real** — leafy, chill, great brunch spots

## Architecture

The **azulejo tiles** are everywhere — not just decoration but a functional response to heat and humidity. Entire building facades become works of art.

The visual richness connects to [[The Grand Budapest Hotel]] — Wes Anderson would lose his mind here. Full trip plan in [[Portugal Road Trip]].

## Planning Notes

- Best time: **April–June** or **September–October**
- Budget: moderate for Western Europe (~€80/day comfortable)
- Must-do: take Tram 28 at least once, but walk the route too

#azulejos #hills #pasteis-de-nata`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Projects
  // ═══════════════════════════════════════════════════════════════════════════
  {
    folder: 'projects',
    title: 'memry',
    emoji: '🧠',
    tags: ['electron', 'typescript', 'personal-project'],
    properties: { status: 'active', stack: 'Electron, TypeScript, SQLite, Yjs' },
    body: `## What It Is

A local-first note-taking and task management app. Notes live as markdown files on disk; tasks live in SQLite. Everything syncs end-to-end encrypted via a Cloudflare Workers backend.

## Architecture

### Local Stack
- **Electron** — desktop shell
- **SQLite** (better-sqlite3) — tasks, projects, inbox
- **Markdown + gray-matter** — notes on filesystem
- **Yjs** — CRDT for real-time collaborative editing

### Sync Stack
- **Cloudflare Workers** — API
- **D1** — metadata store
- **R2** — encrypted blob storage
- **XChaCha20-Poly1305** — E2E encryption

## Current Focus

Field-level merge for tasks (per-field vector clocks). See [[Yjs CRDT]] for the CRDT architecture and [[SQLite WAL Mode]] for why WAL matters for concurrent access.

\`\`\`typescript
type FieldClocks = Record<string, VectorClock>
\`\`\`

The distributed systems concepts come directly from [[Designing Data-Intensive Applications]].

#local-first #e2e-encrypted #crdt`
  },
  {
    folder: 'projects',
    title: 'Home Lab Setup',
    emoji: '🖥️',
    tags: ['homelab', 'self-hosted', 'linux'],
    properties: { status: 'active', stack: 'Proxmox, Docker, Tailscale' },
    body: `## Hardware

- **Dell OptiPlex 7060 Micro** — i7-8700T, 32GB RAM, 1TB NVMe
- **Synology DS920+** — 4×4TB in SHR (Synology Hybrid RAID)
- **Ubiquiti Dream Machine Pro** — router + firewall + IDS

## Services Running

\`\`\`yaml
services:
  - name: Immich
    purpose: Photo backup (Google Photos replacement)
    port: 2283
  - name: Jellyfin
    purpose: Media streaming
    port: 8096
  - name: Vaultwarden
    purpose: Password manager
    port: 8080
  - name: Uptime Kuma
    purpose: Service monitoring
    port: 3001
  - name: Gitea
    purpose: Git hosting
    port: 3000
\`\`\`

## Networking

Everything connected via **Tailscale** mesh VPN. No ports exposed to the internet. Access from anywhere without port forwarding or dynamic DNS.

See [[Docker Compose Cheatsheet]] for the compose patterns I use. The backup strategy was influenced by the reliability principles in [[Designing Data-Intensive Applications]]. Reminds me of the engineering pragmatism in [[Project Hail Mary]] — build with what you have.

#self-hosted #proxmox #tailscale`
  },
  {
    folder: 'projects',
    title: 'Photography Portfolio',
    emoji: '📷',
    tags: ['photography', 'web', 'creative'],
    properties: { status: 'paused', stack: 'Astro, Cloudflare Pages' },
    body: `## Concept

Minimal portfolio site for street and travel photography. No JavaScript needed on the client — static HTML with responsive images.

## Design Principles

- **Let photos breathe** — generous whitespace, no UI chrome competing with images
- **Fast loads** — AVIF/WebP with fallbacks, lazy loading, no JS framework overhead
- **Simple navigation** — series-based, not chronological

## Technical Stack

\`\`\`
Astro (static site generator)
  └── Sharp (image processing at build time)
      └── Cloudflare Pages (hosting + CDN)
          └── R2 (original file storage)
\`\`\`

## Series Ideas

1. **Commuters** — daily rituals on public transit in [[Tokyo]] and [[Istanbul]]
2. **Signage** — neon, hand-painted, and decaying signs across cities
3. **Market mornings** — the hour before a market opens

The visual storytelling connects to [[Blade Runner 2049]] — Deakins' approach to color grading influenced how I think about editing.

#static-site #minimalism`
  },
  {
    folder: 'projects',
    title: 'Recipe App',
    emoji: '🥘',
    tags: ['mobile', 'react-native', 'cooking'],
    properties: { status: 'paused', stack: 'React Native, Expo, SQLite' },
    body: `## Problem

Every recipe app is either:
- **Bloated** — 2000-word life stories before the recipe
- **Social** — I don't need a feed, I need a timer

## Solution

A personal recipe manager that's **offline-first** and respects your time.

## Core Features

- Import from URL (strip the blog post, keep the recipe)
- Step-by-step cook mode with built-in timers
- Ingredient scaling (serves 2 → serves 6)
- Grocery list generation

## Data Model

\`\`\`typescript
interface Recipe {
  id: string
  title: string
  cuisine: string
  prepTime: number
  cookTime: number
  servings: number
  ingredients: Ingredient[]
  steps: Step[]
  tags: string[]
  sourceUrl?: string
}
\`\`\`

Would store recipes from [[Shakshuka]], [[Homemade Ramen]], [[Sourdough Bread]], and [[Thai Green Curry]]. The local-first approach is borrowed from [[memry]].

#offline-first #cooking #mobile`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Recipes
  // ═══════════════════════════════════════════════════════════════════════════
  {
    folder: 'recipes',
    title: 'Shakshuka',
    emoji: '🍳',
    tags: ['breakfast', 'middle-eastern', 'one-pot'],
    properties: { cuisine: 'Middle Eastern', prepTime: '10 min', difficulty: 'easy' },
    body: `## Ingredients

| Ingredient | Amount |
|------------|--------|
| Canned whole tomatoes | 1 can (400g) |
| Red bell pepper | 1, diced |
| Onion | 1, diced |
| Garlic | 3 cloves |
| Cumin | 1 tsp |
| Paprika | 1 tsp |
| Chili flakes | 1/2 tsp |
| Eggs | 4-6 |
| Feta cheese | to taste |
| Fresh cilantro | handful |
| Olive oil | 2 tbsp |

## Method

1. Heat olive oil in a deep skillet over medium heat
2. Saute onion and pepper until soft (~5 min)
3. Add garlic, cumin, paprika, chili — cook 1 min until fragrant
4. Pour in tomatoes, break them up with a spoon, simmer 10 min
5. Make wells in the sauce, crack eggs in
6. Cover and cook 5-8 min until whites set, yolks still runny
7. Crumble feta, scatter cilantro, serve with crusty bread

## Notes

- The spice base is similar to what you'd find in [[Istanbul]] street food
- Pairs well with the sourdough from [[Sourdough Bread]]
- For a heartier meal, add chickpeas or ground lamb

#one-pan #vegetarian #weekend-brunch`
  },
  {
    folder: 'recipes',
    title: 'Homemade Ramen',
    emoji: '🍜',
    tags: ['japanese', 'soup', 'project-meal'],
    properties: { cuisine: 'Japanese', prepTime: '30 min (+ 4hr broth)', difficulty: 'hard' },
    body: `## The Broth Is Everything

A proper tonkotsu broth takes **4-6 hours** of rolling boil. The collagen from pork bones emulsifies into the liquid, creating that signature creamy white color.

## Components

### Broth
- 2 kg pork neck bones, blanched
- 1 whole garlic head, halved
- 2-inch piece ginger, sliced
- Water to cover

### Tare (seasoning base)
\`\`\`
60ml soy sauce
30ml mirin
15ml sesame oil
1 tbsp dashi powder
\`\`\`

### Toppings
- **Chashu** — pork belly braised in soy/mirin/sake, torched before serving
- **Ajitama** — soft-boiled egg marinated 24hr in soy/mirin
- Nori, scallions, sesame seeds, chili oil

## Assembly

1. Place 2 tbsp tare in each bowl
2. Ladle boiling broth over tare, stir
3. Add cooked noodles (fresh Sun brand, 90 seconds)
4. Arrange toppings with *intention* — presentation matters

This is the dish that made me fall in love with cooking in [[Tokyo]]. For a quicker weeknight meal, try [[Thai Green Curry]] instead.

#slow-cook #umami #weekend-project`
  },
  {
    folder: 'recipes',
    title: 'Sourdough Bread',
    emoji: '🍞',
    tags: ['baking', 'fermentation', 'artisan'],
    properties: { cuisine: 'European', prepTime: '24 hours', difficulty: 'medium' },
    body: `## Starter Maintenance

Feed your starter **daily** if on counter, or **weekly** if refrigerated.

\`\`\`
Ratio: 1:5:5 (starter : flour : water) by weight
Example: 20g starter + 100g flour + 100g water
\`\`\`

## The Formula

| Ingredient | Baker's % | Weight |
|------------|-----------|--------|
| Bread flour | 90% | 450g |
| Whole wheat | 10% | 50g |
| Water | 78% | 390g |
| Salt | 2% | 10g |
| Starter | 20% | 100g |

## Timeline

- **9:00 PM** — Mix flour + water (autolyse)
- **9:30 PM** — Add starter + salt, slap & fold
- **10:00 PM – 7:00 AM** — Bulk ferment (ambient, ~21°C)
- **7:00 AM** — Shape, into banneton
- **7:15 AM – 12:00 PM** — Cold retard in fridge
- **12:00 PM** — Score and bake: 250°C covered 20 min, uncovered 25 min

## Crumb Diagnosis

- **Dense, gummy** → under-fermented, extend bulk
- **Too open, collapsing** → over-fermented, shorten bulk or reduce starter
- **Tight crumb** → need more stretch & folds, or higher hydration

The fermentation patience reminds me of the long-game approach in [[2026 Goals]]. Serve alongside [[Shakshuka]] for the ultimate weekend brunch.

#sourdough #patience #fermentation`
  },
  {
    folder: 'recipes',
    title: 'Thai Green Curry',
    emoji: '🥥',
    tags: ['thai', 'curry', 'weeknight'],
    properties: { cuisine: 'Thai', prepTime: '25 min', difficulty: 'easy' },
    body: `## Why Make Your Own Paste?

Store-bought is fine for weeknights, but homemade paste is a **revelation**. The difference is freshness — the volatile aromatics in lemongrass and galangal degrade within days of grinding.

## Quick Paste (mortar & pestle)

- 4 green chilies (bird's eye for heat, or long green for mild)
- 3 cloves garlic
- 2 shallots
- 1 stalk lemongrass (tender inner part only)
- 1-inch galangal (or ginger as substitute)
- Handful of cilantro stems
- 1 tsp cumin seeds, toasted
- 1 tsp coriander seeds, toasted
- 1 tsp shrimp paste
- Zest of 1 lime

## Method

1. Fry paste in a splash of coconut cream until fragrant (~2 min)
2. Add chicken/tofu, cook until sealed
3. Pour in coconut milk, bring to gentle simmer
4. Add vegetables: Thai eggplant, bamboo shoots, bell pepper
5. Season: fish sauce, palm sugar, lime juice — **taste and balance**
6. Finish with Thai basil and a splash of coconut cream

> The balance of salty (fish sauce), sweet (palm sugar), sour (lime), and spicy (chili) is the foundation of all Thai cooking.

Serve over jasmine rice. For a completely different flavor profile, try [[Shakshuka]]. The aromatics here connect to the spice markets in [[Istanbul]].

#coconut #aromatic #quick-dinner`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Travel
  // ═══════════════════════════════════════════════════════════════════════════
  {
    folder: 'travel',
    title: 'Japan 2025',
    emoji: '🇯🇵',
    tags: ['japan', 'trip-planning', 'asia'],
    properties: { destination: 'Japan', dates: '2025-10-15 to 2025-10-30', budget: 4500 },
    body: `## Itinerary

### Week 1: Tokyo & Day Trips
- **Days 1-3** — [[Tokyo]] — Shimokitazawa, Yanaka, Akihabara
- **Day 4** — Kamakura (Great Buddha, Hokokuji bamboo grove)
- **Day 5** — Nikko (Toshogu Shrine, autumn foliage)

### Week 2: Kansai & Beyond
- **Days 6-8** — Kyoto (Fushimi Inari at dawn, Arashiyama, Philosopher's Path)
- **Day 9** — Nara (deer park, Todaiji)
- **Days 10-12** — Osaka (Dotonbori, street food marathon)
- **Days 13-15** — Hiroshima + Miyajima Island

## Budget Breakdown

| Category | Estimated |
|----------|-----------|
| Flights | $1,200 |
| JR Pass (21 days) | $450 |
| Accommodation | $1,500 |
| Food | $800 |
| Activities | $300 |
| Buffer | $250 |
| **Total** | **$4,500** |

## Packing Notes

- **IC card** (Suica/Pasmo) — essential for transit
- **Pocket wifi** — rent at airport
- **Cash** — Japan is still heavily cash-based outside Tokyo
- **Comfortable shoes** — you *will* walk 15-20k steps daily

Food research: [[Homemade Ramen]] for context on what to order. This trip connects to the photography project in [[Photography Portfolio]].

#autumn #rail-pass #bucket-list`
  },
  {
    folder: 'travel',
    title: 'Portugal Road Trip',
    emoji: '🇵🇹',
    tags: ['portugal', 'road-trip', 'europe'],
    properties: { destination: 'Portugal', dates: '2026-06 (tentative)', budget: 3000 },
    body: `## Route: Lisbon → Porto (10 days)

### Leg 1: Lisbon (3 nights)
Start in [[Lisbon]]. Alfama, Belem, LX Factory. Day trip to Sintra (Pena Palace, Quinta da Regaleira).

### Leg 2: Alentejo (2 nights)
- **Evora** — Roman temple, bone chapel, cork oak landscapes
- **Monsaraz** — hilltop village overlooking Alqueva reservoir
- Wine tasting at one of the *quintas*

### Leg 3: Algarve Coast (2 nights)
- **Benagil Cave** — kayak at sunrise to avoid crowds
- **Lagos** — Ponta da Piedade cliffs
- Skip the resort towns, stick to the western coast

### Leg 4: Porto (3 nights)
- **Livraria Lello** — the bookshop that inspired Hogwarts (go early or skip it)
- **Ribeira** — port wine cellars across the river in Vila Nova de Gaia
- **Francesinha** — Porto's answer to the croque monsieur, smothered in beer sauce

## Driving Tips

- **Toll roads** — get a Via Verde transponder at the rental agency
- **Parking** — use the Telpark app in cities
- **Speed cameras** — frequent and strictly enforced

The architectural beauty pairs with themes from [[The Grand Budapest Hotel]]. Compare this with the Asia experience in [[Japan 2025]].

#driving #wine #atlantic-coast`
  },
  {
    folder: 'travel',
    title: 'Cappadocia Balloon',
    emoji: '🎈',
    tags: ['turkey', 'adventure', 'bucket-list'],
    properties: { destination: 'Cappadocia, Turkey', dates: '2025-05 (completed)', budget: 1200 },
    body: `## The Experience

Waking up at **4:30 AM** in Goreme to watch 150+ balloons inflate against the pre-dawn sky. The silence at altitude is surreal — just the occasional *whoosh* of the burner.

## Practical Details

- **Company**: Royal Balloon (worth the premium — smaller baskets, better pilots)
- **Cost**: ~€250/person for the deluxe flight
- **Duration**: ~60 minutes in the air
- **Season**: April–November, but May and September have the best weather

## Photography Tips

1. **Shoot from the basket edge** — wide angle for the valley, telephoto for other balloons
2. **Golden hour is guaranteed** — you're literally flying during sunrise
3. **Bring a backup battery** — cold morning air drains lithium-ion fast

## Beyond Balloons

- **Underground cities** (Derinkuyu) — 8 levels deep, housed 20,000 people
- **Goreme Open Air Museum** — cave churches with Byzantine frescoes
- **Ihlara Valley** — a 14km gorge hike with rock-cut churches along the river

> The fairy chimneys are volcanic tuff sculpted by millions of years of erosion. Nature's architecture puts human efforts to shame.

The landscape connects to the otherworldly visuals in [[Interstellar]]. While in Turkey, extend the trip to [[Istanbul]]. The adventure spirit pairs with [[Morning Routine]] — sometimes you have to get up at 4 AM for something extraordinary.

#hot-air-balloon #sunrise #fairy-chimneys`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Tech
  // ═══════════════════════════════════════════════════════════════════════════
  {
    folder: 'tech',
    title: 'Rust Ownership',
    emoji: '🦀',
    tags: ['rust', 'programming', 'memory-safety'],
    properties: { category: 'language', proficiency: 'intermediate' },
    body: `## The Three Rules

1. Each value has exactly **one owner**
2. When the owner goes out of scope, the value is **dropped**
3. You can have *either* one mutable reference **or** any number of immutable references

## Borrowing vs Moving

\`\`\`rust
fn main() {
    let s1 = String::from("hello");

    // Move — s1 is no longer valid
    let s2 = s1;
    // println!("{s1}"); // ERROR: value moved

    // Borrow — s2 remains valid
    let len = calculate_length(&s2);
    println!("{s2} has length {len}"); // OK

    // Mutable borrow — exclusive access
    let mut s3 = String::from("hello");
    change(&mut s3);
}

fn calculate_length(s: &String) -> usize {
    s.len()
}

fn change(s: &mut String) {
    s.push_str(", world");
}
\`\`\`

## Lifetimes in 30 Seconds

Lifetimes are Rust's way of saying: "this reference is valid for *at least* this long."

\`\`\`rust
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}
\`\`\`

The \`'a\` annotation doesn't change behavior — it helps the **compiler verify** that references don't outlive their data.

## Why It Matters

Ownership eliminates entire *categories* of bugs at compile time:
- No use-after-free
- No double-free
- No data races

The thematic connection to [[Blade Runner 2049]] is surprisingly apt — who "owns" a memory? See [[Yjs CRDT]] for a different approach to shared ownership in distributed systems.

#zero-cost-abstractions #borrow-checker #memory`
  },
  {
    folder: 'tech',
    title: 'Docker Compose Cheatsheet',
    emoji: '🐳',
    tags: ['docker', 'devops', 'reference'],
    properties: { category: 'tool', proficiency: 'advanced' },
    body: `## Essential Commands

\`\`\`bash
# Start all services
docker compose up -d

# Rebuild and start
docker compose up -d --build

# View logs (follow mode)
docker compose logs -f [service]

# Execute command in running container
docker compose exec [service] sh

# Stop and remove everything (including volumes)
docker compose down -v
\`\`\`

## Common Patterns

### Health Checks

\`\`\`yaml
services:
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  app:
    depends_on:
      db:
        condition: service_healthy
\`\`\`

### Named Volumes with Backup

\`\`\`yaml
volumes:
  pgdata:
    driver: local
  redis-data:
    driver: local
\`\`\`

### Environment Files

\`\`\`yaml
services:
  app:
    env_file:
      - .env
      - .env.local  # overrides
\`\`\`

## Networking

By default, Compose creates a **bridge network** per project. Services communicate via their service name as hostname:

\`\`\`
app → http://db:5432
app → http://redis:6379
\`\`\`

Used extensively in [[Home Lab Setup]]. The container isolation model has parallels to [[Rust Ownership]] — each container owns its filesystem, borrows the network.

#containers #yaml #infrastructure`
  },
  {
    folder: 'tech',
    title: 'Yjs CRDT',
    emoji: '🔄',
    tags: ['crdt', 'distributed-systems', 'real-time'],
    properties: { category: 'framework', proficiency: 'intermediate' },
    body: `## What Is Yjs?

A **CRDT** (Conflict-free Replicated Data Type) implementation optimized for collaborative editing. Every device maintains its own copy of the document; changes merge automatically without a central server.

## Core Data Types

| Type | Use Case |
|------|----------|
| Y.Text | Rich text, code editors |
| Y.Array | Ordered lists |
| Y.Map | Key-value stores |
| Y.XmlFragment | DOM-like structures |

## How Merging Works

\`\`\`typescript
import * as Y from 'yjs'

const doc1 = new Y.Doc()
const doc2 = new Y.Doc()

// Edit on device 1
const text1 = doc1.getText('content')
text1.insert(0, 'Hello ')

// Edit on device 2
const text2 = doc2.getText('content')
text2.insert(0, 'World')

// Sync — both documents converge
const update1 = Y.encodeStateAsUpdate(doc1)
const update2 = Y.encodeStateAsUpdate(doc2)
Y.applyUpdate(doc1, update2)
Y.applyUpdate(doc2, update1)

// Both now contain "WorldHello " (deterministic merge)
\`\`\`

## Why Not OT?

Operational Transform (Google Docs' approach) requires a **central server** to order operations. CRDTs converge *mathematically* — no server needed. Trade-off: CRDTs use more memory to track causality metadata.

## In Practice

Used in [[memry]] for note synchronization. The theoretical foundations come from Chapter 5 of [[Designing Data-Intensive Applications]] (leaderless replication + conflict resolution).

The ownership semantics differ from [[Rust Ownership]] — in CRDTs, *everyone* owns a copy and the math ensures they converge.

#convergence #offline-first #collaborative`
  },
  {
    folder: 'tech',
    title: 'SQLite WAL Mode',
    emoji: '💾',
    tags: ['sqlite', 'database', 'performance'],
    properties: { category: 'concept', proficiency: 'advanced' },
    body: `## What Is WAL?

**Write-Ahead Logging** is an alternative journaling mode for SQLite that dramatically improves concurrent read/write performance.

## Default (Rollback Journal) vs WAL

| Feature | Rollback | WAL |
|---------|----------|-----|
| Readers block writers | Yes | **No** |
| Writers block readers | Yes | **No** |
| Multiple concurrent readers | Yes | Yes |
| Multiple concurrent writers | No | No |
| Crash recovery | Slower | Faster |
| File structure | 1 file + journal | 1 file + WAL + WAL-index |

## Enabling WAL

\`\`\`sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;  -- safe with WAL
PRAGMA busy_timeout = 5000;   -- wait up to 5s for locks
\`\`\`

## How It Works

1. **Writes** go to the WAL file (append-only)
2. **Reads** check both the main DB and WAL (using the WAL-index for fast lookups)
3. **Checkpoints** periodically move WAL contents back into the main DB
4. Readers see a **consistent snapshot** — they're never affected by ongoing writes

## Gotchas

- WAL files can grow large if checkpoints are infrequent
- **Network filesystems** (NFS, SMB) don't support the shared memory WAL-index
- Maximum WAL size can be configured with \`PRAGMA wal_autocheckpoint\`

\`\`\`typescript
// In memry, we set pragmas on every connection
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('synchronous = NORMAL')
sqlite.pragma('foreign_keys = ON')
\`\`\`

Used in [[memry]] for both data.db and index.db. The concepts map to Chapter 3 of [[Designing Data-Intensive Applications]] (storage engines). The concurrent access patterns relate to [[Yjs CRDT]] — both solve the "multiple actors, one data store" problem differently.

#pragma #concurrent-reads #journaling`
  },
  {
    folder: 'tech',
    title: 'Vim Motions',
    emoji: '⌨️',
    tags: ['vim', 'editor', 'productivity'],
    properties: { category: 'tool', proficiency: 'intermediate' },
    body: `## The Mental Model

Vim commands are a **language**: \`verb + modifier + noun\`.

- \`d\` (delete) + \`i\` (inside) + \`w\` (word) = delete inside word
- \`c\` (change) + \`a\` (around) + \`"\` = change around quotes
- \`y\` (yank) + \`2\` (count) + \`j\` (down) = yank 2 lines down

## Essential Motions

### Navigation
| Key | Motion |
|-----|--------|
| \`w\` / \`b\` | Next / previous word |
| \`f{char}\` | Jump to next {char} on line |
| \`}\` / \`{\` | Next / previous paragraph |
| \`gg\` / \`G\` | Top / bottom of file |
| \`%\` | Matching bracket |
| \`*\` / \`#\` | Next / previous occurrence of word |

### Text Objects (the real power)
| Command | Scope |
|---------|-------|
| \`iw\` | inner word |
| \`i"\` | inside quotes |
| \`it\` | inside HTML tag |
| \`i{\` | inside braces |
| \`ip\` | inner paragraph |

## Macros

\`\`\`
qa       → start recording macro 'a'
(edits)  → do your edits
q        → stop recording
@a       → replay macro
100@a    → replay 100 times
\`\`\`

## My Most-Used Combos

1. \`ci"\` — change inside quotes (use constantly)
2. \`di{\` — delete inside braces
3. \`yip\` — yank inner paragraph
4. \`gv\` — reselect last visual selection
5. \`zz\` — center current line on screen

Once you internalize the grammar, every new verb or noun multiplies your vocabulary. This is why Vim motions work in VS Code, IntelliJ, and even [[memry]].

The composability principle connects to [[Rust Ownership]] — small, orthogonal rules that combine into powerful behavior.

#modal-editing #composability #muscle-memory`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Personal
  // ═══════════════════════════════════════════════════════════════════════════
  {
    folder: 'personal',
    title: 'Morning Routine',
    emoji: '🌅',
    tags: ['habits', 'wellness', 'daily'],
    properties: {},
    body: `## Current Routine (v3)

Evolved through trial and error. The key insight: **protect the first 90 minutes** from inputs (email, Slack, news).

### 6:30 — Wake
No alarm snoozing. Phone stays in another room overnight.

### 6:35 — Movement
- 5 min stretching (hip flexors, shoulders, hamstrings)
- 10 min walk outside, regardless of weather
- The light exposure resets circadian rhythm — more effective than coffee

### 7:00 — Focus Block
- 60 min of deep work on the **most important** task
- No communication tools open
- Usually coding or writing

### 8:00 — Breakfast + Inputs
- Open email and messages
- Review calendar
- Usually eggs or overnight oats

## What I Tried and Dropped

- **Cold showers** — too much willpower drain for marginal benefit
- **Journaling first thing** — better at night for me
- **Meditation apps** — prefer the walk instead

> "The goal is not perfection. The goal is that the default state of your morning serves you rather than drains you."

Connects to the sleep optimization research alongside [[Workout Plan]], and the long-term vision in [[2026 Goals]]. The discipline needed is like maintaining a [[Sourdough Bread]] starter — small daily actions compound.

#keystone-habit #no-phone #deep-work`
  },
  {
    folder: 'personal',
    title: 'Book Club Notes',
    emoji: '📖',
    tags: ['reading', 'community', 'notes'],
    properties: {},
    body: `## Current Rotation

Meeting **every other Thursday, 7 PM**, at the cafe on 5th Street.

### Recently Discussed

1. **[[Sapiens]]** — Yuval Noah Harari
   - Group consensus: brilliant first half, repetitive second half
   - Best debate: "Is the agricultural revolution really a fraud?"

2. **[[The Remains of the Day]]** — Kazuo Ishiguro
   - Most emotionally resonant pick so far
   - Discussion lasted 2.5 hours (usually 1.5)
   - Key question: "Is Stevens a tragic figure or a willing participant?"

3. **[[Project Hail Mary]]** — Andy Weir
   - Lightest pick in months, everyone loved Rocky
   - Debate: hard sci-fi accessibility vs. literary depth

### Up Next

- *Piranesi* by Susanna Clarke (voted 4-1)
- *The Road* by Cormac McCarthy (tentative)

## Reading Pace

We aim for **one book per month**. Shorter books (~250 pages) work best — everyone actually finishes them.

## Format

- First 30 min: **no spoilers** discussion (themes, writing style)
- Remaining time: **open discussion** (plot, ending, hot takes)
- Someone brings a printed-out review from a critic for counterpoint

The community aspect pairs well with the discipline in [[Morning Routine]] — consistency is what makes it work.

#biweekly #discussion #cafe`
  },
  {
    folder: 'personal',
    title: 'Workout Plan',
    emoji: '💪',
    tags: ['fitness', 'strength', 'routine'],
    properties: {},
    body: `## Current Split: Push/Pull/Legs (6 days)

### Push (Monday & Thursday)
| Exercise | Sets × Reps |
|----------|-------------|
| Bench Press | 4 × 6-8 |
| Overhead Press | 3 × 8-10 |
| Incline DB Press | 3 × 10-12 |
| Cable Flyes | 3 × 12-15 |
| Tricep Pushdown | 3 × 12-15 |
| Lateral Raises | 4 × 15-20 |

### Pull (Tuesday & Friday)
| Exercise | Sets × Reps |
|----------|-------------|
| Deadlift (Tue) / Barbell Row (Fri) | 4 × 5-6 |
| Pull-ups | 4 × max |
| Cable Row | 3 × 10-12 |
| Face Pulls | 4 × 15-20 |
| Bicep Curls | 3 × 10-12 |
| Hammer Curls | 3 × 12-15 |

### Legs (Wednesday & Saturday)
| Exercise | Sets × Reps |
|----------|-------------|
| Squat | 4 × 6-8 |
| Romanian Deadlift | 3 × 8-10 |
| Leg Press | 3 × 10-12 |
| Walking Lunges | 3 × 12/leg |
| Calf Raises | 4 × 15-20 |
| Leg Curls | 3 × 12-15 |

## Progressive Overload

Increase weight when you hit the **top of the rep range** for all sets. Example: bench press prescribed 4×6-8 → once you hit 4×8, add 2.5kg next session.

## Recovery

- **Sleep**: 7-8 hours minimum (see [[Morning Routine]] for the routine)
- **Protein**: 1.6-2.2g per kg body weight
- **Deload**: every 4th week, drop volume 40%

The discipline here is the same as maintaining a [[Sourdough Bread]] starter or sticking to [[2026 Goals]] — systems beat motivation.

#progressive-overload #consistency #ppl`
  },
  {
    folder: 'personal',
    title: '2026 Goals',
    emoji: '🎯',
    tags: ['goals', 'yearly', 'reflection'],
    properties: {},
    body: `## Theme: **Build in Public**

Stop perfecting things privately. Ship more, share more, iterate in the open.

## Quarterly Targets

### Q1 (Jan–Mar)
- [x] Launch [[memry]] alpha to 10 testers
- [x] Establish [[Morning Routine]] v3
- [ ] Read 3 books from club list (see [[Book Club Notes]])

### Q2 (Apr–Jun)
- [ ] Ship memry to public beta
- [ ] Complete [[Portugal Road Trip]] planning
- [ ] Hit 100kg squat (currently 85kg, tracked in [[Workout Plan]])

### Q3 (Jul–Sep)
- [ ] Launch [[Photography Portfolio]] site
- [ ] Attend one tech conference
- [ ] Complete [[Japan 2025]] (trip is in October but prep is Q3)

### Q4 (Oct–Dec)
- [ ] memry v1.0 launch
- [ ] Annual review and 2027 planning
- [ ] Try one entirely new skill

## Anti-Goals

Things I'm deliberately **not** pursuing this year:
- Growing a social media following
- Freelancing or consulting
- Learning a new programming language (consolidating [[Rust Ownership]] instead)

## Monthly Check-In Format

> Am I building in public? What did I ship this month? What am I avoiding?

The yearly perspective connects everything: [[memry]] is the main project, [[Morning Routine]] is the daily foundation, [[Workout Plan]] is the physical side. Even cooking ([[Sourdough Bread]], [[Thai Green Curry]]) is about mastering processes.

#yearly-review #accountability #anti-goals`
  }
]
