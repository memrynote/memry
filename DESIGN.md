---
name: memry-product-design
description: "Design, build, or review Memry product experiences across desktop, mobile, and future platforms. Desktop is the current reference implementation. Each platform keeps Memry's design language while using native interaction and navigation patterns. Do not use for apps/landing."
---

# Design Memry across platforms

This file is the design authority for every Memry product app. It defines the hierarchy, color semantics, typography roles, spacing rhythm, component intent, motion character, accessibility standard, and product tone that every platform must preserve.

Desktop is the current reference implementation. It is the first place to look when this file does not answer a product design question. Mobile is in development and has not shipped. Its current code and Figma files are implementation inputs, not independent design authority. A future tablet, watch, web, or other product app follows the same rule.

Reference does not mean pixel copy. Each platform carries the same Memry decisions through its native navigation, controls, input methods, safe areas, typography metrics, and accessibility behavior.

The landing page is a separate brand surface. Do not copy layout, typography, mascots, CTA treatment, or marketing effects from `apps/landing` into product apps.

## Platform status and authority

| Platform            | Status                        | Design role                                                                |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| Desktop             | Current product reference     | Resolves unanswered product design questions and proves the system in use  |
| Mobile              | In development and unreleased | Adapts the global system to touch and native mobile conventions            |
| Future product apps | Not defined yet               | Start from this file and the desktop reference, then adapt to the platform |
| Landing             | Separate brand surface        | Shares the Memry brand, but does not define product UI                     |

When sources disagree, use this order:

1. `PRODUCT.md` and `DESIGN.md`.
2. The working desktop product for product hierarchy, semantics, and visual character.
3. Platform accessibility and native interaction conventions.
4. The platform's shared theme and component library.
5. Platform Figma files, feature specs, and unfinished screens.

Fix a conflict instead of documenting two approved answers.

## Product and interface context

Memry is an offline-first, end-to-end-encrypted workspace for notes, tasks, projects, journal, calendar, and Agent Chat. People leave it open for hours. The interface must help them keep their thread without competing with their work.

The Memry product character is calm, private, and crafted:

- Calm means a clear focal task, quiet resting states, and depth revealed on demand.
- Private means honest local and sync states, no fake urgency, and no patterns that imply data leaves the device without explanation.
- Crafted means exact typography, alignment, interaction feedback, and state handling. It does not mean decoration.

Memry is a serious personal tool. It must not read as a cold enterprise dashboard, a gamified consumer app, or a crowded productivity suite.

## Use this priority order

When requirements compete, protect them in this order:

1. Preserve user data, platform behavior, accessibility, localization, and backward compatibility.
2. Preserve the user's choices that the platform supports, including theme, accent, font size, font, and density.
3. Make the current task and primary action clear without exposing every feature at once.
4. Reuse the platform's app shell, semantic tokens, and shared UI components.
5. Keep content readable across window sizes, device classes, RTL, larger text, and reduced-motion modes.
6. Add surface-specific character only after the shared hierarchy works.
7. Prefer the smallest visual change that solves the problem.

## Read the sources in authority order

Read these files before changing product UI:

- `PRODUCT.md` for product intent and anti-references.
- `DESIGN.md` for global product design policy.

For desktop work, also read:

- `apps/desktop/src/renderer/src/assets/base.css` for live themes, tokens, editor rules, motion, and surface-specific CSS.
- `apps/desktop/src/renderer/src/assets/main.css` for window chrome, tab sizing, focus reset, and RTL direction.
- `packages/contracts/src/settings-schemas.ts` for current appearance defaults.
- `apps/desktop/src/renderer/src/hooks/use-theme-sync.ts` for runtime theme, font, and accent behavior.
- `apps/desktop/src/renderer/src/hooks/use-display-density.ts` for comfortable and compact density values.
- `apps/desktop/src/renderer/src/components/ui/` for component primitives.
- The closest existing page or feature component for local composition.

For mobile work, also read:

- `apps/mobile/AGENTS.md` for the Expo version and project rules.
- `apps/mobile/src/theme/` for the current mobile token implementation.
- `apps/mobile/src/components/ui/` for mobile components.
- `apps/mobile/docs/ui-foundation-design.md` and `apps/mobile/docs/figma-foundation-spec.md` for measured implementation detail.
- The Expo documentation pinned to the version in `apps/mobile/package.json`.

`docs/DESIGN_TOKENS.md` is the desktop implementation catalog. `base.css` remains the exact desktop code source. Mobile owns its exact values under `apps/mobile/src/theme/`, but those values must implement the meanings in this file.

