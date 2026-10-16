# Evernote on YouTube: what they say, how they say it, what they show, and what memrynote should take

Channel: @evernote, 147k subscribers, 328 videos and 27 Shorts since 2014, 26 playlists. Analysis date: 2026-10-16.

## Sources and caveats

- **Numbers** come from `analyze_meta.txt` (exact dates, 118 Evernote items with full metadata: 91 videos, 27 Shorts) and `stats.txt` (flat list of all 328 videos). Dates before Oct 2022 come from the flat list's "N years ago" field and are accurate to about ±1 year. Every table below that uses a year bucket for 2014-2022 inherits that error.
- **Transcripts** were read in full for all 11 benchmark videos that have one. `_uq1AoQEPkI` (August 2026 recap) came back as a machine-translated Chinese track, so I used it for structure and timing only; its words-per-minute figure is excluded, and its quotes are back-translations, marked as such. `TOX13wrW7sA`, `qNKgLl55D5I` and `nKGqKb1E6bQ` have no transcript, and their metadata shows no auto-captions, which means no speech: they are music-only.
- **Visuals**: I looked at all 28 contact sheets (14 benchmark videos), all 5 thumbnail sheets, a 640x360 composite of 6 thumbnails (`thumb6.jpg`), our `ours_sheet.jpg`, and 6 of our QA stills at full size. Notes I wrote while viewing are in `notes_visual.md`. Storyboard frames are 320x180, so small UI text and small lower-third text are not legible in them.
- **Paid promotion**: Evernote's median like ratio is 2.12% (videos above 500 views). Videos with high view counts and like ratios of 1.0-1.8% are marked "probably promoted". Absolute like and comment counts are harder to buy than views, so I use them as the organic proxy wherever a conclusion would otherwise rest on promoted views.
- **"Most replayed" heatmaps** exist for 15 videos. A heatmap measures relative replay and seek intensity, not retention. A trough means viewers skip that part; a peak means they jump to or re-watch it.
- **Comments**: 3 opencli calls, on `g_XaFnt_AeE` (Tasks launch), `ewHqC5gjQhc` (Spaces 101) and `0let_BX8ahM` (v11 launch). Each returned the top 20 comments even though I asked for 100.
- **Playlist membership** is not in the data (the TSV has names only). Where I say which videos belong to a playlist, I inferred it from series labels in titles and thumbnails, and I say so.

---

## 1. Formats and series

### 1.1 The format table (all 118 items with full metadata, Oct 2022 to Oct 2026)

"Organic median" drops items with a like ratio under 1.5% and more than 8k views. For monthly recaps that cut is too lenient: the 2024-25 recaps at 1.6-1.8% with 60-80k views are also probably promoted, so see the recap baseline below the table.

| Format                                                                               | n   | Active               | Typical length (median, range) | Median views | Organic median    | Median likes | Median like % | Comments per 1k views | Cadence                                                      |
| ------------------------------------------------------------------------------------ | --- | -------------------- | ------------------------------ | ------------ | ----------------- | ------------ | ------------- | --------------------- | ------------------------------------------------------------ |
| Monthly recap ("What's new" / "<Month> recap")                                       | 24  | Apr 2024 to Sep 2026 | 5:34 (4:12-10:44)              | 50,258       | ~6-8k (see below) | 662          | 1.69          | 3.5                   | median gap 33 days; uploaded 1-14 days after the month ends  |
| Half-year recap ("110 improvements", "115+ improvements")                            | 2   | Jul 2025, Jul 2026   | 9:21 (6:06-12:36)              | 28,993       | 15,802            | 528          | 2.13          | 3.2                   | yearly, replaces the June recap                              |
| Version launch package (v11)                                                         | 4   | Oct 2025 to Jan 2026 | 1:06 (0:29-8:12)               | 7,889        | 6,137             | 176          | 2.13          | 3.5                   | one-off: teaser, 8-min keynote, 1-min hype, 1-min brand film |
| PM feature walkthrough (product lead on PiP, raw screencast)                         | 3   | May to Dec 2024      | 4:26 (4:09-6:59)               | 17,236       | 12,080            | 456          | 2.65          | 7.7                   | per major feature                                            |
| Deep dive ("101", "explained", "ultimate guide")                                     | 3   | Apr 2025 to Apr 2026 | 8:58 (6:48-11:27)              | 18,164       | 18,164            | 353          | 1.94          | 2.5                   | about every 6 months                                         |
| Behind the scenes and Q&A (AI search BTS, Mobile Home design, Ask Federico Anything) | 3   | Oct 2023 to Oct 2025 | 10:12 (3:46-11:33)             | 5,449        | 5,414             | 207          | 2.86          | 6.1                   | irregular                                                    |
| Persona use-case story (Rebecca's trip, Liv's Italian)                               | 2   | Jul and Oct 2026     | 3:39 (3:29-3:49)               | 4,516        | 4,516             | 158          | 3.42          | 3.0                   | new, about bi-monthly                                        |
| Short feature clip, 2026 ("Product Updates")                                         | 25  | Mar to Oct 2026      | 0:45 (0:11-1:57)               | 2,116        | 2,079             | 69           | 2.68          | 3.3                   | near-weekly Mar-Jun (9 in April), then about 2 a month       |
| Short feature clip, 2025 (silent, "Tutorial \| ...")                                 | 13  | Mar to Dec 2025      | 0:36 (0:14-1:00)               | 1,769        | 1,728             | 37           | 1.84          | 2.6                   | 7 uploaded on one day (2025-03-04), then sporadic            |
| Expert collabs and webinars ("feat. Vlad Campos", 55-min ADHD webinar)               | 7   | Oct 2022 to Feb 2023 | 15:31 (5:43-55:01)             | 6,700        | 6,161             | 160          | 1.95          | comments off          | weekly in autumn 2022, then stopped                          |
| How-to, 2022                                                                         | 4   | Nov 2022 to Jan 2023 | 2:11 (0:58-5:19)               | 8,674        | 7,096             | 152          | 1.39          | comments off          | stopped                                                      |
| Shorts, 2021 (help-center screen recordings)                                         | 20  | Mar to Jul 2021      | 0:47 (0:29-1:00)               | 3,310        | 2,880             | 61           | 1.73          | comments off          | burst                                                        |
| Shorts, 2022-23                                                                      | 3   | 2022-2023            | 0:50                           | 5,149        | 5,149             | 96           | 1.78          | comments off          | rare                                                         |
| Shorts, 2025-26                                                                      | 4   | Mar 2025 to Sep 2026 | 0:39 (0:19-1:23)               | 3,770        | 2,034             | 76           | 1.97          | 1.5                   | rare (2 in the last 12 months)                               |

**The organic monthly-recap baseline.** The same recap template with the same thumbnail style swings from about 6k to 91k views, depending on what looks like promotion:

| Recap                                          | Views  | Likes | Like % | Comments | Reading                                                       |
| ---------------------------------------------- | ------ | ----- | ------ | -------- | ------------------------------------------------------------- |
| Aug 2024                                       | 7,855  | 313   | 4.0    | 64       | unpromoted                                                    |
| Sep 2024                                       | 91,401 | 1,172 | 1.3    | 189      | probably promoted                                             |
| Jan 2025                                       | 6,132  | 340   | 5.5    | 56       | unpromoted                                                    |
| Aug 2025 ("plus something BIG coming soon 🤫") | 60,733 | 1,399 | 2.3    | 191      | at the median like ratio, so mostly organic, possibly boosted |
| May 2026                                       | 6,198  | 240   | 3.9    | 65       | unpromoted                                                    |
| Jul 2026                                       | 5,823  | 211   | 3.6    | 50       | unpromoted                                                    |
| Aug 2026                                       | 8,419  | 200   | 2.4    | 42       | unpromoted                                                    |

**Conclusion:** Evernote's organic monthly-recap audience has held at about 6-8k views, 200-340 likes and 40-65 comments since 2024, which is roughly 5% of the subscriber count. The 40-90k recaps of 2024-25 (like ratios of 1.1-1.8%) were almost certainly promoted, and in 2026 the promotion appears to have stopped.

**Where 2026 views came from** (Nov 2025 to Oct 2026, 355k views in total): short clips 110k (31%, though 52k of that is three probably promoted clips at 1.0-1.1% likes), monthly recaps 96k, the v11 launch package 86k (75k of it the probably promoted keynote), deep dives 35k, the half-year recap 16k, persona stories 9k, Shorts 3.7k.

### 1.2 What each format is

- **Monthly recap.** A presenter walks through 6-15 changes from the past month, one chapter per change. 2024: Federico Simionato (product lead), titled "What's new at Evernote? 💜 April 2024". From Feb 2025 the titles lead with features ("Spaces, AI Edit, attachment sync (and more!) 💚 February 2025 recap"). 2026: Tara and a second presenter, seasonal emoji ("🌻 August 2026"), and a "Coming soon" chapter at the end. The recaps get longer each year: median 4:50 (2024), 5:48 (2025), 7:42 (2026). 20 of 24 have uploaded human English captions.
- **Half-year recap.** One presenter's "favorites" out of 100+ changes, grouped into 4 "Chapter N:" blocks with designed chapter cards (`MrDkQYTy510`: 24 YouTube chapters, 12:36). It is the best organic long-form of 2026 (15.8k views, 2.8% likes, 444 likes).
- **Version launch (v11, Jan 2026).** A package of four videos: a 0:29 "Coming soon: 3 exciting new AI features" teaser (Oct 2025), an 8:12 keynote with the product lead on camera, a 1:05 hype clip ("Evernote v11 is here! 🚀⭐🔥💥") and a 1:07 brand film ("A brand new chapter for Evernote"). An "Ask Federico Anything" Q&A (Oct 2025) and the November recap ("V11 preparations, ...") preceded it.
- **PM walkthrough (2024).** The product lead shares his screen with a round webcam PiP and talks through a new feature and the design reasoning behind it ("New Evernote Tasks experience—something for every workflow!", "Evernote sync is now 3x faster!", "Customization—your Evernote, your way!"). It has the highest comment density of any format (7.7 per 1k views).
- **Deep dive / "explained" / "ultimate guide" / "101".** One feature area taught end to end: what it is, when to use which variant, step-by-step how-to, use cases. Examples: "How to: Get organized with Evernote Spaces" (Spaces 101, 11:27), "The ultimate guide to AI Assistant in Evernote 🚀" (8:58), "🔍 How to find and remember anything with Search: ..." (6:48). None of the three trips the promotion heuristic. They are Evernote's evergreen tutorials.
- **Behind the scenes and Q&A.** A 2019-21 series of 15+ "Behind the Scenes" videos survives in the BTS playlist. Since 2023 the format has turned into product-team transparency: "Behind the Scenes: AI-Powered Search (and more!)" (2023), "How we designed the new Evernote Home on Mobile 🏡" (a slide deck of 9 tested variants, 311k views at 1.2% likes, so promoted), and "Ask Federico Anything (AFA): 11 questions about v11 and beyond" (10.6 comments per 1k views, the highest in the 3-year set).
- **Persona use-case story (new in 2026).** A creator-style film of one real person's system: "✈️ How to use Evernote for travel: Rebecca's last-minute holiday to Mallorca" (3:29, 4.4% likes, the highest like ratio of any 2026 video over 3 minutes) and "🌎 How to use Evernote for language learning: Liv's Italian study system" (3:49). They are shot on camera at home, cut fast and spoken at about 225 wpm.
- **Short feature clip ("Product Updates", 2026).** 0:11-1:57, horizontal, in the Videos tab. A product film of one feature, usually music-only (17 of 25 have no speech). It works as the release note for one change.
- **Shorts.** 20 vertical help-center screen recordings in 2021 ("Enable Dark Mode on the Evernote mobile app"); then a trickle, among them a 4:5 ad creative ("Make Evernote your new thinking partner💡", 1080x1350), a vertical product film (AI Assistant on mobile) and a UGC student talking head with burned-in captions ("Lock in for your next lecture...").
- **Legacy formats**: brand ads (the Web Clipper ads of 2014-15, 0.5-1.4M views), Business launch promos (2018), the "Ever Better Challenge" campaign (2019, 190k), a help-center flood (2021: "Level Up" tips, the Home widget, Calendar, security and support), the 2021 "Evernote Workflow" series ("Create a CRM in Evernote", 18k), the 2022 "Tasks Workflow 1-7 of 7" series, and expert collaborations and webinars (2022-23).

