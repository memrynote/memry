import { table } from '../body.ts'
import type { NoteSpec } from '../specs.ts'

const RECIPES = 'Kitchen/Recipes'

export const kitchenNotes: NoteSpec[] = [
  {
    key: 'k-romanesco',
    title: 'Roasted romanesco with lemon',
    emoji: '🥦',
    folder: RECIPES,
    tags: ['recipe', 'vegetarian'],
    assets: ['photo-romanesco.jpg'],
    created: 45,
    modified: 19,
    properties: (b) => ({
      Course: 'Side',
      Time: 35,
      Servings: 4,
      Rating: 4,
      tried: true,
      cover: b.ref('photo-romanesco.jpg'),
      coverCredit: 'George Chernilevsky, CC BY 4.0'
    }),
    body: (b) => `${b.image('photo-romanesco.jpg', { width: 480 })}

Photo: George Chernilevsky, CC BY 4.0.

## Ingredients

- 1 large romanesco, cut into small florets
- 3 tbsp olive oil
- 1 lemon, zest and juice
- 2 cloves garlic, sliced
- Flaky salt, chili flakes

## Method

1. Oven to 220 °C. Toss the florets with oil and salt.
2. Roast 20 minutes on the top rack, until the tips char.
3. Add garlic for the last 5 minutes.
4. Finish with lemon zest, juice and chili.

Goes with the [[Wild mushroom risotto]] on risotto night; see [[Meal plan]].
`
  },
  {
    key: 'k-risotto',
    title: 'Wild mushroom risotto',
    folder: RECIPES,
    tags: ['recipe', 'vegetarian'],
    emoji: '🍄',
    assets: ['photo-mushroom-basket.jpg'],
    created: 39,
    modified: 3,
    properties: (b) => ({
      Course: 'Main',
      Time: 45,
      Servings: 3,
      Rating: 5,
      tried: true,
      cover: b.ref('photo-mushroom-basket.jpg'),
      coverCredit: 'George Chernilevsky, CC BY 4.0'
    }),
    body: (
      b
    ) => `The one I make when friends come over. Ines taught me to toast the rice longer than feels right.

${b.image('photo-mushroom-basket.jpg', { caption: 'Market haul. Photo: George Chernilevsky, CC BY 4.0' })}

## Ingredients

${table([
  ['Ingredient', 'Amount'],
  ['Carnaroli rice', '300 g'],
  ['Mixed mushrooms', '400 g'],
  ['Dried porcini', '15 g, soaked'],
  ['Shallots', '2'],
  ['White wine', '150 ml'],
  ['Vegetable stock', '1.2 l, hot'],
  ['Butter and parmesan', 'to finish']
])}

## Method

1. Soak the porcini in 300 ml hot water; keep the water.
2. Brown the fresh mushrooms in batches. Do not crowd the pan.
3. Soften shallots, toast the rice for 3 minutes, add wine.
4. Ladle in stock and porcini water, stirring, for 18 minutes.
5. Off the heat: butter, parmesan, the mushrooms. Rest 2 minutes.

> [!success]
> Made it for Jonah and Ines last week. Second helpings all round.

Shopping for it is on the [[Grocery list]].
`
  },
  {
    key: 'k-shortcake',
    title: 'Strawberry shortcake, 1918',
    emoji: '🍓',
    folder: RECIPES,
    tags: ['recipe', 'baking'],
    assets: ['ocr-fannie-farmer-cookbook-p83.jpg'],
    created: 23,
    modified: 23,
    properties: (b) => ({
      Course: 'Dessert',
      Time: 50,
      Servings: 6,
      tried: false,
      source: 'https://archive.org/search?query=boston+cooking-school+cook+book',
      cover: b.ref('ocr-fannie-farmer-cookbook-p83.jpg')
    }),
    body: (
      b
    ) => `From page 83 of Fannie Farmer's *Boston Cooking-School Cook Book* (1918 printing). The page is a photo; Memry reads the printed text with OCR, so searching for "crullers" finds this note.

${b.image('ocr-fannie-farmer-cookbook-p83.jpg', { width: 420 })}

## My modern version

- Swap the lard for cold butter
- Bake as one round, split while warm
- Macerate the berries with sugar and a little lemon for an hour

Want to try it for the trip send-off dinner. Source: Internet Archive scan, public domain.
`
  },
  {
    key: 'k-granola',
    title: 'Weekday granola',
    emoji: '🥣',
    folder: RECIPES,
    tags: ['recipe', 'vegetarian'],
    assets: ['ocr-fda-nutrition-facts.png'],
    created: 33,
    modified: 15,
    properties: () => ({
      Course: 'Breakfast',
      Time: 40,
      Servings: 8,
      Rating: 4,
      tried: true,
      cover: 'wash:wheat'
    }),
    body: (
      b
    ) => `Less sugar than anything in the shop. I photographed a nutrition label to compare; the image is searchable, so "saturated fat" finds it.

${b.image('ocr-fda-nutrition-facts.png', { width: 260 })}

## Ingredients

- 400 g rolled oats
- 150 g mixed nuts, roughly chopped
- 60 g pumpkin seeds
- 80 ml maple syrup, 60 ml olive oil
- Pinch of salt, 1 tsp cinnamon

## Method

1. Oven to 160 °C.
2. Mix everything, spread thin on two trays.
3. Bake 30 to 35 minutes, stirring once. Let it cool on the tray so it clumps.
`
  },
  {
    key: 'k-shakshuka',
    title: 'Shakshuka for two',
    emoji: '🍳',
    folder: RECIPES,
    tags: ['recipe', 'vegetarian'],
    created: 28,
    modified: 28,
    properties: () => ({
      Course: 'Main',
      Time: 25,
      Servings: 2,
      Rating: 4,
      tried: true,
      cover: 'wash:clay'
    }),
    body: () => `Sunday breakfast, or any night there is nothing in the fridge but eggs and a tin of tomatoes.

## Ingredients

- 1 onion, 1 red pepper, 2 cloves garlic
- 1 tin chopped tomatoes
- 1 tsp cumin, 1 tsp smoked paprika
- 4 eggs, feta, parsley

## Method

1. Soften onion and pepper, 8 minutes. Add garlic and spices.
2. Add tomatoes, simmer 10 minutes until thick.
3. Make four wells, crack in the eggs, cover until the whites set.
4. Feta and parsley on top. Eat from the pan.
`
  },
  {
    key: 'k-meal-plan',
    title: 'Meal plan',
    folder: 'Kitchen',
    tags: ['cooking'],
    emoji: '🗓️',
    created: 9,
    modified: 1,
    body: () => `This week. Cook twice, eat leftovers twice, one night out.

${table([
  ['Day', 'Dinner', 'Notes'],
  ['Monday', '[[Shakshuka for two]]', 'Quick'],
  ['Tuesday', 'Leftovers', ''],
  ['Wednesday', '[[Wild mushroom risotto]]', 'Jonah and Ines over'],
  ['Thursday', '[[Roasted romanesco with lemon]]', 'With the leftover risotto'],
  ['Friday', 'Out', 'Studio lunch is the big meal'],
  ['Weekend', '[[Weekday granola]] batch', 'For next week']
])}

Shopping list: [[Grocery list]].
`
  },
  {
    key: 'k-grocery',
    title: 'Grocery list',
    folder: 'Kitchen',
    tags: ['cooking'],
    emoji: '🛒',
    created: 3,
    modified: 0,
    body: (b) => `For the [[Meal plan]].

${b.task('p-groceries')}

Market:

- [ ] Mixed mushrooms, 400 g {check}
- [ ] Romanesco {check}
- [x] Lemons {check}
- [ ] Parsley {check}
- [x] Eggs, a dozen {check}

Shop:

- [ ] Carnaroli rice {check}
- [x] Tinned tomatoes {check}
- [ ] Parmesan {check}
- [ ] Rolled oats {check}
`
  }
]