Mobile currently has a legacy theme layer under `src/constants/theme.ts` and a newer system under `src/theme/`. Do not add a third system. New product UI uses `src/theme/` and `src/components/ui/`. Migrate legacy consumers as their screens are redesigned.

Do not begin from `apps/landing/src/index.css`, `assets/brand/memry/DESIGN.md`, a generic shadcn example, or a new visual framework.

## Work in four passes

### Frame the user's job

Name the one thing the user is trying to do on the surface. Identify the information and controls required for that job. Remove controls that belong in a menu, a detail panel, or a later state.

Account for feature toggles. A disabled calendar, journal, Agent Chat, or project module must disappear cleanly. Do not leave a dead navigation item, empty frame, or unexplained gap.

### Fit the platform shell

Place the work in the platform's current navigation and content structure. On desktop, preserve sidebars, tabs, split panes, page chrome, drag regions, and native window controls. On mobile, preserve stack navigation, tabs, sheets, safe areas, touch behavior, and system gestures.

Choose the correct density. Use compact rows for scanning and data-heavy views. Use comfortable spacing for reading, composing, onboarding, and low-volume settings.

### Build with the shared system

Use the platform's semantic tokens and shared components. Desktop uses Tailwind utilities and CSS variables. Mobile uses its theme modules and React Native components. Keep local styling for geometry or behavior unique to one feature.

### Inspect the real states

Inspect the feature with realistic content, not only an empty state. Check every supported color mode, a non-default accent, larger text, long translated copy, platform focus or press states, constrained layouts, and reduced motion. Fix the largest hierarchy or usability problem first.

## Authoritative Memry visual system

### Visual character

The default Memry experience is clean white with warm gray ink and surfaces. The paper theme adds beige warmth. Dark mode uses neutral charcoal, not blue-black. Editorial type appears in selected moments, while the working interface stays compact and direct.

The interface is quiet at rest:

- One continuous canvas before a collection of cards.
- One-pixel boundaries before heavy shadows.
- Neutral controls before colored controls.
- Text labels before decorative icons.
- Progressive disclosure before persistent toolbars.
- Strong state changes only where the user acted or must act.

Warmth comes from neutral color, type contrast, spacing, and the orange default accent. Do not add texture, illustration, or brown tint merely to make a screen feel warm.

### Themes and semantic color

Desktop supports four stored theme choices. The table below is the current reference palette. Mobile and future product apps keep the same semantic roles and visual relationships. Add platform-specific color handling without replacing Memry's canvas, text, tint, or status meanings with an unrelated system palette.

| Choice         | Selector            | Canvas         | Primary ink    | Secondary surface |
| -------------- | ------------------- | -------------- | -------------- | ----------------- |
| Light paper    | root or `.light`    | `#f6f5f0`      | `#1a1a1a`      | `#efefe9`         |
| White, default | `.white`            | `#ffffff`      | `#37352f`      | `#f7f6f3`         |
| Dark           | `.dark`             | `#121212`      | `#bcbab6`      | `#202020`         |
| System         | `.light` or `.dark` | Follows the OS | Follows the OS | Follows the OS    |

Use semantic tokens, not these hex values, in components. Desktop exposes these names:

- Canvas: `--background`, `--foreground`, `--surface`, `--surface-active`.
- Text: `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-bright`.
- Components: `--card`, `--popover`, `--muted`, `--primary`, `--secondary`, `--accent` and their foreground pairs.
- Boundaries: `--border`, `--input`, `--ring`.
- Destructive state: `--destructive` and `--destructive-foreground`.

Use the Tailwind mappings such as `bg-background`, `text-foreground`, `bg-surface`, `text-text-tertiary`, and `border-border` where they exist.

Mobile maps the same meanings through `canvas`, `text`, `line`, `ui`, `tint`, `dot`, and `pastel` groups. A platform may change representation, but not the meaning or hierarchy of a color role.

#### The user accent owns interaction

The default accent is orange `#f97316`, but the user can select any valid six-digit hex color. Runtime code exposes it as `--tint` and derives:

- `--tint-hover`
- `--tint-light`
- `--tint-lighter`
- `--tint-muted`
- `--tint-ring`
- `--tint-border`
- `--tint-foreground`

Use the tint for selection, active tabs, checked controls, focus emphasis, drag placeholders, primary creation actions, and links inside editable content. Never hardcode indigo, orange, or brand terracotta for those states.

The product accent is not the landing brand token. `#ff671a` belongs to brand assets, splash screens, and marketing. Interactive product controls use the tint role; the default resolves to `#f97316`.

