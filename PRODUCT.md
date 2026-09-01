# Product

## Register

product

> The `product` register covers every Memry product app. Desktop is the current
> reference implementation. Mobile and future platforms carry the same product
> system through their native interaction and navigation patterns. The
> landing/marketing site (`apps/landing`) is a separate `brand` surface. When
> working on it, override to the `brand` register and read `reference/brand.md`.

## Users

People drowning in app-switching — inbox in one tool, calendar in another, notes
somewhere else, tasks in a fourth. Many are knowledge workers, makers, and
ADHD/neurodivergent users for whom that constant context-jumping is genuinely
draining, not just annoying. They want **one calm place** that holds everything and
keeps it private.

Context of use: their primary daily workspace, open for hours, often offline, on
their own machine. The job to be done is _get through the day without losing the
thread_ — capture a thought, see what's due, journal, talk to an agent that already
knows their work — without surrendering that data to someone else's server.

## Product Purpose

Memry is an **offline-first, end-to-end-encrypted, agent-native second brain**:
notes, tasks, projects, journal, calendar, and an AI agent with real context on the
user's work — all local, none of it on a server the user doesn't control. Every
feature is a **toggle**: don't use a calendar, turn it off; not into AI, turn that
off too.

Success looks like Memry becoming the _one app stays open all day_ — the calm
default that replaces four anxious tabs — earning trust because privacy and
ownership are structural (E2E crypto, local SQLite, CRDT sync), not marketing.

## Brand Personality

**Calm, private, crafted.** Voice is first-person and human (it's Kaan's app, and it
says so), confident without hype, technical without coldness. The interface should
feel like a quiet, trustworthy room that respects the user's attention and their
data. Emotional goals: relief (the noise stops here), safety (this is _yours_), and
the quiet pleasure of a well-made tool. Warmth comes from typography, terracotta
accent, and editorial restraint — never from cartoon friendliness.

## Anti-references

- **Cold enterprise / corporate** — navy-and-gray B2B, stock-photo trust badges,
  soulless density. Memry is founder-made and personal; never let it read as a
  faceless SaaS dashboard.
- **Playful / gamified consumer** — mascots, confetti, streaks, badges, achievement
  toasts. It's a serious second brain, not a toy; respect the user instead of
  rewarding them.
- **Cluttered productivity tool** — every feature visible at once, dense toolbars,
  feature soup. This directly contradicts "every feature is a toggle / one calm
  place." Default to quiet; reveal depth on demand.

## Design Principles

1. **Privacy is the product, not a feature.** Offline-first and E2E-encrypted are
   the reason Memry exists. Make ownership _felt_ in the UI (local-by-default,
   honest sync states); never bury it as a settings checkbox or undercut it with a
   pattern that phones home.
2. **One calm place.** Every surface reduces app-switching load. Default to focus
   over density; quiet over loud. When a screen feels busy, the design is wrong.
3. **Graceful by toggle.** Because any module can be turned off (calendar, agent,
   journal), design for absence — no empty scaffolding, no dead nav, no hole where a
   disabled feature used to be.
4. **Crafted, not corporate.** Founder warmth carried by type, terracotta, and paper
   texture — the opposite of enterprise gray _and_ of gamified bright.
5. **Earn trust through restraint.** Competence shown quietly: no dark patterns, no
   hype, no manufactured urgency. Accessible by default is part of the promise.

## Accessibility & Inclusion

- **WCAG 2.1 AA** as the baseline: body text ≥4.5:1, large text ≥3:1, full keyboard
  navigation, visible focus.
- **Reduced motion is not optional** — every animation ships a
  `prefers-reduced-motion: reduce` alternative (crossfade or instant).
- **RTL-safe** — the app ships 32 locales; new code uses logical Tailwind properties
  (`ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`) so layout flips cleanly.
- Don't rely on color alone to convey state; pair with icon, text, or shape.