export const travelNotes: NoteSpec[] = [
  {
    key: 't-trip',
    title: 'Grand Teton trip',
    folder: 'Travel/Grand Teton',
    tags: ['travel', 'hiking'],
    emoji: '🏔️',
    assets: ['photo-grand-teton.jpg'],
    created: 31,
    modified: 1,
    properties: (b) => ({
      deadline: b.day(20),
      cover: b.ref('photo-grand-teton.jpg'),
      coverFocus: 60,
      coverCredit: 'Carol M. Highsmith, Library of Congress'
    }),
    body: (
      b
    ) => `Five days in Grand Teton National Park with Jonah and Ines, from ${b.date(20, { format: 'full' })}. Fly into Jackson, base in a cabin near Moose.

${b.image('photo-grand-teton.jpg', { caption: 'The range from the valley floor. Photo: Carol M. Highsmith, Library of Congress' })}

## Itinerary

${table([
  ['Day', 'Plan', 'Sleep'],
  ['1', 'Fly to Jackson, groceries, Mormon Row at sunset', 'Cabin'],
  ['2', 'Jenny Lake loop and Inspiration Point', 'Cabin'],
  ['3', 'Cascade Canyon, the long one', 'Cabin'],
  ['4', 'Rest day: Oxbow Bend at dawn, then the river', 'Cabin'],
  ['5', 'Taggart Lake, fly home', 'Home']
])}

Map: [Grand Teton on OpenStreetMap](https://www.openstreetmap.org/#map=11/43.7904/-110.6818)

--- start-multi-column: teton-plan
\`\`\`column-settings
Number of Columns: 2
Column Size: [50%, 50%]
\`\`\`

### Before we go

- Permits and bear spray
- Download offline maps
- Break in the boots

--- end-column ---

### Who brings what

- Jonah: stove, water filter
- Ines: first aid, the good camera
- Me: food plan, [[Packing list]]

--- end-multi-column

## Details

<details data-memry-toggle>
<summary>Flights</summary>

Out: early flight, arrive Jackson 13:40. Back: 17:05 on day 5. Rental car pickup at the airport.

</details>

<details data-memry-toggle>
<summary>Bears</summary>

Carry spray on every hike, keep it on the hip belt, not in the pack. Food in the car or the bear box, never in the cabin porch.

</details>

> [!warning]
> Cascade Canyon is 15 miles round trip with the boat. Start before 7.

Hikes compared in [[Hikes shortlist]].
`
  },
  {
    key: 't-packing',
    title: 'Packing list',
    folder: 'Travel/Grand Teton',
    tags: ['travel'],
    created: 14,
    modified: 2,
    body: (
      b
    ) => `For [[Grand Teton trip]]. Plain checkboxes, not tasks: ticking these does not clutter the task list.

## Clothes

- [x] Rain shell {check}
- [x] Fleece {check}
- [ ] Two pairs hiking socks {check}
- [ ] Sun hat {check}

## Gear

- [ ] Bear spray (buy there, cannot fly with it) {check}
- [x] Headlamp {check}
- [ ] Power bank {check}
- [ ] Offline maps downloaded {check}

## Documents

${b.task('p-passport')}

${b.task('p-permits')}
`
  },
  {
    key: 't-hikes',
    title: 'Hikes shortlist',
    folder: 'Travel/Grand Teton',
    tags: ['travel', 'hiking'],
    created: 25,
    modified: 6,
    body: () => `Picked from the park site and two trip reports.

<!-- table-colors:{"0:0":{"backgroundColor":"green"},"0:1":{"backgroundColor":"green"},"0:2":{"backgroundColor":"green"},"0:3":{"backgroundColor":"green"}} -->
${table([
  ['Hike', 'Miles', 'Gain (ft)', 'Verdict'],
  ['Taggart Lake', '3.0', '400', 'Easy last-day hike'],
  ['Jenny Lake loop', '7.1', '700', 'Yes, day 2'],
  ['Cascade Canyon', '15.0', '1100', 'Yes, the big one'],
  ['Delta Lake', '7.4', '2300', 'No, too steep for Ines']
])}

Plan lives in [[Grand Teton trip]].
`
  }
]