Mobile currently defines `tint.base` as `#6366f1`. That value is known drift from the desktop reference, not a second approved accent. Mobile must converge on the global default tint or a synced user choice before release.

#### Domain color carries domain meaning

Specialized colors are allowed when they encode a stable domain distinction:

- Task priority, due-date, completion, progress, repeat, and token colors use the desktop `--task-*` family or the matching platform theme roles.
- Graph nodes and edges use the desktop `--graph-*` family or the matching platform theme roles.
- Calendar event types use the centralized calendar color mapping.
- Inbox types and Agent Chat mentions use their centralized type mappings.
- User-created tags may use the user's chosen tag color.

Do not reuse these colors as general decoration. Pair color with text, an icon, position, or shape. Red means destructive, failed, urgent, or overdue. It does not mean emphasis.

### Typography

Desktop lets the user control the base UI font. Its default is the operating system sans stack. Desktop also supports serif, sans-serif, monospace, Gelasio, Geist, Inter, and a locally installed custom font. Desktop components inherit `--font-sans` unless a semantic role calls for another family.

The desktop root font size is also user-controlled:

| Setting         | Root size |
| --------------- | --------- |
| Small           | `14px`    |
| Medium, default | `16px`    |
| Large           | `20px`    |

Use the font roles already defined in `base.css`:

- `--font-sans`: application chrome, controls, lists, body text, and the BlockNote editor.
- `--font-serif`: editorial moments such as the Home greeting, selected card titles, journal copy, and restrained empty-state text.
- `--font-display`: rare large journal or atmospheric display text. It uses Playfair Display.
- `--font-heading`: note titles and structural display headings. It uses Space Grotesk.
- `--font-mono`: code, keyboard shortcuts, tokens, timers, paths, and aligned numeric readouts.

Do not force a fixed font on ordinary controls. A user who selects Geist, Gelasio, monospace, or a custom family expects the working interface to honor that choice.

Mobile preserves the same roles instead of copying desktop pixels:

- Working sans: mobile body, controls, navigation, and editor chrome. The current mapping uses Inter.
- Structural display: note titles and important product headings. The current mapping uses Space Grotesk.
- Editorial serif: journal, reflective copy, and selected content titles. The current mapping uses Crimson Pro.
- Mono: code, recovery material, keyboard-like tokens, paths, and aligned technical values. The current mapping uses JetBrains Mono.

Mobile uses its named type ramp under `apps/mobile/src/theme/text-styles.ts`. Respect Dynamic Type and platform text metrics. Do not scale desktop sizes mechanically or invent screen-local font sizes.

Desktop base headings use weight `600`, line height `1.3`, and letter spacing `-0.01em`. Use the desktop scale below before inventing a desktop value:

- `9px` to `11px`: counts, tiny status labels, and dense metadata.
- `12px`: toolbar text, section labels, and secondary metadata.
- `13px`: compact rows, menus, tabs, and settings labels.
- `14px`: normal body and comfortable rows.
- `16px` to `18px`: settings headings and card titles.
- `34px`: Home greeting.
- `42px`: note title.

Uppercase tracking is limited to short utility labels such as sidebar sections, widget headings, settings groups, and compact badges. Use sentence case for page titles, dialogs, actions, and explanatory copy.

Use `text-foreground` or `text-text-primary` for the main read, `text-text-secondary` for supporting content, and `text-text-tertiary` for metadata and inactive icons. Small informative text must meet a 4.5:1 contrast ratio in every theme and interaction state.

### Platform shells and layout

#### Desktop reference shell

The desktop shell is a workspace, not a web page:

- Native window controls occupy a fixed `180px` chrome region at the inline start.
- The sidebar defaults to `256px`, resizes from `171px` to the smaller of `480px` and half the window, and collapses off-canvas. The desktop renderer's narrow responsive sheet is `18rem`.
- The tab bar is `36px` high. Regular tabs share available width from `52px` to `240px`. Pinned tabs are `36px` square.
- Active tabs keep the canvas background and a `2px` tint underline. Inactive tabs remain transparent with a quiet hover fill.
- The main content uses `bg-background` and fills the remaining pane. Split panes reuse the same canvas instead of introducing nested app frames.
- The fixed Day Panel and other side rails reserve real space. Content must not slide underneath them.

Do not hardcode the old `240px` sidebar token into page layout. The sidebar provider writes the live width at runtime.

#### Page chrome

