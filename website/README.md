# Memry Website

Marketing website for Memry - a local-first PKM application.

## Tech Stack

- **Framework**: React 18 + TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4
- **Components**: shadcn/ui (custom)
- **Animations**: Framer Motion
- **Routing**: React Router

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Build

```bash
npm run build
```

Output is generated in the `dist/` folder.

## Configuration

### Formspree (Waitlist)

1. Create a form at [formspree.io](https://formspree.io)
2. Update `FORMSPREE_ID` in `src/lib/constants.ts`

### Google Analytics

1. Get your GA Measurement ID from Google Analytics
2. Replace `GA_MEASUREMENT_ID` in `index.html`

## Placeholder Assets

Replace these files with actual assets:

| File                                      | Description                 | Size      |
| ----------------------------------------- | --------------------------- | --------- |
| `public/favicon.svg`                      | Browser favicon             | 32x32     |
| `public/og-image.png`                     | Social sharing image        | 1200x630  |
| `public/placeholders/hero-screenshot.png` | Hero section app screenshot | 1920x1200 |
| `public/placeholders/feature-inbox.png`   | Inbox feature screenshot    | 1920x1200 |
| `public/placeholders/feature-journal.png` | Journal feature screenshot  | 1920x1200 |
| `public/placeholders/feature-notes.png`   | Notes feature screenshot    | 1920x1200 |
| `public/placeholders/feature-tasks.png`   | Tasks feature screenshot    | 1920x1200 |

## Pages

- `/` - Home (landing page)
- `/features` - Detailed feature breakdown
- `/pricing` - Pricing tiers and FAQ
- `/*` - 404 Not Found

## Project Structure

```
src/
├── components/
│   ├── layout/       # Header, Footer, Container
│   ├── sections/     # Hero, Features, Pricing, etc.
│   ├── shared/       # Reusable components
│   └── ui/           # shadcn/ui components
├── pages/            # Route pages
├── lib/              # Utilities and constants
└── hooks/            # Custom hooks
```

## Design System

Colors match the Memry app's "Warm Utility" aesthetic:

- **Background**: `#F6F5F0` (warm beige)
- **Primary**: `#F59E0B` (amber)
- **Fonts**: DM Sans (UI), Crimson Pro (content), Playfair Display (headlines)