export const writingNotes: NoteSpec[] = [
  {
    key: 'x-draft',
    title: 'Space race essay draft',
    folder: 'Writing',
    tags: ['writing', 'essay', 'space-race'],
    emoji: '✍️',
    created: 21,
    modified: 0,
    properties: (b) => ({ stage: 'Draft', deadline: b.day(14) }),
    body: () => essayDrafts[essayDrafts.length - 1]
  },
  {
    key: 'x-craft',
    title: 'Omit needless words',
    folder: 'Writing',
    tags: ['writing'],
    assets: ['ocr-strunk-elements-of-style-p24.jpg'],
    created: 17,
    modified: 16,
    body: (
      b
    ) => `Rule 13 from *The Elements of Style*. The page is a photo from the 1920 edition; its words are searchable.

${b.image('ocr-strunk-elements-of-style-p24.jpg', { width: 400 })}

> Vigorous writing is concise.

## How I use it on the essay draft

- First pass: cut every "very", "really", "in order to"
- Second pass: every paragraph must earn its first sentence
- Third pass: read it aloud

Applied to [[Space race essay draft]]. Book notes: [[The Elements of Style]].
`
  },
  {
    key: 'x-learning',
    title: 'Learning log',
    folder: 'Writing',
    tags: ['learning'],
    created: 60,
    modified: 4,
    body: () => `Things I learned and want to keep. Newest at the top.

## Typography

- Measure matters more than size. 60 to 72 characters, then pick the size that gets you there.
- Night themes need warmer text, not just darker backgrounds.

## Writing

- Write the ending first if you know it. I do: [[In Event of Moon Disaster]].
- Notes are not drafts. Drafts are where notes go to be argued with. (From [[How to Take Smart Notes]].)

## Tools

- Wiki links beat folders for research; folders beat links for projects.
- A canvas is the right place to argue about structure: [[Space race essay board]].
`
  }
]