Inbox, Tasks, notes, and similar pages use compact chrome near `38px` high. The note chrome is `36px`. Floating chrome blends `65%` of `--background` with transparency and uses `16px` blur. A hairline and soft falloff appear only after content scrolls underneath.

This material is a functional scroll-edge treatment. Do not turn every toolbar or card into translucent glass. Under `prefers-reduced-transparency`, use the solid background and remove blur.

#### Content geometry

- Normal note content resolves to a `64rem` canvas. Full-width editor mode keeps the pane width.
- A note review or outline rail uses a `20rem` track with a `3rem` gap. The rail hides below `920px` when the content can no longer support it.
- Home keeps an eight-column board with a `640px` width floor. Narrow panes scroll the board rather than crushing widgets below a readable width.
- Settings use a `15rem` section rail and a centered content column capped at `48rem`.
- Data tables, calendars, kanban boards, graphs, and canvases may use the full pane. Reading and composing surfaces keep a bounded measure.

Every object aligns to a shared edge, baseline, grid track, or deliberate optical center. Do not center a whole page by habit. Center only content that benefits from a reading column or a true empty state.

#### Mobile and future platform mapping

Mobile does not reproduce the desktop sidebar, tab strip, hover states, or multi-pane geometry. It carries the same information hierarchy through native structures:

- Use stack titles, native tabs, sheets, menus, safe-area handling, and system back behavior.
- Keep primary content on the screen and move secondary desktop rails or inspectors into a pushed screen or sheet.
- Replace hover with pressed, selected, focus, and long-press states. Add haptics only when they confirm a real action.
- Keep touch targets at least `44pt`. Density may reduce visual padding, but not the hit area.
- Let platform controls remain native when they preserve Memry's semantic color, hierarchy, and copy.
- Use `@expo/ui` for native controls when the installed Expo version supports the needed component. Use virtualized React Native lists for large data sets.
- Account for top and bottom safe areas, the keyboard, larger text, and system gestures.

A future watch app starts from the same semantics, not from a scaled-down phone screen. It keeps Memry's color roles, status meanings, typography character, copy, and restraint while reducing each view to glanceable information and one clear action.

### Spacing and density

Memry uses a shared `4px` base and an `8px` grouping rhythm. Each platform exposes that rhythm through its own token API. Small controls may use established half steps.

Desktop uses Tailwind spacing. Mobile uses `space` from `apps/mobile/src/theme/primitives.ts`. Do not copy Tailwind class values into React Native screens or scatter numeric equivalents outside the mobile theme.

`useDisplayDensity()` provides two density modes for supported list and page surfaces:

| Property        | Comfortable, default              | Compact                    |
| --------------- | --------------------------------- | -------------------------- |
| Page padding    | `24-32px` inline, `32-48px` block | `16-24px` inline and block |
| Section gap     | `24px`                            | `16px`                     |
| Item padding    | `12px x 10px`                     | `8px x 6px`                |
| Item gap        | `12px`                            | `8px`                      |
| Icon container  | `36px`                            | `28px`                     |
| Inner icon      | `16px`                            | `14px`                     |
| Title           | `14px`                            | `13px`                     |
| Metadata        | `12px`                            | `11px`                     |
| Approximate row | `48px`                            | `36px`                     |

Consume `DENSITY_CONFIG[density]` instead of recreating these values. Density is not a reason to shrink dialog actions, editor text, keyboard focus, or other controls that are not part of the density system.

Mobile does not inherit desktop's compact row height. Mobile's `sizes` tokens own touch targets, rows, navigation bars, and tab bars. The visual density may match desktop's calm hierarchy, but touch geometry remains native and accessible.

### Surfaces, boundaries, and depth

Use one continuous canvas by default. Add a surface only when it communicates grouping, interaction, layering, or a distinct working area. Desktop implements these roles with the utilities below. Other platforms map the same roles through their theme.

- `bg-surface` is for sidebars and secondary panels.
- `bg-surface-active` is for hover, selected-neutral, and grouped settings surfaces.
- `bg-card` is for real cards such as Home widgets, compact composer containers, and content objects.
- `bg-popover` is for floating menus, selects, and pickers.
- A `1px` `border-border` boundary is the normal separator.

Radius follows control size and grouping:

| Radius         | Role                                                   |
| -------------- | ------------------------------------------------------ |
| `5px` to `6px` | Dense toolbar buttons, menu rows, small controls       |
| `7px` to `8px` | Inputs, buttons, list rows, tabs, ordinary groups      |
| `12px`         | Cards and medium panels                                |
| `16px`         | Home widgets, large cards, and the Agent Chat composer |
| `20px`         | Rare large dialog or onboarding container              |
| Full           | Avatars, dots, color swatches, and true pills only     |