### 1.3 How the 26 playlists organize the work (membership inferred from series labels)

| Group                      | Playlists (TSV order)                                                                                                                                                                                                              | Likely contents                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current series             | **Evernote v11**, **Weekly product updates**, **Monthly updates**, **Evernote 101**                                                                                                                                                | The v11 launch and v11 deep dives (their thumbnails carry the pill "Evernote v11"); the 2026 clips (thumbnail pill "Product Updates"); the recaps (pill "Monthly Recap"); beginner and "101" explainers |
| Skill ladder               | Learn the Evernote basics → Level up those Evernote skills → Helpful Evernote Hacks → From the Experts → Evernote Certified Expert Education                                                                                       | 2021 how-tos and "Level Up - ..." tips, then the 2022-23 expert collaborations ("EXPERTS EXPLAIN" badge)                                                                                                |
| Product area               | Master Tasks in Evernote, Search smart in Evernote, Connect Evernote and Google Calendar, Feel at Home in Evernote, Clip content straight to Evernote, Evernote for Desktop: Tips & Tricks, Use Evernote everywhere, Scannable app | The 2021-22 help-center videos, grouped by feature                                                                                                                                                      |
| Workflow series (numbered) | Tasks Workflow: Take actions with your meeting notes; Evernote Teams Workflow: ...; Connecting Remote Teams with Evernote; Workflow: Inspiration & Tips                                                                            | "Tasks Workflow N of 7", "Connecting Remote Teams Series N of 6", "Evernote Workflow"                                                                                                                   |
| Audience                   | Evernote Business QuickStart Basics                                                                                                                                                                                                | Business and team onboarding (2019)                                                                                                                                                                     |
| Support                    | Evernote: Support & Troubleshooting                                                                                                                                                                                                | Sync, passwords, 2FA, account reactivation (2021)                                                                                                                                                       |
| Brand                      | Evernote Behind the Scenes, Evernote Stories, Evernote software                                                                                                                                                                    | BTS 2019-21, customer stories (2018-19), old brand films                                                                                                                                                |

**Pattern:** the series pill on each 2026 thumbnail names a playlist ("Product Updates" ↔ Weekly product updates, "Monthly Recap" ↔ Monthly updates, "Evernote v11" ↔ Evernote v11), so thumbnail, title and playlist reinforce each other. Judging by the series labels on recent videos, only the 4 "current series" playlists still get new videos; the other 22 look like archive.

### 1.4 What performs best organically

Ranked by organic signals (absolute likes, like ratio and comments per 1k views), not by views:

1. **Candid product-team formats** win on engagement. AFA Q&A (3.8% likes, 10.6 comments per 1k), unpromoted recaps (3.6-5.5% likes, 8-10.5 per 1k), "Evernote sync is now 3x faster!" (5.0% likes, 7.7 per 1k), and the Tasks walkthrough (2.6% likes, 8.0 per 1k, 138 comments).
2. **Deep dives** win on durable reach: 17-21k views each with no promotion signal and 317-498 likes. Their audience asks for more of them: "These type of videos are very helpful. I would like to see a video on search practices with and without AI" (12 likes, on Spaces 101). Evernote made that exact video a year later (`12IzxOiku-Q`).
3. **The half-year recap** is the best 2026 long-form: 15.8k views, 2.8% likes, 444 likes.
4. **Persona stories** have the best like ratios (2.4-4.4%) and small reach (4-5k views).
5. **Short clips** reach about 2.1k views and 69 likes each. The top organic ones cover core document features, not AI: PDFs (8.3k), Mermaid diagrams (4.8k), AI Prompts (4.2k), tables (3.7k), search results (3.6k). Clips with "AI" in the title have a median of about 1.9k views against about 2.2k for the rest (promoted clips excluded, small n).
6. **Shorts** do worst: 1.7-2.0k views in 2026, with 147k subscribers behind them.

### 1.5 How the strategy changed, 2014 to 2026

| Era       | Uploads        | What they made                                                                                                                                                              | Signal                                                                                                                                          |
| --------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 2014-2015 | 4              | Web Clipper ads (about 1 min)                                                                                                                                               | 0.5-1.4M views, paid                                                                                                                            |
| 2018      | 12             | Business/Spaces launch promos, template tutorials, brand films                                                                                                              | the "How to Use Templates" tutorial reached 61k                                                                                                 |
| 2019-2020 | 28             | "Behind the Scenes" series during the v10 rebuild (4-20 min, CEO interviews)                                                                                                | 8k-101k; transparency during the rewrite                                                                                                        |
| 2021      | ~143           | Help-center flood: about 32 "Level Up" tips, 20 vertical Shorts, numbered workflow series; comments disabled                                                                | median ~4.7k views; most "Level Up" videos under 3k; search-intent titles like "Set a passcode to lock your Evernote mobile app" (23k) did best |
| 2022      | ~50            | Tasks Workflow series, "feat." expert collaborations, a 55-min ADHD webinar, back-to-school, "Experts explain" thumbnails                                                   | median ~3.9k; "How to use Evernote to organize your weekly tasks" (13 min) reached 79k                                                          |
| 2023      | 5 (+2 Shorts)  | Near silence after the ownership change (Bending Spoons; background knowledge, not from the data). Comments turned on from 2023-10-11                                       | AI search BTS and clips                                                                                                                         |
| 2024      | 13             | Monthly "What's new at Evernote?" recaps start (Apr 2024), with the product lead on PiP; design BTS; feature walkthroughs; cream/serif brand                                | about 7-17k organic (Aug recap, sync, Tasks), 40-311k promoted                                                                                  |
| 2025      | 27 (+2 Shorts) | Recaps with feature-led titles, silent clips, Spaces 101 deep dive, AFA, v11 teaser; 4K masters from Dec 2024                                                               | recaps still promoted until about Sep 2025                                                                                                      |
| 2026      | 38 (+2 Shorts) | v11 launch and new brand system, weekly "Product Updates" clips, recaps with Tara, half-year recap, "explained" and "ultimate guide" deep dives, persona stories, UGC Short | about 2-20k per video; promotion largely gone after the launch                                                                                  |

**The direction of travel:** from ads and a help-center archive with comments switched off, to a product-team voice that treats comments as a feedback channel (Evernote pinned "Got an idea for Evernote? ... share feedback → bit.ly/evernote-feedback" under the v11 keynote). In 2026 it added a layer of short clips and creator-style use-case stories on top of that voice.

---

## 2. Script anatomy per format

### 2.1 Hooks: the first 15-30 seconds

| Video                        | Format         | Opening words                                                                                                                                                                                                                                                                                                     | Hook type                                                                          |
| ---------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `0let_BX8ahM` v11 launch     | keynote        | "Today I'm very, very excited to announce Evernote v11. It's here, you can go download it and I'm taking you through all the major new features that are there. This is the first major release, since v10, which was released in 2020."                                                                          | news plus scale                                                                    |
| `MrDkQYTy510` half-year      | recap          | "Hey guys, it's Tara. I am going to take you through my favorite new features and improvements in Evernote since January. ... in total, since January, we've released actually over 115 new features and improvements. So there's no way I'm going to take you through all of those today."                       | personal curation plus a big number                                                |
| `_uq1AoQEPkI` Aug 2026       | recap          | (back-translated) "Hi everyone, it's me, Tara. I'll show you all the new features and improvements in Evernote from August 2026. Let's go straight to the new features in the editor." Demo at 0:12.                                                                                                              | straight to the agenda                                                             |
| `12IzxOiku-Q` Search         | deep dive      | "Hey everyone, this is Tara. Today I'm going to take you through all the different ways you can use search in Evernote. It might sound basic, but there's actually quite a lot of ways you can search nowadays ... So let's jump into this notebook where I've been saving lots of notes about film photography." | topic plus a "you probably don't know all of this" claim, then a personal scenario |
| `wDJ1_adg-CI` AI guide       | deep dive      | "In this video, we'll walk you through the AI assistant, a brand new feature introduced in Evernote version 11 ... So, let's get started. To open the AI assistant, there are a few different options."                                                                                                           | plain agenda                                                                       |
| `ewHqC5gjQhc` Spaces 101     | deep dive      | "Welcome to Spaces 101. This is a bit of a different video than usual. It's meant to be a guide and an explanation for how Spaces work. ... It's a pretty advanced feature."                                                                                                                                      | the format itself is the promise                                                   |
| `1In2ItR0sLM` Liv            | persona        | "Buongiorno! It's Liv. I've been learning Italian for 5 years, and after a while, I didn't know how to improve anymore. ... Here are my top five ways for learning a language with Evernote."                                                                                                                     | problem first, then a numbered promise                                             |
| `g_XaFnt_AeE` Tasks          | PM walkthrough | "Let's talk about the new Tasks section. I wanted to give you a little overview ... I will not cover all the different features that are in Tasks. You already know about all those."                                                                                                                             | scoped to what is new for existing users                                           |
| `1v_Cyby8g4c` Mobile Home    | BTS            | "Let's talk about the new mobile Home on Evernote. ... I wanted to give you some details about our thought process ... we went through nine different variations that we've tested."                                                                                                                              | process story plus a number                                                        |
| `S5KOo2aIPNE` Customization  | walkthrough    | "Alright! So today we have kind of a different video, it's not the usual monthly recap. We wanted to do a deep dive on customization."                                                                                                                                                                            | 40 s preamble; the heatmap peaks at 0:42, when the demo starts                     |
| `bsLwaZTgj9M` student Short  | UGC            | "If you're still trying to write down everything your lecturer is saying, you're taking notes the hard way. That was basically me in my first month of uni."                                                                                                                                                      | pain point plus confession                                                         |
| **memrynote** tasks-projects | tutorial       | "Here's how tasks and projects work in memrynote. Let's start with capturing a task." (over the title card, 1.6-7.4 s)                                                                                                                                                                                            | plain topic statement                                                              |