/** Successive drafts of the essay; versions.ts snapshots all but the last, which is the note body. */
export const essayDrafts: string[] = [
  `# Notes in the space race

Working title. Opening with the Hamilton photo?

- checklists
- flight plan
- Safire memo as ending
`,
  `# Notes in the space race

The photograph everyone knows shows Margaret Hamilton beside a stack of paper as tall as she is. It is usually read as a picture of code. It is also a picture of notes.

## Checklists

Cuff checklists, written so trained people would not forget under stress.

## The shared book

The flight plan, edited from both ends by voice.
`,
  `# Notes in the space race

The photograph everyone knows shows Margaret Hamilton beside a stack of paper as tall as she is. It is usually read as a picture of code. It is just as much a picture of notes: listings printed so people could read them, argue with them and write in their margins.

## Checklists

Apollo crews wore their checklists on their wrists. Not because they did not know the steps, but because knowing is not enough at three in the morning with an alarm going off.

## The shared book

The flight plan was edited from two ends, 380,000 km apart, by people reading changes aloud and writing them in by hand.

## Ending

A memo written so that nobody would ever have to read it.
`,
  `# Notes in the space race

The photograph everyone knows shows Margaret Hamilton beside a stack of paper as tall as she is. It is usually read as a picture of code. It is just as much a picture of notes: listings printed so people could read them, argue with them and write in their margins.

This essay is about those notes, and what they can teach anyone choosing a notes app today.

## Checklists

Apollo crews wore their checklists on their wrists. Not because they did not know the steps, but because knowing is not enough at three in the morning with an alarm going off. A checklist puts memory where two people can see it. See [[Checklists as external memory]].

## The shared book

The flight plan was edited from two ends, 380,000 km apart, by people reading changes aloud and writing them in by hand. It was the most reliable shared document of its time, and it ran on voice. See [[The flight plan as a shared notebook]].

## The loop

Every word on the air-to-ground loop was recorded. The best notes of the program were a side effect of talking in one place. See [[CAPCOM and the spoken log]].

## Ending

In July 1969 a speechwriter wrote the statement for a landing that went wrong, and filed it. It is a note written so that nobody would ever have to read it. See [[In Event of Moon Disaster]].
`
]