Depth is restrained but not absent:

- Desktop uses `--shadow-card` for a quiet resting card.
- Desktop uses `--shadow-card-hover` or `--shadow-dropdown` for floating content.
- Home widgets have a deliberate low resting shadow and lift only while dragged or resized.
- Dialogs and sheets use stronger depth because they sit above the workspace.

Mobile maps these levels through its shadow tokens and native overlays. Do not copy desktop CSS shadow strings into React Native.

Do not wrap each section, statistic, or row in a card. Avoid cards inside cards. If spacing and a divider communicate the group, stop there.

#### Controlled effects

Gradients and halos are exceptions with a specific job:

- Mask and fade gradients may preserve legibility at a scroll edge, overflow edge, note margin, graph line, or tab-strip boundary.
- Calendar grids, transparency checkers, preview thumbnails, and custom-color swatches may use gradients because the gradient represents content or a scale.
- Journal, template selection, setup, and recovery may use the existing warm amber-to-orange material to mark a reflective or guided moment.
- A low-opacity radial halo may support a true success state or an otherwise empty pane. The title and next action remain the focal content.

Do not use gradient text. Do not introduce a gradient as a generic page background, card fill, or primary-button style. `PrimaryActionButton` is an existing desktop template-selection exception, not the default product action.

### Components and interaction

Every platform reuses its shared component library and preserves the same semantic contracts: primary, secondary, ghost, destructive, selected, disabled, loading, and error. Exact geometry belongs to the platform.

Desktop reuses components from `apps/desktop/src/renderer/src/components/ui/` and preserves their established geometry.

#### Desktop buttons

`Button` uses an `8px` radius, medium weight, a `0.98` pressed scale, a visible focus ring, and disabled opacity. Standard sizes are:

- Default: `36px` high, `16px` inline padding.
- Small: `32px` high, `12px` inline padding, `12px` text.
- Large: `40px` high, `32px` inline padding.
- Icon: `36px` square. Small icon: `32px` square.

Use `default` for the primary action, `outline` or `secondary` for supporting actions, `ghost` for low-emphasis chrome, `destructive` for irreversible actions, and `link` only when the control should read as a text link.

Tint-filled actions are reserved for user-themed creation or commit moments already established by the surface, such as Agent Chat send and folder creation. Do not make every primary button orange.

#### Desktop fields and selection controls

The shared `Input` is `30px` high with a `7px` radius, `12px` text, a one-pixel input border, and a one-pixel focus ring. Larger fields must earn their height through multiline content or the local task.

Checkboxes and switches use `--tint` when checked. Selects, segmented controls, and pickers expose one obvious selected state. Preserve the typed or selected value when validation fails; show the error without silently resetting the field.

#### Desktop menus, popovers, and tooltips

Menus and popovers use `bg-popover`, a border, an `8px` radius, `4px` internal padding, and the floating shadow. Menu rows are normally `13px`, use a `5px` radius, and have `6px x 8px` padding. Keep destructive menu items red only in text and focused background.

Tooltips use the primary ink surface with primary-foreground text. Add them to unfamiliar icon-only controls. Do not use a tooltip to replace a visible label on a primary action.

#### Desktop dialogs and sheets

Dialogs center in the window, cap ordinary content at `32rem`, use `24px` padding, a border, and strong overlay contrast. Sheets attach to a window edge and keep their source order logical in RTL. A dialog must have a title, a clear action order, a working close path, and content that wraps without widening the dialog.

#### Desktop sidebar

Top-level navigation rows are `28px` high with `13px` medium text, `16px` icons, a `5px` radius, and quiet accent fills. Section headings are `11px`, uppercase, medium weight, and tracked `0.04em`. Counts use tabular numbers.

Hover-only actions must also appear on `focus-within`. Active rows use the sidebar accent surface. The active tab underline and selected controls carry the user tint. Sidebar information at `10px` or `11px` uses `--sidebar-section-heading` where needed to maintain contrast.

#### Desktop tabs and split panes

Tabs compress in stages. First reduce padding, then hide the close button, then hide the title and keep the icon with an accessible name. Scroll the tab strip only after tabs reach the `52px` floor. Keep the active tab visible and respect reduced motion for programmatic scrolling.

Split panes are peer workspaces. Do not make the secondary pane visually disabled or wrap it in a card. Resize handles may become stronger on hover or drag but stay quiet at rest.

#### Mobile component mapping