**Pattern:** in-house videos open by naming the presenter and the scope ("Hey everyone, this is Tara. Today I'm going to take you through..."). The persona and UGC videos open on a problem the viewer has. The single strongest in-house hook (Search) adds one sentence of "this is bigger than you think" and then a personal scenario.

### 2.2 How long until the first real demo

| Video                 | First app frame                      | First demonstrated action                                 | What fills the gap                                                                                  |
| --------------------- | ------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| v11 launch (8:12)     | 1:15                                 | 1:22 ("You'll notice this new button here")               | 70 s of the product lead on camera: history, "I personally joined Evernote in 2023", "second brain" |
| Half-year (12:36)     | about 0:50                           | 0:53 What's New page; 1:31 first feature (callout blocks) | intro over a "v11 features" card                                                                    |
| Aug 2026 recap (8:14) | 0:12                                 | 0:15                                                      | a 3 s logo sting and one line                                                                       |
| Search (6:48)         | 0:20                                 | 0:50 (first search)                                       | about 10 s of the presenter full-frame, then scenario setup on screen                               |
| AI guide (8:58)       | about 0:25-0:30                      | about 0:30 (the open AI panel)                            | a full-frame presenter shot (0:15) under the agenda sentence                                        |
| Spaces 101 (11:27)    | 0:00 (window on canvas)              | 4:05 (create a space)                                     | 4 min of concept slides: notebooks vs stacks vs spaces                                              |
| Liv (3:49)            | 0:22                                 | 0:22                                                      | problem and promise to camera                                                                       |
| Tasks (4:26)          | 0:00                                 | 0:32                                                      | talking over the screen                                                                             |
| Customization (6:59)  | 0:00                                 | 0:49                                                      | 42 s preamble; most-replayed moment at 0:42                                                         |
| Student Short (1:23)  | 0:11                                 | 0:11                                                      | pain-point hook                                                                                     |
| PDF clip (1:40)       | 0:03                                 | 0:05                                                      | logo sting                                                                                          |
| **memrynote** (2:15)  | ~7.6 s (card morphs into the window) | ~9-10 s (typing in the capture bar)                       | title card and intro line                                                                           |

**Retention evidence:** the v11 keynote's heatmap sits at 0.00-0.02 from 0:24 to 0:49 (the "I joined Evernote in 2023 ... rebuild strong foundations" talking head) and climbs to a local peak of 0.52 at 1:23, the first demo. The Customization heatmap's global maximum (1.00) is at 0:42, the first second of the demo after the preamble. Viewers seek past intros to the first demo. memrynote's 8 s title card is already shorter than any Evernote long-form intro.

### 2.3 How sections are introduced and chained

- **Ordinal signposts** (keynote): "The first major feature is called AI assistant" (1:11) → "The second main feature of v11 is called Semantic Search" (3:51) → "The third new feature in Evernote v11 is AI Meeting Notes" (5:31).
- **Grouped chapters with cards** (half-year): "Chapter 1: Writing, formatting, and navigating your notes" ... "Chapter 4: Evernote on your phone (or tablet!)", each with a full-frame chapter card (a green pill "✦ Evernote on your phone" on a cream canvas with organic shapes, 10:05).
- **Callback bridges** (Tara): "And speaking of the insert menu and slash commands, ..." (2:06); "So you've got a little flavor of what AI assistant can do there. But let me now take you through my favorite new features ... to do with AI" (6:28).
- **Escalation bridges** (Search): "Starting with the most basic type of search" (0:42) → "But what if I don't know the exact word ...? ... that's where semantic search comes in" (1:32) → "All right, now let's take a look at how quick answer works" (3:34) → "Okay, let's take it a step further" (4:18) → "There's two more quick things" (5:48). Each section answers a limit of the one before.
- **Rhetorical-question bridges** (AI guide), delivered to camera: "Have you ever needed to quickly retrieve something from your notes?" (0:34), "What if you could tag, move, and merge notes together all with one simple action?" (3:01), "Do you ever wish you could just ask what's on your schedule?" (5:16), "Do you want answers that go beyond what's just in your notes?" (6:10).
- **The agenda as a product artifact** (Aug 2026 recap): the month's list is itself an Evernote note ("😎 August 2026") with one toggle per area. The presenter returns to it between sections (0:15, 0:25, 1:05, 5:45-6:35), and the "Coming soon" list is a toggle in the same note (7:25). The Tabs clip does the same at small scale: the demo note "Multi-tab is here 🤩" contains the how-to text.
- **Slide progress** (Spaces 101): a tab row "Notebooks | Stacks | Spaces" with the active concept underlined stays on screen through the concept section.

### 2.4 How features are explained

Four recurring patterns:

1. **Need → demo → name it → one-sentence definition** (Tara's Search deep dive). The need: "I'm about to head out and shoot another roll. So I want to remember what I thought of last time." Then the demo. Then the definition: "So that's keyword search or basic search. It's when the words that you type in the search bar are the words that you're looking for in the content" (1:02-1:16). Next comes the limit that sets up the next feature: "But what if I don't know the exact word ...?"
2. **Problem/status quo → "With X, this changes" → example** (keynote): "Now, this is one of the oldest feature requests that Evernote has ever gotten. What it does is pretty easy to understand. So if you search for something, currently, Evernote only finds notes that contain that specific sentence or word inside the note. With Semantic Search, this changes. So let's look at an example." (3:54-4:16)
3. **A story-shaped demo first, the summary after** (keynote): a Barcelona trip runs through the whole AI Assistant demo, then comes the recap to camera: "Basically you can do four main things with AI Assistant. You can search and retrieve content ... make requests based on the current note ... execute tasks ... run web searches" (3:15-3:48).
4. **Design rationale by workflow** (PM walkthroughs): "Some people just need a list of tasks. And for them, My Tasks is perfectly fine. For some people, we do need the differentiation between projects ... And some people really like thinking about dates" (Tasks, 3:49-4:14). "Metadata is basically a fancy word to highlight that there are two new things that you can do with tasks" (0:53).

**Benefit or use case first?** Use case first in almost every case. The benefit is stated after the demo ("I hope this is going to help you have much more focused meetings, less manual notetaking", 7:07) or in the description. The demo data is always a personal story: Barcelona trip, film photography ("Roll 7: Yes Star 200", serial number of a Pentax ME Super), "Life HQ", "Summer 2026 plans", kitchen renovation, "Voice note from Nonna - making chai", Italian lessons ("Lezione Italiano - Passato Remoto - Prof. Rossi").

### 2.5 Recaps, CTAs and outros

- **Mid-video recaps:** a verbal list after a demo (the keynote's "four main things"), a comparison table ("So summarize. This is a nice table ... We also have a blog post with it", Spaces 3:51), or a definition sentence (Search).
- **Mid-video CTAs:** pointers to other assets, not asks for likes. "be sure to head to our blog to read more about all of the improvements" (half-year, 0:36); "find out all about that in the dedicated demo we made about AI assistant that will also be linked down in the description" (Search, 5:32).
- **End CTAs** almost always ask for feedback or a topic:
  - "Let us know in the comments if there's anything that you're missing. If you want to find out more about any particular feature, if you want a particular kind of video, your guys's feedback ... really, really drive how we push Evernote forward" (half-year, 12:05).
  - "Let me know if this was helpful. Let me also know if you'd like to see this type of video for other parts of Evernote ... just let us know in the comments and we will try to make another video for those" (Spaces, 11:04).
  - "Let me know what you think about the new Tasks section in the comments. And let me know if there are things that we should add" (Tasks, 4:17).
  - "Let us know what else you'd like to learn to do in Evernote. Ciao ciao." (Liv)
  - Exceptions: "So make sure you go and update your app" (keynote, 7:55); "Do follow along on YouTube, X, or at evernote.com/product" (Search, 6:31, the only follow ask in long-form); "give us a follow. Don't forget to check the link in our bio for your student discount" (Short, an Instagram CTA reused on YouTube, where there is no bio link).
  - **None of the 11 transcribed videos asks for a like or a subscription.**
- **Outros:** "So we'll see you in the next video. Bye." / "I'll see you next time." / "Thanks for watching this demo ...". Then a white frame with the green elephant and wordmark (2026), or a 15-20 s branded "Thank you!" end card (2024-25, Spaces and Customization), which leaves room for YouTube end-screen elements.

### 2.6 Words per minute

| Video                        | Speaker                      | Words | Duration | WPM over the whole video                       |
| ---------------------------- | ---------------------------- | ----- | -------- | ---------------------------------------------- |
| AI guide                     | unnamed presenter (scripted) | 1,320 | 8:58     | 147                                            |
| Spaces 101                   | Federico                     | 1,830 | 11:27    | 160                                            |
| Customization                | Federico                     | 1,170 | 6:59     | 168                                            |
| v11 launch                   | Federico                     | 1,398 | 8:12     | 170                                            |
| Search deep dive             | Tara                         | 1,177 | 6:48     | 173                                            |
| Half-year recap              | Tara                         | 2,248 | 12:36    | 178                                            |
| Tasks walkthrough            | Federico                     | 802   | 4:26     | 181                                            |
| Mobile Home BTS              | Federico                     | 716   | 3:46     | 190                                            |
| Student Short                | creator                      | 304   | 1:23     | 220                                            |
| Liv persona                  | creator                      | 865   | 3:49     | 227                                            |
| **memrynote tasks-projects** | Kaan's ElevenLabs clone      | 332   | 2:15     | **148** (175 while speaking: 113.6 s of voice) |

**Takeaway:** in-house tutorials run at 147-181 wpm and creator formats at 220-227. memrynote's 148 wpm across the film matches Evernote's tutorial pace, so pace is not where our film differs.

### 2.7 What the heatmaps say viewers want

- **Intros and outros are skipped; demos are revisited.** Keynote: talking-head segments average 0.13 against 0.29 for screen segments (face windows estimated from the storyboard). The "What else is new" list, told on camera without showing it (7:12-7:52), sits at 0.03-0.11.
- **The demo payoff is the peak.** Keynote global maximum at 6:18 (AI Meeting Notes: speaker labels renamed to Sarah and John, then the summary).
- **Recap peaks fall on concrete everyday features**, never on company news: AI Edit (Mar 2024), header links & table of contents (Apr 2024), task metadata on mobile (May 2024), quote/code blocks (Jun 2024), the new sharing flow (Jul 2024), customizable sidebar (Sep 2024), "Title" note view (Oct 2024), accountless collaboration (Nov 2024), AI Transcribe (Dec 2024), slash commands (Feb 2025), search improvements (Jul 2025), boosted audio recordings (Aug 2025). Chapters such as "New Performance team" or "Episode on The Vergecast" never peak. Viewers use chapters as a menu.
- **A slide-deck explainer is flat.** Mobile Home BTS stays at 0.09-0.2 after 0:00, with a small bump at the "Say welcome to the nav bar" reveal (2:29, 0.29).

---

## 3. Voice and tone

### 3.1 Presenters

| Presenter                               | Role (as stated)              | Formats                                                                      | On camera                                                                              | Person                                                    | Delivery                                                                                                              |
| --------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Federico Simionato                      | "Product lead" (descriptions) | 2024-25 recaps, walkthroughs, BTS, Spaces 101, AFA, v11 keynote              | Round webcam PiP (2024-25); full-frame at a MacBook in front of plants for the keynote | "I" for opinions, "we" for the team, "you" for the viewer | Ad-lib, warm, repetitions ("very, very excited" ×3 in the keynote), fillers ("like", "basically", "So, so I can ask") |
| Tara                                    | not stated                    | 2026 recaps, half-year recap, Search deep dive                               | Rounded-square PiP; full-frame only for intro, outro and "coming soon"                 | "I" plus "we"                                             | Semi-scripted, friendly informal phrasing ("Hey guys", "quite the bang", "cuz"), self-aware humor                     |
| Unnamed presenter                       | not stated                    | AI Assistant "ultimate guide" (and apparently the July 2026 recap thumbnail) | Full-frame cutaways at section bridges, PiP otherwise                                  | "we" ("we'll walk you through")                           | Fully scripted, infomercial rhetorical questions, the slowest at 147 wpm                                              |
| Liv, Rebecca (persona), student (Short) | users and creators            | persona stories, UGC Short                                                   | Full-frame at home, hard cuts                                                          | "I" throughout                                            | Fast (220-227 wpm), confessional, slang ("the bane of my existence", "I found the coolest hack")                      |

### 3.2 Register, humor, signature phrases

- **Federico** is candid and engineering-honest: "So let me tell you an anecdote, when we first created the AI Transcribe, we were almost about not to build it because we were observing that very few people were actually recording audio" (5:36); "Intuitively, I agree with them, it makes sense and so we are testing this as well" (Mobile Home, 3:29); "Spaces is probably one of the most unknown ones" (11:13); "So, props to the team". He gets a chapter of his own: "Federico's approach 💚" (Customization, 3:05). Signature phrases: "Let's talk about ...", "Let's go through it together", "Let's look at it together", "So for instance", "Of course".
- **Tara** is personal and lightly self-deprecating: "Welcome to my life HQ"; "I'm going to command click boom it open in a new tab"; "cuz I'm feeling quite lazy" (5:02); "That was a lot of words" (1:32); "which in this case might trip me up a little bit" (live transcript, 8:55). Meta moment: "I'm actually recording these takes here to get a transcript of what I've been saying and easily turn it into subtitles on YouTube" (8:37). Signature phrases: "Hey everyone, this is Tara", "So let's take a look", "pretty cool", "really handy", "I really encourage you to ...".
- **The scripted guide** leans on "Have you ever ...?" / "What if you could ...?" questions and "So, let's get started". It is competent, impersonal and does not name its presenter.
- **Formality**: casual across the board. No jargon without a definition: "OCR stands for optical character recognition" (Search, 4:18); "Metadata is basically a fancy word ..." (Tasks).
- **Scripted vs ad-lib**: Federico's 2024 videos are one-take ad-libs over a screencast ("there's a variety of different workflows ... We need a lot of space because there are very—"). The 2026 videos are edited takes with punch-ins, still in a conversational voice. The creators' videos are scripted in a creator voice.

### 3.3 Plans, pricing and "coming soon"

- **Prices are never named.** Plans appear only as good news: chapter titles "Higher limits in Evernote Free" (Sep 2024), "100mb limit for AI transcription" (May 2025), "Fewer limits for AI Edit" (Jul 2025), and the Short's "student discount".
- **AI optionality is repeated as reassurance** in every AI video: "Don't worry, you can disable each feature individually in your settings, so you always have control of what's enabled in your account" (keynote, 7:21); "All AI features are optional" (AI-on-mobile description); "Control which AI features are active in your account via Settings → AI features" (AI guide description).
- **The silence costs them.** The keynote's top comments are about price: "Canceling the subscription for the first time in 5 years. 250 usd is too much." (71 likes, 10 replies); "what about the price increase that went up to like 150%?" (56 likes); "Will there be a tier without the AI features, for a better price?" (20 likes). See §8.
- **"Coming soon" is a standing segment** that is used to collect demand: "What's coming soon?" (Mar 2024), "Coming soon — iCloud calendar integration" (Jun 2024), "Coming soon (by popular demand)" (Feb 2025), "We're working on something BIG…" (Aug 2025, in the title with 🤫; with 1,399 likes at a 2.3% like ratio it is the best-received recap by like ratio among the high-view ones, behind only Jun 2024 at 1,438 and Mar 2024 at 1,422 in absolute likes), "Stay tuned" (Nov 2025), "Coming soon" (Apr and Aug 2026). The Aug 2026 version (back-translated) asks for input: more table improvements, "if you have any specific requests, let us know"; tags with color coding, "comment below or via the feedback form"; PDF editing; Edit Mode on mobile. **The promise was kept on camera:** the PDF teaser of 2026-09-09 became the PDF clip of 2026-09-18 ("📂 Edit, annotate, and merge PDFs inside Evernote").

---

## 4. On screen

### 4.1 Presenters on camera

- **Keynote (v11):** the product lead, seated medium shot, centered behind an open MacBook, gray hoodie with an Evernote patch, dark background of plants with bokeh. Full-frame for the opening (0:15-1:05), for each feature's "why" (Semantic Search intro 4:15, the anecdote 5:45-6:10) and for the wrap-up (7:10-7:50). During demos he shrinks to a rounded-square PiP at bottom-left, about 20% of the frame height. About half the film is talking head. Pattern per feature: **face (why) → screen (how) → face (so what)**.
- **Tara (2026 recaps, Search):** PiP only during demos, against a plant wall or a warm room with a lamp. Full-frame for at most 10-15 s at the start and end, and for "coming soon" (Aug 2026, 7:10). The half-year recap shows her full-frame only in the outro (12:00).
- **2024 walkthroughs (Tasks, Customization) and Spaces 101:** a circular webcam PiP at bottom-left for the whole video, never full-frame. In Customization the PiP sits over the note-list column and covers live UI.
- **AI guide:** full-frame cutaways of the presenter typing on a laptop beside a cactus, used as section bridges (0:15, 0:40, 3:15, 5:20, 6:15).
- **Persona stories:** the creator full-frame at home (bookshelf, bed, lapel mic), cutting hard to full-frame screen every 4-8 s. No PiP.
- **Lower thirds:** none seen in any storyboard. Names reach the viewer through the spoken intro ("Hey everyone, this is Tara") and the description ("Product lead Federico Simionato ...").

### 4.2 How the screen is recorded

Three generations are visible:

1. **2024 raw screencast.** The app window fills 100% of the frame, with no canvas, no zoom, system modal dims only, and a webcam circle (`g_XaFnt_AeE`, `S5KOo2aIPNE`). The Tasks video was captured at 1446x1080 (about 4:3) and plays pillarboxed. UI text is illegible in the 320 px storyboards and small at 1080p.
2. **2025 slide-deck canvas (Spaces 101).** A cream canvas with a serif heading top-left ("What are spaces?", "Recap: Notebooks"), a tab-row progress indicator, caption boxes for personas ("Cleo and Damien are parents ..."), illustrated stickers, and the app window shrunk to about 50-55% of the frame so it fits beside the text. That last choice makes the UI unreadable.
3. **2026 brand canvas plus punch-ins.** The window sits at about 80-90% of the frame on a white canvas with a brand color strip along the top (yellow, green, purple), or on a black canvas with v11 blobs (AI guide), or on cream with blobs (Search). Every key moment gets a **punch-in of about 2-3x**: the AI prompt popover with "Find everything about my Barcelona trip" (keynote 1:30), the Quick Answer card (5:05), a table being resized (Aug 2026, 1:05), the dynamic-date popover (2:05), the three-dot menu (2:30), the apple image with its AI caption (4:40), the "cardamom" keyword match (5:15), the live-transcript bubble and AI prompt chips (half-year 9:05-9:45). Punched-in text is legible even in 320x180 storyboard frames, which implies text of roughly 30 px or more at 1080p.

Further techniques seen in the 2026 footage:

- **Dimming** the background around a popover (search popovers, the recording bubble at Aug 2026 3:00, modals in Spaces 101).
- **An enlarged cursor** (a custom large arrow) in the 2026 clips and recaps, scaling with the zoom. In the 2024 screencasts the cursor is native size.
- **Highlights** come from the product's own UI (search keyword highlighting, text selection on "Cmd + W" in the Tabs clip). No drawn boxes or arrows on footage, except a hand-drawn arrow on a mobile slide (half-year, 10:25).
- **Text overlays** are rare and carry meaning. In the Search deep dive, green bold definitions centered above the window: "Regular Search: Matches keywords in your notes" (0:55), "Semantic Search: Ranks results based on the meaning of words" (1:45-2:05). Spaces 101 has headings, tabs and caption boxes. There are no burned-in subtitles in long-form; only the UGC Short has them.
- **Demo data** is rich and personal, as listed in §2.4. The PDF clip uses realistic documents ("Halstead Building Services - Quotation", "Meridian Damp & Timber - damp survey"). The AI guide is the exception: long recipe notes shown at window scale, which read as gray blocks.

### 4.3 Motion graphics, brand colors and shapes, cards

- **2024-25 system:** a cream canvas, a thin editorial serif, a geometric green elephant built from colored pieces (blob, flower, stars), "New" pills in purple, and later an illustrated "doodle garden" of smiling suns, flowers and an elephant character. Branded end card: elephant and "Evernote" on cream with a garden of shapes, held about 20 s (Customization 6:40-7:00, Spaces 11:10-11:30 "Thank you!").
- **2026 v11 system:** a white or black canvas; organic blobs in lime, lilac, periwinkle, yellow and orange bleeding off the corners; a lowercase "evernote" wordmark with the green elephant; bold sans; outlined pills; hand-drawn squiggle arrows; 3D iridescent numerals for milestones ("115+").
- **Chapter cards:** Spaces 101 has full-frame cards with an eyebrow label ("How to use spaces:") over a serif title ("Spaces for teams", "Spaces directory", "Permissions, content, and more"), each with its own big colored blob. The half-year recap uses a green pill "✦ Evernote on your phone" on cream with shapes. The Mobile Home BTS uses "The iterations" on black with an orange double-circle blob.
- **Agenda card:** the half-year recap holds a black card with three feature names in big colored type ("AI Meeting Notes", "Semantic Search", "AI Assistant") and a "v11 features" pill while Tara recaps them (0:20-0:40).
- **Intro and outro stings (2026):** a white frame, then the elephant and wordmark centered (about 3 s), and the same at the end (the PDF clip animates the elephant in, then builds the wordmark, about 5 s). No URL and no subscribe card.
- **Transitions:** hard cuts in long-form. The clips use whip pans with motion blur, focus pulls, white flashes, and 3D-tilted windows (PDF clip 0:05, 0:44).

### 4.4 Mobile footage

Long-form never shows raw full-screen mobile. A phone screen or phone mockup is placed on the brand canvas: an iPhone mirror on cream with a shape garden (Customization 3:45-6:30: "let's change the background because now I'm sharing my phone screen"), a phone mockup with a "January-June 2026" pill and a hand-drawn arrow (half-year 10:25-11:40), and a vertical camera-scan screen on cream with blobs (Liv 2:34). The 2021 Shorts are the opposite: raw vertical recordings with tiny UI and a green touch circle, no hook and no design.

### 4.5 Pacing of visual change

"Big changes per min" counts large frame-to-frame differences: cuts, face↔screen switches, dims and card inserts. Zooms on white UI barely register. Compare only within the same step.

| Video                                                         | Step | Big changes per min |
| ------------------------------------------------------------- | ---- | ------------------- |
| Spaces 101 (slides plus window)                               | 5 s  | 0.9                 |
| Customization (raw screencast)                                | 5 s  | 1.1                 |
| v11 keynote                                                   | 5 s  | 1.7                 |
| AI guide                                                      | 5 s  | 1.7                 |
| Half-year recap                                               | 5 s  | 4.2                 |
| Aug 2026 recap                                                | 5 s  | 4.5                 |
| Search deep dive                                              | 5 s  | 6.3                 |
| **memrynote tasks-projects** (same metric, run on our master) | 5 s  | **0.9**             |
| Mobile Home BTS (slides)                                      | 2 s  | 1.9                 |
| Tasks walkthrough                                             | 2 s  | 2.7                 |
| Liv persona                                                   | 2 s  | 10.0                |
| Tabs clip (zooms on white UI)                                 | 1 s  | 0.0                 |
| AI-on-mobile Short (product film)                             | 1 s  | 18.0                |
| PDF clip (product film)                                       | 1 s  | 21.6                |
| Student Short (UGC)                                           | 1 s  | 24.6                |
| **memrynote tasks-projects**                                  | 1 s  | **1.8**             |

**Takeaway:** our film is as visually static as Spaces 101, Evernote's most static long-form. Its only big changes are the title card opening into the window and the window closing into the end card. Evernote's busiest tutorial (Search, 6.3 per min) gets its rhythm from face↔screen cuts, popover dims and punch-ins.

---

## 5. Short-form

### 5.1 The 2026 short feature clips ("Product Updates", 25 videos)

- **What they show:** one feature per clip, in three beats or fewer. Tabs (0:37): open a tab, keyboard shortcuts, a recording kept running in a tab. PDF (1:40): page thumbnails, add a PDF, rotate, annotate, redact, the context menu. Titles name the user outcome: "🔔 Remind your future self with AI Assistant", "📌 Pin tabs for quick access", "🖼️ Wrap text around images in Evernote".
- **How they are made:**
  - 17 of 25 are music-only. Their metadata shows no auto-captions, and the explanation lives either in the demo note itself (the Tabs clip's note "Multi-tab is here 🤩" lists "Click to open a new tab ... Keyboard shortcuts: Ctrl + Cmd + O ..."), in on-screen UI tooltips, or in the description (the Tabs description repeats the same how-to list).
  - 8 have speech, 0:23-1:57 long. The longer ones are walkthroughs with a voice: "🧙 AI Prompts: Turn repetitive tasks into one-click actions" (1:53), "✨ Work with AI Assistant inside notes with Edit Mode" (1:57).
  - Production grammar: product film rather than tutorial. Extreme close-ups on buttons with tooltips ("Add PDF", "Rotate left"), 3D-tilted windows, whip and blur transitions, 2-3x crop-zooms onto the line that matters (the "Cmd + W" selection), an enlarged cursor, 4K masters (3840x2160) in odd aspect ratios (the Tabs clip is 3460x2160), and the logo sting at start and end.
- **Performance:** median 2,116 views and 69 likes. Three clips at 10-21k with like ratios of 1.0-1.1% (tabs, writing on mobile, emojis) were probably promoted. Voiced and music-only clips land the same (median about 2.0k vs 2.1k). Light-thumbnail clips beat dark ones (about 2.3k vs 1.8k), but every dark clip is an AI clip, so topic and style are confounded. The best organic clips are document features (PDFs 8.3k, Mermaid 4.8k, tables 3.7k, search results 3.6k).
- **Role:** they are release notes in video form. They feed the in-app What's New page ("It shows you all of the product update videos, but also the smaller improvements", half-year 0:56) and the recaps reuse their footage. The August recap links the search clip in its description ("🔍 Learn how to spot Keyword matches in Search: https://youtu.be/EqVN2FIvfFM").

### 5.2 True Shorts (27)

| Wave             | n   | What                                                                                                                                                                                                                                                                                                                                                                                             | Views                                                                               |
| ---------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 2021 help-center | 20  | Raw vertical phone recordings with tiny UI and a touch circle; help-article titles ("Enable Dark Mode on the Evernote mobile app", "Level Up: Sort the search results..."); comments off; auto-frame thumbnails                                                                                                                                                                                  | median 3.3k; top two 36.9k and 22.6k at 0.3-0.4% likes (feed drive-by or promotion) |
| 2022-23          | 3   | Calendar notifications; AI-search BTS Q&A ("What is AI-Powered Search? Why did we create it?") and the AI search promo                                                                                                                                                                                                                                                                           | 4.7k-25.5k                                                                          |
| 2025             | 2   | Square (2160x2160) widget clip, 8.5k at 1.1%; a 4:5 (1080x1350) ad creative "Make Evernote your new thinking partner💡", 5.5k                                                                                                                                                                                                                                                                    | both look like reused ads                                                           |
| 2026             | 2   | `nKGqKb1E6bQ` AI Assistant on mobile: vertical product film, phone UI rendered large on a black canvas with blobs, a punch-in every few seconds, music-only. `bsLwaZTgj9M` student: UGC talking head, lime word-by-word captions, vertical crops of the UI at large scale, one deliberately lo-fi phone-filmed laptop shot, CTA "give us a follow ... link in our bio for your student discount" | 1,659 and 2,034                                                                     |

**Takeaways:**

- The same AI-on-mobile content uploaded both ways got 2,569 views as a horizontal clip and 1,659 as a Short. Shorts did not add reach.
- The UGC Short (face, burned-in captions, pain-point hook) did no better than the product film (2.0k vs 1.7k).
- The vertical grammar that does read on a phone is **crop, don't shrink**: the student Short and the AI Short crop the UI so text is huge, unlike the 2021 Shorts, which shrank whole phone screens.

---

## 6. Thumbnails

### 6.1 The template systems, by era

| Era        | System                                                                                                                                                                                                                                                                  | Examples                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 2021       | none (auto frames of screen recordings)                                                                                                                                                                                                                                 | all Shorts                                                                                                       |
| 2022-23    | creator-agency style: saturated flat backgrounds (sky blue, red, yellow, green), heavy all-caps sans, presenter cut-outs with a white stroke, an "EXPERTS EXPLAIN" hexagon badge, a "HOW TO" green label with a cursor and an icon row, "DID YOU KNOW YOU CAN DO THIS?" | "SETTING UP THE ULTIMATE EVERNOTE HOME" (20.5k), "CAPTURING & CONSOLIDATING YOUTUBE RESEARCH" (9.3k, 3.4% likes) |
| 2024       | cream background, thin serif, a "New" purple pill or a blue "2024" chip, a green pencil-note icon, a geometric elephant of colored pieces; no UI and no face on recaps; one fixed recap layout ("September / Monthly / Recap")                                          | identical layout from Jun to Sep 2024: 7.9k (Aug, 4.0% likes) vs 57-91k (other months, 1.1-1.8%)                 |
| 2025       | cream, serif, a doodle garden with feature tags ("Update", "Faster", "Templates"); clips: serif headline left, UI card right, a small gray "New feature" / "Product update" / "Tutorial" label                                                                          | "June 2025 / monthly recap", "Show/hide the note list", "Spaces 101"                                             |
| 2026 (v11) | see 6.2                                                                                                                                                                                                                                                                 | almost every 2026 video                                                                                          |

### 6.2 The 2026 template, element by element (from `thumb6.jpg` and `thumbsheet_1-2`)

1. **Logo:** green elephant plus lowercase "evernote" wordmark, top-left, always.
2. **Headline:** 2-3 lines, left-aligned, bold sans, black on cream or white on black; 3-6 words, verb-led ("Edit, merge, and annotate PDFs", "Collaborate with AI in Edit Mode", "Turn ideas into diagrams", "Transcribe only the audio you need") or "<Feature>, explained" ("Semantic Search, explained").
3. **One highlighted keyword in the product's own text-selection style:** a colored rectangle with round drag handles at two corners ("PDFs" in lilac, "2026" in green), lime text on dark. The highlight is a piece of the product UI.
4. **Series pill**, outlined, bottom-left: "Product Updates", "Monthly Recap", "Evernote v11", "October 2025", "Jan - Jun 2026". It doubles as the playlist name.
5. **Right third:** a cropped UI card (the PDF editor, a search popover with "sunlight on face"), large enough to suggest the screen without being read, or a presenter cut-out (Tara smiling; Federico in sunglasses and a red jacket outdoors), natural photo, no stroke.
6. **A hand-drawn squiggle arrow** pointing at the UI card or the face.
7. **Organic blobs** in lime, lilac, periwinkle and yellow bleeding off the edges.
8. **Light vs dark:** roughly 2:1 light. Dark is used for AI topics (Search explained, AI guide, AI clips).

Exceptions that break the template:

- The half-year recap is only a giant iridescent "115+" with a "Jan - Jun 2026" pill: no words, and the best organic 2026 long-form.
- Rebecca's persona video uses a creator-native thumbnail: her mid-laugh in front of bookshelves, condensed hand-lettered "USING EVERNOTE to PLAN a VERY LAST MINUTE TRIP" in white and lime, and a lime elephant doodle. It has the best like ratio of 2026 long-form (4.4%).
- Shorts use raw frames.

### 6.3 Thumbnail text vs title text

They divide the work. The thumbnail carries the hook in 3-6 words ("Semantic Search, explained"); the title carries the searchable keywords ("🔍 How to find and remember anything with Search: Semantic Search, OCR, Quick Answers, and more"). For recaps the thumbnail is just the month ("August 2026") and the title lists features ("Image searching, better Tables, recording updates, and more 🌻 August 2026").

### 6.4 Which styles correlate with views

- **No template produced views by itself.** Identical 2024 recap thumbnails range from 7.9k to 91k depending on promotion. In 2026, template clips sit at about 1.4-8k regardless of color, keyword or arrow.
- **Faces:** the recaps with Tara or the second presenter cut out (Jul and Aug 2026) got 5.8k and 8.4k. The UI-card recaps (Apr and May 2026) got 17.3k and 6.2k. That is no consistent face effect, and n is tiny.
- **What stands out organically is the format, not the template:** the "115+" numeral (half-year), the creator-style persona thumbnail (best like ratio), and the AFA face thumbnail (most comments per view). Each signals a different kind of video from the weekly stream.
- **Conclusion:** the template buys recognition and series clarity, and only a break from it signals "this one is special". Evernote has no published CTR, so this rests on views and likes only.

---

## 7. Titles, descriptions, chapters

### 7.1 Title patterns

| Format                | Pattern                                                                 | Example                                                                                           | Median length | Emoji                     |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------- | ------------------------- |
| Clip (2026)           | emoji + verb-led outcome + "in/inside Evernote" (optional)              | "📂 Edit, annotate, and merge PDFs inside Evernote"                                               | 49 chars      | 25 of 25 emoji-first      |
| Monthly recap 2024    | question + colored heart + month                                        | "What's new at Evernote? 💜 April 2024"                                                           |               | heart color rotates       |
| Monthly recap 2025-26 | 2-3 features + "and more" + seasonal emoji + month                      | "Tabs, link view options, AI Assistant improvements, and more 🍀 March 2026"                      | 66 chars      | 24 of 24, emoji mid-title |
| Deep dive             | "How to ... : <keyword list>" / "The ultimate guide to X" / "How to: X" | "🔍 How to find and remember anything with Search: Semantic Search, OCR, Quick Answers, and more" | 48 chars      | 2 of 3                    |
| Persona               | "How to use Evernote for <use case>: <Name>'s <specific story>"         | "✈️ How to use Evernote for travel: Rebecca's last-minute holiday to Mallorca"                    | 74 chars      | 2 of 2 emoji-first        |
| Launch                | "Introducing X: How A, B, and C work"                                   | "🐘💡Introducing Evernote v11: How AI Assistant, Semantic Search, and AI Meeting Notes work"      |               |                           |
| Milestone             | number + scope                                                          | "💚 115+ Improvements since v11: Evernote in the first half of 2026"                              |               |                           |
| Q&A                   | named host + count                                                      | "Ask Federico Anything (AFA): 11 questions about v11 and beyond 🚀 October 2025"                  |               |                           |
| Teaser                | curiosity                                                               | "Bulk actions on Mobile, better audio recordings…plus something BIG coming soon 🤫"               |               |                           |
| 2021 help             | literal task                                                            | "Set a passcode to lock your Evernote mobile app" (23k), "Level Up - ..." (mostly under 3k)       |               | none                      |

The 2021 search-intent titles worked because millions of people already search "how to X in Evernote". No evidence in the data shows that emoji help, and the emoji habit only began in 2024-25.

### 7.2 Description layout (2026 standard)

1. **One or two summary sentences that lead with the benefit**, naming the presenter and role where relevant: "Product lead Federico Simionato introduces Evernote v11 and shows ..."; "In this video, Liv shares how she uses Evernote to learn Italian 🇮🇹📖."; "The new PDF editor gives you more control over your documents without leaving your notes."
2. **Optional capability bullets** with emoji (personas: "When it comes to learning a language, Evernote can help you:" plus 5 emoji bullets), or how-to steps (Tabs: "How to open content in a new tab: ... Keyboard shortcuts: ...").
3. **Chapters** (`00:00 Intro` ...), in long-form only.
4. **Clarifications**: "At 04:25, the Command-click shortcut is shown to open a note link in a new tab on Mac. On Windows, use Ctrl-click instead."; availability: "📍 Available on Desktop and Web from version 11.34.8"; AI opt-out: "Control which AI features are active in your account via Settings → AI features."
5. **An invitation** (personas): "Let us know what other types of videos you would like to see next ... 💚".
6. **A link block with emoji labels**: "📈 See the full list of 115+ improvements", "🌐 Read the blog", "📚 Help: http://help.evernote.com", "🔍 Learn how to spot Keyword matches in Search: https://youtu.be/EqVN2FIvfFM", "🧠 Want to go further? Learn how to use AI Assistant in more detail: https://bit.ly/AIAssistantTutorial", "💚 Product: http://product.evernote.com". The launch uses a tracked download link (`bndspn.com/DownloadEvernote`).

Other details:

- **Tags are legacy boilerplate:** 113 of 118 videos carry the same 15 tags, including "windows8" and "presentation". There is no tag strategy.
- **Shorts** put hashtags in the title (#notetaking #productivity #notesapp; #studytips #studentdiscount) and have short or empty descriptions.
- **Comments as a channel:** comments were off on all 2021-22 Shorts and the 2022-23 expert and how-to videos, and on since 2023-10-11 apart from 9 items (five 2025 clips, three Shorts and the Mar 2024 recap). The keynote has a pinned feedback link.

### 7.3 Chapters

- **Coverage:** 45 of 91 long videos. Median 9 chapters. 2026 recaps have 9-15, the half-year recap 24 (with "Chapter N:" group headers of 3-19 s), deep dives 7-8, personas 6, clips none.
- **Naming has evolved:**
  - 2024: nouns ("Native event creation", "Files", "Collapsible sections").
  - 2025: platform prefixes and labels ("[Mobile] Sticky task filters", "New feature! Callout blocks").
  - 2026: verb-led outcomes ("Find objects inside images", "Spot exact Keyword Search matches faster", "Use dynamic dates in templates") and when-to-use guidance in deep dives ("Using Keyword Search when you know exactly what you're looking for", "How Semantic Search lets you search by meaning instead of keywords").
- **Mistakes:** three videos start their list at 00:15 or later, so YouTube inserts "<Untitled Chapter 1>" (Mar 2024, Apr 2024, the v11 keynote).
- **YouTube accepted chapters of 3-9 s** (half-year "Chapter 4: ..." 5 s; v11 "What's in v11" 9 s), so the 10 s minimum in YouTube's help text is not enforced on interior chapters.
- **Heatmap peaks land on chapter starts** (see §2.7). Chapters work as a feature menu.

---

## 8. What viewers ask for and complain about

### 8.1 Tasks launch (`g_XaFnt_AeE`, 2024): switchers and a requirements list

- **Switchers back from task apps:** "As crazy as it may sound, Tasks has brought me back to Evernote" (13 likes), "I finally cancelled my Todist and move back to Evernote" (10; the same comment also asks for snooze, below), "I've moved my tasks from Things" (2), "switching back from todoist" (1), plus Toodledo.
- **Requests, by likes:**
  - "link the tasks to Evernote Calendar so we can time block" (14)
  - "open Tasks in its own window" (11)
  - "Please put tags option in search option! Tag is crutial in evernote and in tasks too" (10, repeated twice more)
  - a "snooze" feature "like all the to-do apps" (10, the Todoist switcher above)
  - "a Kanban-like view" (6)
  - recurring tasks breaking (4)
  - "a Start Date in addition to Due Date, so that a task does not have to be due today to be visible in Today" (3)
  - print Today, hide completed, delete all
- **Praise for candor:** "Thanks for the openess about the stuff you are doing. Really enjoy the recent features you are releasing." (12)

### 8.2 Spaces 101 (`ewHqC5gjQhc`, 2025): wants depth and solo use cases

- "These type of videos are very helpful. I would like to see a video on search practices with and without AI" (12). Evernote made that video a year later.
- "If you can make a video example of how using Spaces for just 1 person can be useful, then I'd love to see that" (14).
- "Can I use Spaces as 'project' as Tiago Forte PARA method" (5): methodology framing.
- "It would be great to have tasks scoped within a Space" (1).
- Praise: "It was very helpful to see some different use cases!", "More like this! Great.", "Great job as usual Federico!" (the presenter is recognized by name), and a timestamped "4:44 Exactly".

### 8.3 v11 launch (`0let_BX8ahM`, 2026): price, AI fatigue, privacy, migration

- **Price:**
  - "Canceling the subscription for the first time in 5 years. 250 usd is too much." (71 likes, 10 replies)
  - "what about the price increase that went up to like 150%?" (56)
  - "Sadly, I do not care for all the AI features if it is going to DOUBLE my subscription cost" (34)
  - "I just checked the cost of Evernote in 2012: 36€ per year!" (5)
- **AI fatigue and privacy:**
  - "I miss 'Evernote Legacy' ... now it's back to being bloated and slow. This IA stuff is not something I want anywhere near my personal notes." (52)
  - "I can't think of any uses for AI in Evernote. I have nearly 4,400 notes ... What I COULD use are much simpler features, such as manipulating tables" (50)
  - "Will there be a tier without the AI features, for a better price?" (20)
  - "I suggest there be an option to mark content as private" (9)
  - "Before you got into AI, you should have fixed the bugs first." (3)
- **Migration intent:** "What's the best service to migrate to? I'm happy to pay a reasonable price, but $250/yr for features I don't need is crazy!" (16); "If they force me to buy only the AI-powered version, I'll switch to the Notion." (8)
- **Loyalists:** "I'm really glad I decided to never switch away from Evernote" (50); "I have AuDHD ... Evernote has been the ONLY constant for me" (25); "The transcription feature has kept me in the EN orbit" (1).
- **Bugs:** Android web clipping fails "50% of them" (3).

### 8.4 What this means

Evernote's audience is long-tenured users who value control, speed, tags, tasks and price. They are tired of AI upsell and some are actively looking for a place to go. Several of their asks in the Tasks thread match features memrynote has already shown or documented (calendar time-blocking was not checked):

- **Start date that keeps a task in Today:** our narration says "Give it a start date as well as a due date, and it shows up in Today every day until it's done."
- **Kanban:** our film has "Switch to the board, and drag a card".
- **Tags on tasks:** "a hash adds a tag".
- **Snooze:** `apps/docs/src/user-guide/snooze-reminders.md`.
- **Opening things in their own tab or window:** `tabs-split-view.md` documents tabs and split view; I have not checked that it covers Tasks specifically.

memrynote also documents an Evernote `.enex` importer (`apps/docs/src/user-guide/import.md`, with stated limits: table-of-contents notes import as plain text, ink is not rendered, internal `evernote:///` links are not resolved, encrypted sections are skipped).

---

## 9. For memrynote

### 9.1 Our film next to Evernote's

Our film is `marketing/tutorials/tasks-projects`: 134.6 s, 1920x1080 at 60 fps, -14.4 LUFS, Scribe word error rate 0. I inspected `ours_sheet.jpg`, the QA stills `03-card-topics`, `06-zoom-capture`, `08-views`, `11-zoom-drawer`, `15-kanban` and `20-endcard-rest` at full size, plus `narration.json`, `scenes.mjs` and `engine/compose.py`.

| Dimension                         | Evernote (evidence)                                                                                             | memrynote tasks-projects                                                                                                                         | Verdict                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Length                            | clips 0:45; persona 3:30-3:50; recaps 5:34; deep dives 6:48-11:27                                               | 2:15                                                                                                                                             | between a clip and a tutorial                                                           |
| Seconds per chapter               | 31-86 s (recaps 32-33, walkthroughs 32-38, deep dives 58-86)                                                    | 13.5 s (10 chapters; 9 topics in 2 min)                                                                                                          | 2.3-6x denser than any Evernote long-form in the set                                    |
| Time to first demonstrated action | 0:15 (Aug 2026 recap) to 1:22 (keynote) in long-form; spoken intros of 10-70 s that heatmaps show being skipped | about 9 s, behind an 8 s card with numbered topic pills (first app frame at 7.6 s)                                                               | **better than Evernote**                                                                |
| Hook                              | names the presenter and scope, plus a "bigger than you think" line (Search) or a problem (personas)             | "Here's how tasks and projects work in {brand}. Let's start with capturing a task."                                                              | a clear topic, but no promise                                                           |
| Pace                              | 147-181 wpm in-house, 220-227 creators                                                                          | 148 wpm over the film, 175 while speaking                                                                                                        | **same as Evernote's tutorials**; leave it                                              |
| UI size in wide shots             | 2024 raw screencasts unreadable; 2026 window at 80-90% of a 4K frame                                            | window at 1760/1920 = 92% of the frame; 1 CSS px = 1.1 output px, so 13-14 px UI text renders at about 15 px                                     | fine on a desktop monitor, unreadable on a phone                                        |
| Zoom                              | 2-3x punch-in on every key moment, popover dims, enlarged cursor                                                | 5 zooms at 1.45-1.9x (`capture` 1.9, `views` 1.6, `drawer` 1.45, `hubcapture` 1.5, `notes` 1.6); `hub` and `kanban` have none                    | too gentle, and two scenes stay wide                                                    |
| Readability on a phone            | punch-ins legible even at 320x180, so roughly 30 px or more at 1080p                                            | wide shots about 15 px; zooms about 21-29 px                                                                                                     | see the arithmetic below                                                                |
| Visual change (5 s step)          | 4.2-6.3 per min in 2026 recaps and the Search deep dive; 0.9-1.7 in older or slower ones                        | 0.9                                                                                                                                              | as static as Spaces 101                                                                 |
| Demo data                         | named, personal stories (Barcelona trip, film photography, Life HQ)                                             | Maya's week is a good story ("Draft the homepage copy @Friday !high +Website-Redesign #client", "Lisbon Trip", "Water the plants every 2 weeks") | good data, but the narration never tells the story                                      |
| How features are explained        | need → demo → name → one-sentence definition                                                                    | describes what is on screen ("An at sign sets the date ...")                                                                                     | no "why" or "when"                                                                      |
| CTA                               | asks for feedback or the next topic; links in the description; none of the 11 transcribed videos asks for likes | "Thanks for watching, and I'll see you in the next one." plus memrynote.com on the card                                                          | no ask, and no next video named                                                         |
| End card                          | 15-20 s branded card (2024-25) or a 3-5 s sting with end-screen overlays                                        | about 5 s (`endCard` from "Thanks for watching" at 129.6 s to 134.6 s; `tail` 2.6 s)                                                             | exactly YouTube's 5 s minimum for end-screen elements; no space for a "next video" slot |
| Captions                          | human English captions on 20 of 24 recaps                                                                       | `.srt` generated by the engine                                                                                                                   | upload it                                                                               |
| Chapters                          | verb-led outcomes; start at 0:00                                                                                | "Intro" (8 s), "Quick capture", ..., "Outro"; noun labels                                                                                        | rename (§9.3)                                                                           |
| Master resolution                 | 3840x2160 since Dec 2024                                                                                        | 1920x1080                                                                                                                                        | go to 1440p (§9.2 C7)                                                                   |
| Thumbnail, description            | template with series pill; description = summary → chapters → clarifications → link block                       | none yet; drafted by hand                                                                                                                        | build both                                                                              |

**Phone readability.** A 1920x1080 frame on a phone in portrait is about 393 pt wide, so 1 video px ≈ 0.20 pt. Full-screen landscape is height-limited at about 393 pt, so 1 video px ≈ 0.36 pt. iOS body text is 17 pt and footnotes are 13 pt; below about 11 pt, UI text stops being readable.

| Text size at 1080p                | Portrait   | Landscape full-screen     |
| --------------------------------- | ---------- | ------------------------- |
| Our wide shots, about 15 px       | about 3 pt | about 5.5 pt (unreadable) |
| Our zooms, about 21-29 px         | 4-6 pt     | 7.6-10.5 pt (borderline)  |
| Evernote-style punch-in, 35-45 px | 7-9 pt     | 12.7-16.4 pt (readable)   |

No screen tutorial is readable in portrait. The realistic goal is that the one thing each line talks about reaches **30-40 px in the 1080p frame**. For 13-14 px UI text that means **a zoom of about 2.2-2.6x**.

### 9.2 Ranked recommendations

Ranking weighs evidence strength × viewer impact ÷ effort for a one-person product. Each item names where it would live in the engine; the locations are proposals, since I have not read `build.mjs`, `card.mjs` or `qa.mjs` in full.

#### COPY: take as-is

**C1. Zoom to readable size on the thing each line talks about, in every scene, in two steps.**

- _Evidence:_ every 2026 Evernote tutorial and recap uses 2-3x punch-ins (§4.2); the heatmap peaks sit on demo payoffs (§2.7); their unzoomed 2024 screencasts are unreadable (§4.2). Ours zooms at 1.45-1.9x and leaves `hub` and `kanban` wide.
- _Engine:_
  - `scenes.mjs`: use a context zoom of about 1.5x, then a detail zoom of about 2.4x via a second `zoom()` or `zoomOn()` mark on the anchor phrase, then `unzoom()`.
  - Limits: about 2.0-2.2x on full task rows, because the chips sit about 640 px to the right (a known trap in the skill); 2.4-2.8x on compact targets such as menus, chips, the drawer's start/due fields and a board card.
  - Add zooms to `hub` (the gathered tasks/notes/files sections) and `kanban` (the card in flight, then the destination column).
- _QA:_ in `qa.mjs`, also save each zoom still downscaled to 640x360 and look at it. Text legible at 640x360 is about 30 px or more at 1080p, which is about 11 pt on a landscape phone.

**C2. Say the use case, then show it, then name it in one sentence.**

- _Evidence:_ Search deep dive (need → demo → "So that's keyword search ... It's when the words that you type ..."); keynote ("currently, Evernote only finds notes that contain that specific sentence ... With Semantic Search, this changes"); every tutorial threads a personal scenario (§2.4).
- _Engine:_ in `narration.json`, open each line with a half-sentence situation from Maya's week before the mechanics. Example for `drawer`: "A launch task shouldn't hide until its due date. Give it a start date as well as a due date, and it shows up in Today every day until it's done."
- _Cost:_ about 2-4 s per scene. Keep the `at()` anchors verbatim.

**C3. Rename chapters as verb-led outcomes, and drop the Intro/Outro labels.**

- _Evidence:_ the 2026 naming ("Find objects inside images", "Using Keyword Search when you know exactly what you're looking for"), and heatmap peaks on chapter starts, so chapters work as a menu (§7.3, §2.7).
- _Engine:_ `narration.json` `scenes[].title`. In the chapters writer, give the 0:00 entry to the first real chapter (the title card counts as part of it). Name the last chapter "What's next" or merge it. The card's `topics` pills stay short and separate.

**C4. End with a specific question, name the next video, and pin a comment.**

- _Evidence:_ none of the 11 transcribed Evernote videos asks for likes or subscriptions; feedback asks bring 3.5-10.6 comments per 1k views; viewer requests became videos (the Spaces commenter's search video); "Thanks for the openess" (12 likes) (§2.5, §8).
- _Engine:_ `narration.json` outro text. Keep the `endCard.at` phrase "Thanks for watching" verbatim.

**C5. Hold the end card for 10-15 s with room for one "next video" element and a subscribe element.**

- _Evidence:_ Evernote's branded end cards run 15-20 s; ours runs about 5 s, YouTube's minimum (§4.3, §9.1).
- _Engine:_ raise the last scene's `tail` from 2.6 to about 10-12 s, and make sure the music bed covers it. In `card.html`'s end layout, move the lockup and URL into the top-left half so YouTube's end-screen elements can sit on the right without covering the logo.

**C6. Generate a description with Evernote's 2026 layout, and upload the `.srt`.**

- _Evidence:_ §7.2. Manual English captions on 20 of 24 recaps.
- _Layout:_
  - 1-2 sentence benefit-led summary;
  - chapters;
  - clarifications (platform shortcut differences, the minimum memrynote version, what needs sync or an account);
  - a link block: the docs page for the feature (`apps/docs/src/user-guide/...` on the docs site), the next tutorial, download, feedback.
- _Engine:_ `build.mjs` writes `out/<topic>.description.txt` from `narration.json`, with new optional fields `description` and `links`, plus the chapter times the engine already computes.

**C7. Render a 1440p master.**

- _Evidence:_ Evernote has uploaded 3840x2160 masters since Dec 2024, almost every 2026 video. Uploads at 1440p and above are widely reported to get YouTube's higher-bitrate encodes, which keeps small UI text crisp at 1080p playback.
- _Engine:_ `compose.py` `OW, OH = 2560, 1440`, with `WW/WH/WX/WY/R` and the shadow scaled to match, and `card.mjs` rendering at the same size. The recording is 3200x1800 (DPR 2), so a 2347 px-wide window at 1440p is a downscale and stays sharp. 2160p would upscale the window about 1.1x.

#### ADAPT: take the idea, change the form

**A1. Keep the 8 s title card; make the line a promise, not a topic.**

- _Evidence:_ our first demonstrated action (about 9 s) comes sooner than in any Evernote long-form measured here; heatmaps show viewers skipping talking intros (v11 0:24-0:49 = 0.00; Customization peaks at 0:42) (§2.2). Evernote's best in-house hook adds a reason to care (Search: "It might sound basic, but there's actually quite a lot of ways ...").
- _Options_, each 13 words or fewer (about 6 s):
  - "Here's how to plan a whole project in {brand} without leaving your notes."
  - "Tasks, projects and boards in {brand}, in two minutes. Let's start with capture."
- _Engine:_ `scenes[0].text` (with `lead` 1.6).

**A2. A thumbnail template, generated by the card engine.**

- _Evidence:_ §6. Evernote's 2026 grammar works for series clarity; it does not produce views by itself.
- _memrynote version:_
  - lockup top-left;
  - a headline of 3-6 words, verb-led;
  - one keyword drawn as a memrynote capture chip (the `@date` / `!priority` / `+project` / `#tag` pill style is our version of Evernote's selection-box highlight);
  - a series pill bottom-left ("Tutorial"), matching the playlist name;
  - a UI card on the right taken from a 2.4x zoom still (the capture bar with its four chips is the strongest hero image we have);
  - the film's orange gradient as the canvas.
- _Engine:_ an HTML template rendered at 1280x720 through the card renderer, plus a `thumb` block in `narration.json` (`headline`, `keyword`, `still`).
- Break the template on purpose for special films, as Evernote did with "115+" and the creator-style persona thumbnail.

**A3. A format menu for a one-person channel, in priority order.**

- **(a) The current 2-3 min tutorials, named as tours** ("... in 2 minutes"). They match what the film is: 9 topics in 135 s.
- **(b) One deep dive per major area, 5-7 min**, with 5-7 chapters of 45-75 s each, built need → demo → define.
  - _Evidence:_ deep dives are Evernote's most durable organic format (17-21k views, no promotion signal, 317-498 likes, viewers asking for "more like this").
  - _Budget:_ about 4.3k ElevenLabs characters per film, about 9k with 2 takes, so at most 3-4 per month on Starter (40k).
- **(c) "Move your Evernote notes to memrynote".**
  - _Evidence:_ the v11 comments ("What's the best service to migrate to?", price at 71 and 56 likes, AI-privacy at 52) and the Tasks wish list (§8).
  - Show the `.enex` import and what maps where, and state the documented limits on screen: table-of-contents notes import as plain text, ink is not rendered, `evernote:///` links are not resolved, encrypted sections are skipped.
  - Title it by the job, not the brand.
- **(d) A story film, "A week with memrynote" (Maya's client launch), 3-4 min, first person, problem-first hook.**
  - _Evidence:_ persona stories have Evernote's best like ratios (2.4-4.4%). Without a face on camera, expect less than theirs.
- **(e) 20-45 s feature clips cut from scenes**, for X posts, docs embeds and the changelog first, YouTube second.
  - _Evidence:_ Evernote's 25 clips median about 2.1k views on a 147k channel (§5.1). Their real home is the in-app What's New page.
  - The equivalent for us: `apps/docs/src/user-guide/*.md` pages, which already carry `<!-- screenshot: ... -->` placeholders.
- **(f) A release recap only for big releases** (the half-year format, the best organic 2026 long-form), through the existing `release-video` skill.
- **Skip the monthly recap.** It serves existing users, and its organic audience is about 6-8k views even for Evernote (§1.1).

**A4. Keep the title card's topic pills alive on screen as a small chapter label.**

- _Evidence:_ Spaces 101's tab row with the active concept underlined; the half-year chapter cards (§2.3, §4.3).
- _Engine:_ `compose.py` draws a small pill ("03 · Task details") bottom-left from `timeline.json` plus `card.topics` or the scene titles, fading on scene change. Use logical placement (start side) so it mirrors for RTL. It gives orientation and some visual rhythm (our 0.9 big changes per min).

**A5. One or two concept overlays per film, for rules the UI does not show.**

- _Evidence:_ the Search deep dive's definitions ("Semantic Search: Ranks results based on the meaning of words", 1:45).
- _Candidates:_ "Start date → stays in Today until done"; "Encrypted on this device before it syncs".
- _Engine:_ `scenes[].overlay` = `{text, at}` in `narration.json`, drawn by `compose.py`.

**A6. Show the privacy promise instead of only saying it.**

- _Evidence:_ Evernote's told-not-shown segments are the least replayed (keynote "What else is new" 0.03-0.11, §2.7), and Evernote's own audience complains about AI near personal notes and asks for private content (§8.3). Privacy is memrynote's differentiator, and it currently lives in one outro sentence ("Everything lives on your device, encrypted end to end, and syncs when you want it to") over a generic app frame.
- _Adapt:_ give the line 3-4 s of footage that proves it (a sync or encryption state in the app, or offline work), or move the claim into the thumbnail, title or description of a dedicated privacy and sync film.

**A7. Founder candor in the cloned voice.**

- _Evidence:_ the product lead's candid walkthroughs and Q&A drew 7.7-10.6 comments per 1k views and "Thanks for the openess" (§1.4, §8.1).
- _Adapt:_ one true "why I built it this way" sentence per film, in first person (the voice is already Kaan's). The clone cannot ad-lib, so the sentence has to be written honestly.
- Kaan decides whether he ever records an unscripted founder Q&A in his real voice. That is the closest equivalent to AFA.

**A8. Shorts from scenes, low priority.**

- _Evidence:_ Evernote's 2026 Shorts get 1.7-2.0k views; the horizontal duplicate beat the vertical one (§5.2).
- _How, if made at all:_ crop, don't shrink. A 1080x1920 crop that follows the zoom target at 2 output px per CSS px is pixel-exact from the DPR-2 recording. Burn in word captions from the Scribe word timings in `vo/<id>.json`, run 15-30 s, and make one per film (the capture-bar chips are the best candidate).
- _Engine:_ a `compose.py` vertical mode taking a scene id.

#### AVOID

- **V1. Preambles and told-not-shown passages.** Seconds with nothing new on screen get skipped (§2.2, §2.7). Applies to our outro claim (A6) and to any future intro longer than about 8 s.
- **V2. Shrinking the app to make room for graphics** (Spaces 101 at 50-55% width) and leaving long stretches unzoomed (the 2024 screencasts). The UI is the content.
- **V3. Volume without packaging.** The 2021 flood: about 143 uploads, median about 4.7k, most "Level Up" videos under 3k, comments off, 20 Shorts with no hook. Fewer, better films.
- **V4. "Coming soon" inside evergreen tutorials.** Evernote's teasers worked because they shipped within weeks (the PDF teaser on 2026-09-09, the PDF clip on 2026-09-18), and they live in dated recaps. A tutorial meant to last a year should not date itself.
- **V5. Silence on cost when a feature depends on it.** Price dominates the comments under Evernote's biggest launch (§8.3). If something needs an account, sync or a paid plan, say it once on screen and in the description.
- **V6. Cross-posted platform CTAs and reused ad creatives as Shorts** ("link in our bio" on YouTube; 4:5 and square ads in the Shorts feed, §5.2).
- **V7. Judging by views.** Evernote's 40-90k recaps were promoted; likes, comments, average view duration and the Studio retention graph tell the truth. Track those per film.
- **V8. Dense content at window scale** (the AI guide's long recipe notes read as gray blocks) and **rhetorical-question bridges as the only connective tissue** (the AI guide: the slowest edit, an unnamed presenter). Use need and limit bridges (§2.3).
- **V9. Boilerplate tags and emoji habits.** 113 of 118 videos share one stale tag set. No data supports emoji-first titles, so treat them as optional style.

### 9.3 Worked example: the tasks-projects film, revised

- **Title options:**
  - "Tasks and projects in memrynote, in 2 minutes" (45 chars), the overview promise;
  - "Plan projects inside your notes: capture, start dates and boards (memrynote)" (76 chars), the job-first version, in Evernote's persona and deep-dive pattern.
- **Thumbnail:** "Plan projects inside your notes", with "projects" drawn as a `+project` chip; pill "Tutorial"; UI card from the 2.2x capture-bar zoom with its four chips; orange canvas.
- **Intro line** (≤ 6 s): "Here's how to plan a whole project in {brand} without leaving your notes."
- **Chapters**, with current times; times will move after the edits:

  ```
  0:00 Capture a task with date, priority, project and tag
  0:29 Write repeating tasks in plain English
  0:40 See what's due today, tomorrow and this week
  0:56 Use a start date to keep a task in Today
  1:12 Open a project hub: tasks, notes and files together
  1:23 Capture straight into a project
  1:37 Move work across a board
  1:48 Turn a checkbox in a note into a real task
  2:00 What's next
  ```

- **Zoom plan:**

  | Scene        | Zoom                                                         |
  | ------------ | ------------------------------------------------------------ |
  | `capture`    | about 2.2x on the line, centered on the chips                |
  | `views`      | about 2.0x on the group headers, then the view switcher      |
  | `drawer`     | about 2.6x on the start/due fields                           |
  | `hub`        | about 1.6x on the hub sections, then 2.2x on the linked note |
  | `hubcapture` | about 2.2x                                                   |
  | `kanban`     | about 1.8x following the card from column to column          |
  | `notes`      | about 2.2x on the task line with its chips                   |

- **Outro** (keep "Thanks for watching" for `endCard.at`): "That's tasks and projects in {brand}. It all stays on your device, encrypted end to end. Next, I'll show how notes and tasks link together. Tell me in the comments what you'd like to see after that. Thanks for watching." Only name a next video that will exist, then hold the end card for about 12 s.
- **Description**, generated:

  > Capture a task with its date, priority, project and tag in one line, keep it in Today with a start date, and run each project from its own hub and board, all inside your notes.
  >
  > [chapters]
  >
  > [Platform note, only if the film shows a keyboard shortcut.]
  >
  > 📚 Docs: Tasks · 🗂 Projects · ⬇️ Download: memrynote.com · 💬 Feedback: [link]

  The doc link targets and the emoji are Kaan's call.

### 9.4 What does not transfer

| Evernote has                                                                                                 | Why it doesn't transfer to memrynote                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paid promotion behind its biggest numbers (40-90k recaps, 75k keynote, 161k Customization, 311k Mobile Home) | no ad budget; compare ourselves with their organic baseline (6-8k recaps, about 2k clips, 17-21k deep dives)                                                                                                                                                                                                                   |
| 147k subscribers and millions of existing users                                                              | "What's new" and help-center titles ("Set a passcode to lock your Evernote mobile app", 23k) work because people already search "Evernote + task". Nobody searches "memrynote" yet, so titles must name the job, and the first audiences will come from our own surfaces (website, docs embeds, X), not from YouTube discovery |
| Several presenters on camera, named, recognized ("Great job as usual Federico!")                             | no face on camera; a voice clone can be honest and consistent but cannot ad-lib, react or show a person's room the way the persona films do                                                                                                                                                                                    |
| A designer producing blob systems, doodle gardens, 3D numerals and chapter cards per video                   | our brand system is code (`card.html`, the logo geometry); reuse it programmatically for thumbnails, chapter pills and overlays instead of bespoke art                                                                                                                                                                         |
| Product films (tilted windows, whip pans, macro close-ups) for the weekly clips                              | expensive to author per clip and music-only; our engine's strength is narrated, verified real-app recordings                                                                                                                                                                                                                   |
| A weekly clip plus monthly recap cadence fed by a team                                                       | one person and an ElevenLabs Starter quota (40k chars a month, about 3,700 per 2.5-min film with 2 takes); fewer, durable films beat a cadence                                                                                                                                                                                 |
| An in-app What's New page that embeds every video                                                            | product work; the near equivalent is embedding clips in the docs pages that already have screenshot placeholders                                                                                                                                                                                                               |
| A comment-driven feedback loop (pinned feedback link, "Coming soon" asks)                                    | needs viewers first; until then, put a feedback link in every description and pin the question anyway                                                                                                                                                                                                                          |

### 9.5 Already better than Evernote: keep these

- An 8 s title card with numbered topics, so the first demonstrated action comes at about 9 s; Evernote's long-form takes 15 s (Aug 2026 recap) to 1:22 (keynote).
- Chapters start at 0:00 (Evernote broke this three times).
- No PiP covering UI.
- Consistent loudness (-14 LUFS).
- Generated captions.
- A seeded persona vault with believable data.
- **Checks proving the app did what the narration says.** Evernote has no equivalent, and it matters for a tutorial people follow along with.
