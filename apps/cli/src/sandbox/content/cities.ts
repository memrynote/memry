// City notes under Travel/Cities. Every one carries an Unsplash cover photo
// (see assets/manifest.json for source and licence).
import type { AssetName } from '../context.ts'
import type { NoteSpec } from '../specs.ts'

interface City {
  key: string
  title: string
  emoji: string
  asset: AssetName
  photographer: string
  profile: string
  focus: number
  created: number
  modified: number
  body: string
}

const cities: City[] = [
  {
    key: 'c-istanbul',
    title: 'Istanbul',
    emoji: '🕌',
    asset: 'photo-istanbul.jpg',
    photographer: 'Engin Yapici',
    profile: 'https://unsplash.com/@yapici',
    focus: 55,
    created: 40,
    modified: 3,
    body: `Four days, split between the old city and Kadıköy.

## Must do

- Ferry from Eminönü to Kadıköy at sunset, simit in hand
- Hagia Sophia early, before the tour groups
- Balat's coloured houses, then lunch in Fener
- Grand Bazaar, but the side streets around it are better

## Eat

| Place | What |
| --- | --- |
| Çiya Sofrası | Anatolian stews, Kadıköy |
| Karaköy Güllüoğlu | Baklava, go hungry |
| Balıkçı Sabahattin | Fish, book ahead |

> [!tip]
> Get an Istanbulkart at the airport. It works on ferries, trams and the metro.
`
  },
  {
    key: 'c-tokyo',
    title: 'Tokyo',
    emoji: '🗼',
    asset: 'photo-tokyo.jpg',
    photographer: 'Denys Nevozhai',
    profile: 'https://unsplash.com/@dnevozhai',
    focus: 50,
    created: 38,
    modified: 5,
    body: `A week, based in Shibuya. Day trip to Kamakura if the weather holds.

## Neighbourhoods

- Shimokitazawa for records and vintage
- Yanaka for the old Tokyo feel
- Golden Gai after dark, tiny bars, cover charges

## Eat

- [ ] Standing sushi at Uogashi Nihon-Ichi {check}
- [ ] Tsukemen at Fuunji {check}
- [x] Konbini breakfast, every morning {check}

> [!note]
> Suica on the phone covers trains and most konbini.
`
  },
  {
    key: 'c-new-york',
    title: 'New York',
    emoji: '🗽',
    asset: 'photo-new-york.jpg',
    photographer: 'Luca Bravo',
    profile: 'https://unsplash.com/@lucabravo',
    focus: 45,
    created: 36,
    modified: 8,
    body: `Long weekend. Walk everything, subway the rest.

## Plan

1. Brooklyn Bridge at dawn, walking toward Manhattan
2. The High Line, then Chelsea Market
3. The Met on Friday night, open late
4. Bagels in the East Village, pizza in Brooklyn

## Notes

- OMNY: tap a card at the turnstile, no MetroCard needed
- Tip 20 percent
`
  },
  {
    key: 'c-berlin',
    title: 'Berlin',
    emoji: '🐻',
    asset: 'photo-berlin.jpg',
    photographer: 'Florian Wehde',
    profile: 'https://unsplash.com/@florianwehde',
    focus: 50,
    created: 33,
    modified: 10,
    body: `Three days, staying in Kreuzberg.

## See

- Brandenburg Gate and the Reichstag dome (book the dome online, it is free)
- East Side Gallery along the Spree
- Tempelhofer Feld on a bike
- Museum Island, pick two museums, not five

## Eat

- Döner at Mustafa's, expect a queue
- Currywurst at Curry 36

> [!warning]
> Many places are cash only. Carry some euros.
`
  },
  {
    key: 'c-lisbon',
    title: 'Lisbon',
    emoji: '🚋',
    asset: 'photo-lisbon.jpg',
    photographer: 'Aayush Gupta',
    profile: 'https://unsplash.com/@aayush_gupta',
    focus: 55,
    created: 30,
    modified: 12,
    body: `Spring trip. Hills everywhere, comfortable shoes.

## Plan

- Tram 28 early, before it fills up
- Miradouro da Senhora do Monte for sunset
- Day trip to Sintra by train from Rossio
- Belém for pastéis, then the monastery

## Eat

- Pastéis de Belém, eat them warm
- Time Out Market for an easy lunch
- Bifana at O Trevo
`
  },
  {
    key: 'c-kyoto',
    title: 'Kyoto',
    emoji: '⛩️',
    asset: 'photo-kyoto.jpg',
    photographer: 'Cosmin Georgian',
    profile: 'https://unsplash.com/@cosmingeorgian',
    focus: 50,
    created: 37,
    modified: 4,
    body: `Three days after [[Tokyo]], Shinkansen from Shinagawa.

## Temples

- Fushimi Inari at 7, before the crowds
- Kiyomizu-dera, then down through Sannenzaka
- Arashiyama bamboo grove, then the monkey park

## Eat

- Nishiki Market for a grazing lunch
- Kaiseki dinner one night, book weeks ahead
`
  }
]

export const cityNotes: NoteSpec[] = cities.map((city) => ({
  key: city.key,
  title: city.title,
  folder: 'Travel/Cities',
  tags: ['travel', 'city'],
  emoji: city.emoji,
  assets: [city.asset],
  created: city.created,
  modified: city.modified,
  cover: (b) => ({
    cover: b.ref(city.asset),
    coverFocus: city.focus,
    coverCredit: `${city.photographer} on Unsplash`,
    coverCreditUrl: city.profile
  }),
  body: () => city.body
}))