Mobile reuses `apps/mobile/src/components/ui/`. A mobile component follows these rules:

- Variants keep the same intent as desktop even when the native control shape differs.
- Sizes come from mobile theme tokens. Interactive controls keep a `44pt` hit area.
- Pressed feedback replaces hover. Disabled and loading states remain explicit.
- Bottom sheets replace many desktop dialogs and popovers. Destructive confirmation still names the affected item and consequence.
- Native switches, segmented controls, pickers, menus, and sheets are preferred when they fit the current Expo SDK.
- Callers may change layout without changing a component's visual identity.

Do not wrap a native control only to make it look like desktop. Do not create a custom mobile control only because desktop has a custom web component.

### Content surfaces

The sections below describe product behavior and visual character proven on desktop. Mobile carries the same priorities with native navigation and touch geometry. If a feature is intentionally unavailable on mobile, show a clear limitation instead of a dead control or a partial imitation.

#### Notes and editor

The note page is a focused writing canvas. On desktop, the title uses `--font-heading` at `42px`, line height `48px`, and letter spacing `-0.02em`. The BlockNote body inherits the user's `--font-sans` and root font size.

Editor headings use weight `600`, line height `1.3`, and sizes from `1.875em` for level one to `0.875em` for level six. Top spacing descends from `24px` to `8px`. Inline links use the user tint. Code blocks stay dark because syntax highlighting targets a dark code theme.

Keep the editor background equal to its owning surface. A note uses `--background`; a drawer editor inherits the drawer's surface. Toolbars may float near the selection or stick below page chrome, based on the user's editor setting.

Mobile keeps the same title-first hierarchy through its display style and gives the editor the remaining screen. Editor controls move into native navigation or an input accessory instead of reproducing desktop floating chrome.

#### Home

Home is the product's most editorial page. On desktop, its `34px` serif greeting, date, and live counts create the first read. Board controls remain small and pill-shaped.

Widgets are genuine cards: `16px` radius, one-pixel border, quiet shadow, `11px` uppercase header, and a tint-colored `16px` icon. Widget content density follows its grid span. Drag and resize states may lift the widget; resting widgets do not float aggressively.

#### Lists, tables, tasks, and calendar

Scanning surfaces favor compact sans text, aligned values, tabular numbers, and restrained row backgrounds. Use full-width rows before card grids. Keep list action controls quiet until hover, focus, selection, or context demands them.

Task and calendar color encodes status or content type. Preserve a shared baseline and row geometry so color is not doing the layout's job. Tables align text to the inline start and numbers to the inline end. Dense tables may scroll locally after column simplification and reflow have been exhausted.

#### Agent Chat

Agent Chat uses the same background as the workspace. Assistant messages are unboxed and transparent. User messages use the primary ink surface. The composer is a `16px`-radius bordered card with a `102px` minimum height and a tint-filled send or stop action.

Tool activity stays secondary and collapsible. References and mentions may use domain-colored chips because the color identifies the linked Memry object. Do not turn every assistant paragraph, tool call, or source into a separate elevated card.

#### Graph, canvas, and journal exceptions

Graph and canvas views may use more spatial and domain color because relationships are the content. Their controls still use the shared chrome and semantic tokens.

Journal has deliberate atmospheric exceptions: its date watermark, focus-paper treatment, and date fog support the reflective writing context. Do not copy those gradients or drifting effects to Tasks, Inbox, settings, or generic empty states.

### Motion and feedback

Motion explains state, continuity, or direct manipulation. Desktop's default duration tokens are:

| Token                   | Duration | Use                                 |
| ----------------------- | -------- | ----------------------------------- |
| `--duration-instant`    | `100ms`  | Hover and micro-feedback            |
| `--duration-fast`       | `150ms`  | Small control and selection changes |
| `--duration-normal`     | `200ms`  | Most entrances, exits, and reflow   |
| `--duration-slow`       | `300ms`  | Panels and larger movement          |
| `--duration-deliberate` | `400ms`  | Rare significant transitions        |

Use `--ease-out` for entrances, `--ease-in` for exits, and `--ease-in-out` for movement. Existing direct-manipulation exceptions include the Home grid's `320ms` reflow and tab enter and exit at about `160ms` and `130ms`.

Good motion confirms a capture, compresses a removed row, reveals an action, keeps the active tab visible, or shows where a dragged item will land. Outside the documented journal atmosphere, avoid continuous decorative movement, bounce, parallax, scroll-reveal sequences, and motion that delays access to content.

