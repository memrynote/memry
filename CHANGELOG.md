# Changelog

All notable changes to memry are documented here.
Format: date-based entries grouped by merged PR.

## 2026-03-12 — Graph View

### Added
- Add interactive knowledge graph with note/tag/project nodes, filtering panel, and local graph sidebar
- Add graph IPC pipeline and Drizzle queries for node/edge data
- Add inline #tag system in editor with space-to-complete and clickable color-synced pills
- Extract inline #tags from markdown body into tag index
- Promote tags to first-class graph nodes linked by entity-tag edges
- Add Instrument Serif and JetBrains Mono font families
- Add outline panel with sticky pin-on-click and smooth fade-out
- Eliminate theme flash with synchronous preload bootstrap

### Fixed
- Fix graph node layout: pre-compute ForceAtlas2, spread nodes to prevent hub collapse
- Fix sigma.refresh() crash in LayoutManager
- Guard graph reducers against stale edge/node references
- Fix graph settings reactivity for layout, labels, and repulsion controls
- Fix UI state not resetting when switching vaults
- Fix pending tag colors for optimistic tag creation

### Changed
- Convert graph controls to collapsible gear-icon drawer
- Aggregate task tags in sidebar tag counts
- Move action icons to layout top-right with hover outline
- Add animated hover dimming to graph nodes