Every animation and programmatic smooth scroll must respect the platform's reduced-motion setting. Keep the final state and remove the movement. Desktop uses `prefers-reduced-motion`; mobile reads the system accessibility setting. Every blur treatment must also provide a solid reduced-transparency result where the platform exposes that preference.

Mobile keeps the same fast, restrained character through native or Reanimated timing. It uses pressed feedback, direct-manipulation continuity, and optional haptics instead of desktop hover motion. Mobile timing lives in its theme when the same value has more than one consumer.

### Icons and media

Desktop imports application icons through `@/lib/icons` or its feature-specific maps. Mobile uses `apps/mobile/src/components/ui/icon.tsx`. Future platforms add one platform icon adapter. Keep the semantic icon name and meaning stable even when the platform glyph differs.

Desktop interface icons are normally `16px`; dense controls use `12px` to `14px`. Mobile icons use the sizes and stroke rules in its theme and component library. Keep one icon style within a control group.

Use icon-only controls for familiar actions or constrained chrome. Give each one an accessible name and, when useful, a tooltip. Do not place ordinary icons in colored tiles for decoration. A restrained icon container or halo is acceptable in an empty, success, setup, or recovery state when it explains that state.

Product empty states use type, a small icon, and a direct action. Do not bring landing mascots, stock images, brand lockups, or decorative AI art into product UI. Media belongs in the interface when it is user content or explains a real feature.

### Copy and trust

Use concise sentence-case labels. Name the action with a verb. Explain destructive or privacy-sensitive effects before confirmation. Keep sync and local-data language factual.

Do not use hype, celebration, streaks, achievements, fake scarcity, or manufactured urgency. Empty states explain what is absent and give the next useful action. Error copy says what failed and what the user can do next.

## Reject product design drift

Do not ship these patterns:

- Landing-page typography, mascot art, hero layouts, or marketing CTA treatment inside product apps.
- Hardcoded `#ff671a`, `#f97316`, or `#6366f1` for selection and focus instead of the platform tint token.
- A mobile or future-platform palette that changes Memry's semantic meanings because a Figma file or starter template used different defaults.
- Treating unfinished mobile screens as evidence that conflicts with the desktop reference.
- Copying desktop navigation or pointer geometry literally onto touch, tablet, or watch.
- A fixed `240px` sidebar assumption.
- A new color, font, radius, shadow, z-index, or motion scale beside the existing tokens.
- Physical Tailwind direction such as `ml-*`, `pr-*`, `left-*`, `right-*`, or `text-left` in new code.
- Generic centered hero copy followed by a grid of cards.
- Cards around every section, metric, row, or assistant message.
- Cards nested inside cards.
- Decorative gradients, glows, glass panels, textures, colored side rails, or ornamental shadows outside the named exceptions.
- Journal atmosphere copied to unrelated pages.
- Large serif text on dense operational screens.
- Uppercase tracked labels used as page headings or ordinary actions.
- Color as the only state cue.
- Hover-only controls that disappear for keyboard focus.
- Tiny low-contrast metadata added for visual quietness.
- Motion without a reduced-motion result.
- Layouts that work only at the default font size, sidebar width, or single-pane width.

## Use one semantic system with platform APIs

The global contract names meaning. Each platform maps that meaning to its own tokens and components. Do not share CSS, pixel values, or rendering components across platforms merely to force visual equality.

### Desktop implementation API

Prefer these token families in page-owned code:

- Canvas and surfaces: `background`, `foreground`, `surface`, `surface-active`, `card`, `popover`, `muted`.
- Text: `text-primary`, `text-secondary`, `text-tertiary`, `text-bright`.
- Interaction: `primary`, `secondary`, `accent`, `destructive`, `ring`, `tint`, and the tint derivatives.
- Structure: `border`, `input`, sidebar tokens, radius tokens, and shadow tokens.
- Domain: task, graph, queue, calendar, inbox type, and tag mappings.
- Motion: duration and easing tokens.

Prefer these shared primitives before local equivalents:

- `Button`, `Input`, `Textarea`, `Checkbox`, `Switch`, `Select`, `RadioGroup`, `Slider`.
- `Dialog`, `AlertDialog`, `Sheet`, `Popover`, `DropdownMenu`, `ContextMenu`, `Tooltip`.
- `Tabs`, `Toggle`, `ToggleGroup`, `Badge`, `Pill`, `Kbd`, `StatusDot`.
- `PageToolbar`, `Picker`, sidebar primitives, and panel resize rails.

Use `cn()` for conditional classes. Use logical properties for direction. Write custom CSS only when a third-party component, editor behavior, data visualization, or unique layout cannot be expressed cleanly with the shared utilities.

```tsx
<button className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-surface-active focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]">
  Action
</button>
```

Do not redeclare semantic variables inside a page. Add a token to `base.css` only when at least two real consumers share a stable meaning. A one-surface visual may stay local if it uses existing semantic inputs.

### Mobile implementation API

New mobile product UI uses:

- `apps/mobile/src/theme/colors/` for semantic colors.
- `apps/mobile/src/theme/primitives.ts` for spacing, radius, and platform sizes.
- `apps/mobile/src/theme/text-styles.ts` and `fonts.ts` for type roles.
- `apps/mobile/src/theme/use-colors.ts` as the reactive color entry point.
- `apps/mobile/src/components/ui/` for shared component structure and states.

Screens import the mobile theme and shared components. They do not introduce hex colors, repeated spacing values, or private button variants. The legacy `src/constants/theme.ts`, `use-theme.ts`, `themed-text.tsx`, and `themed-view.tsx` remain migration code only. Do not use them for new product screens.

The mobile theme must keep the global semantic vocabulary even when React Native names differ from CSS. For example, `canvas.background`, `text.primary`, `line.border`, `ui.destructive`, and `tint.base` map directly to the meanings documented here.

## Accessibility, localization, and platform behavior

Meet WCAG AA. Use semantic controls, landmarks, ordered headings, dialog titles, table structure, accessible names, and live regions where state changes need announcement.

Desktop's global stylesheet removes browser focus outlines, so every interactive desktop component must paint a visible `focus-visible` state. Do not remove a ring without replacing it with an equally clear cue.

New layout code uses logical Tailwind properties:

- `ms-*` and `me-*`
- `ps-*` and `pe-*`
- `start-*` and `end-*`
- `text-start` and `text-end`
- `border-s` and `border-e`
- logical rounded corners

Mirror only direction-bearing icons with `.mirror-rtl`. Do not mirror media, logos, checkmarks, or neutral symbols.

Mobile uses logical React Native properties such as `paddingStart`, `marginEnd`, `start`, `end`, and `textAlign: 'start'`. It accounts for safe areas and preserves native accessibility roles, labels, focus order, font scaling, and reduced-motion settings. Do not encode meaning in a gesture without a visible alternative.

Pointer, keyboard, touch, voice, crown, and assistive input may need different mechanics. They must reach the same product action and expose the same consequence.

Support long translations without shrinking text below the scale. Let labels wrap, truncate only when the full value is available elsewhere, and keep actions reachable. Treat source order as reading order.

Test narrow windows, both sidebar extremes, the Day Panel, split panes, and large font mode. Reflow before adding horizontal scroll. Use local scroll only for genuine wide evidence such as tables, calendars, canvases, and the Home board's documented width floor.

On mobile, test every supported device class with larger text, the software keyboard, safe-area changes, sheets, interrupted gestures, offline state, and screen-reader navigation. Do not claim support for an orientation or device class that the app configuration excludes.

## Inspect and verify before handoff

Review product UI changes in this order:

1. User job: Is the main task obvious, and did optional features disappear cleanly?
2. Hierarchy: Is there one dominant read, with supporting controls quieter?
3. Reference: Does the result still read as the same product as desktop?
4. Themes: Do supported color modes preserve equivalent hierarchy?
5. Personalization: Does a non-orange accent and larger text still work? On desktop, also check custom fonts and compact density.
6. Platform shell: Do desktop workspaces and mobile navigation preserve their platform behavior?
7. Interaction: Are the platform's hover, pressed, focus, active, disabled, loading, empty, error, and destructive states clear?
8. Access: Do keyboard and touch targets work, does small text meet contrast, and is state conveyed without color alone?
9. Motion: Does reduced motion keep the complete result, and does reduced transparency remove blur where used?
10. Localization: Does RTL flip correctly, and do long labels remain usable?
11. Restraint: Can a card, border, shadow, icon, label, color, or animation be removed without losing meaning? If yes, remove it.

Run checks that match the change:

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop typecheck:test
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop i18n:check
pnpm --filter @memry/mobile typecheck
pnpm --filter @memry/mobile lint
pnpm --filter @memry/mobile test
npx -y react-doctor@latest .
git diff --check
```

Run only the platform checks that match the change. For a focused component change, run its nearest test first. For a mobile editor change, also run `pnpm --filter @memry/mobile editor:check`. For shell, editor, IPC, or contract changes, also run the repository checks required by `CLAUDE.md` and the platform's `AGENTS.md`.
