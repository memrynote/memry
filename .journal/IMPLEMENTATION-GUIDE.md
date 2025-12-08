# Journal Feature Implementation Guide

## Quick Start

This directory contains a complete, step-by-step implementation guide for building the Journal feature in Memry. Follow the prompts in numerical order for best results.

## Implementation Order

### Phase 1: Foundation (Days 1-2)
1. **[01-project-setup.md](01-project-setup.md)** - Install dependencies, create folder structure, define types
2. **[02-day-card-component.md](02-day-card-component.md)** - Build the individual day entry card component

### Phase 2: Core Features (Days 3-4)
3. **[03-infinite-scroll-timeline.md](03-infinite-scroll-timeline.md)** - Implement scrollable timeline with fade-to-focus
4. **[04-tiptap-editor.md](04-tiptap-editor.md)** - Integrate rich text editor with auto-save

### Phase 3: Sidebar Widgets (Day 5)
5. **[05-calendar-heatmap.md](05-calendar-heatmap.md)** - Build activity calendar with heat map visualization
6. **[06-sidebar-notes-list.md](06-sidebar-notes-list.md)** - Create today's notes list widget

### Phase 4: User Controls (Day 6)
7. **[07-focus-mode.md](07-focus-mode.md)** - Implement distraction-free writing toggle
8. **[08-density-slider.md](08-density-slider.md)** - Add layout density controls (compact/balanced/spacious)

### Phase 5: Interactions (Day 7)
9. **[09-keyboard-shortcuts.md](09-keyboard-shortcuts.md)** - Complete keyboard navigation system
10. **[10-animations-polish.md](10-animations-polish.md)** - Add smooth animations and micro-interactions

### Phase 6: Polish & Testing (Days 8-9)
11. **[11-empty-states.md](11-empty-states.md)** - Create empty states and first-time user experience
12. **[12-integration-testing.md](12-integration-testing.md)** - Integration, testing, and final polish

## Estimated Timeline

- **Fast track**: 5-7 days (full-time work)
- **Part-time**: 2-3 weeks (3-4 hours/day)
- **Learning mode**: 3-4 weeks (includes experimentation)

## How to Use These Prompts

### For AI Assistants (Claude, etc.)

Each prompt file is designed to be given to an AI coding assistant like Claude Code:

1. Start with `01-project-setup.md`
2. Copy the entire content of the prompt file
3. Give it to your AI assistant
4. Review and test the implementation
5. Move to the next prompt file

### For Human Developers

Each prompt includes:
- **Context**: What's been built so far
- **Objective**: Clear goal for this step
- **Requirements**: Detailed specs and code examples
- **Technical Constraints**: Must-follow rules
- **Acceptance Criteria**: Checklist for completion
- **Visual Reference**: ASCII diagrams and mockups

Use these as implementation specs and checklists.

## Key Design Decisions

### Layout: Centered Timeline (Option A)
- Vertical infinite scroll with day cards
- Today is centered and prominent (100% opacity, 1.02x scale)
- Past/future days fade based on viewport distance
- Progressive reveal as cards scroll into view

### Technology Stack
- **Editor**: Tiptap (full rich text, not basic textarea)
- **State**: Zustand with localStorage persistence
- **Dates**: date-fns for all date operations
- **Styling**: Tailwind CSS + shadcn/ui components
- **Storage**: localStorage (can be replaced with Electron store later)

### Core Features Included
✅ Infinite scroll timeline with fade-to-focus
✅ Rich text editor with auto-save
✅ Calendar heat map (activity visualization)
✅ Today's notes list with timestamps
✅ Focus mode (distraction-free writing)
✅ Density slider (compact/balanced/spacious)
✅ Comprehensive keyboard shortcuts
✅ Smooth animations and transitions
✅ Empty states and onboarding

### Features Explicitly Excluded
❌ Mood tracking (no emotional state logging)
❌ Images/attachments (text only for now)
❌ Cloud sync (localStorage only)
❌ Search functionality (future enhancement)
❌ Export (future enhancement)

## File Structure Overview

After completing all prompts, you'll have:

```
src/renderer/src/
├── pages/
│   └── JournalPage.tsx                    # Main page container
├── components/
│   └── journal/
│       ├── JournalTimeline.tsx            # Scrollable timeline
│       ├── DayCard.tsx                    # Individual day entry
│       ├── JournalEditor.tsx              # Tiptap rich text editor
│       ├── CalendarHeatMap.tsx            # Activity calendar
│       ├── TodaysNotesList.tsx            # Today's notes sidebar
│       ├── JournalSidebar.tsx             # Right sidebar container
│       ├── FocusModeToggle.tsx            # Focus mode button
│       ├── DensitySlider.tsx              # Layout density control
│       ├── ShortcutsDialog.tsx            # Keyboard shortcuts help
│       ├── DatePickerDialog.tsx           # Jump to date dialog
│       ├── EmptyJournalState.tsx          # First-time user screen
│       ├── SaveIndicator.tsx              # Auto-save feedback
│       └── LoadingSkeleton.tsx            # Loading states
├── lib/
│   ├── hooks/
│   │   ├── useJournalEntry.ts             # Entry CRUD hook
│   │   ├── useScrollFade.ts               # Fade-to-focus effect
│   │   └── useKeyboardShortcuts.ts        # Keyboard navigation
│   ├── journal/
│   │   ├── types.ts                       # TypeScript interfaces
│   │   ├── storage.ts                     # localStorage utilities
│   │   ├── date-utils.ts                  # Date formatting/comparison
│   │   ├── shortcuts.ts                   # Keyboard shortcut config
│   │   ├── events.ts                      # Event system for updates
│   │   └── animations.ts                  # Custom animation utilities
│   └── stores/
│       └── journal-store.ts               # Zustand global state
```

## Dependencies Required

```json
{
  "dependencies": {
    "@tiptap/react": "^2.x.x",
    "@tiptap/starter-kit": "^2.x.x",
    "@tiptap/extension-placeholder": "^2.x.x",
    "@tiptap/extension-link": "^2.x.x",
    "@tiptap/extension-task-list": "^2.x.x",
    "@tiptap/extension-task-item": "^2.x.x",
    "date-fns": "^3.x.x",
    "zustand": "^4.x.x"
  }
}
```

## Keyboard Shortcuts Reference

| Shortcut | Action |
|----------|--------|
| `⌘T` (Cmd+T) | Jump to today |
| `⌘J` (Cmd+J) | Jump to specific date |
| `⌘↑` (Cmd+Up) | Previous day |
| `⌘↓` (Cmd+Down) | Next day |
| `⌘F` (Cmd+F) | Toggle focus mode |
| `⌘/` (Cmd+/) | Show keyboard shortcuts |
| `⌘-` (Cmd+Minus) | Decrease density |
| `⌘=` (Cmd+Equals) | Increase density |
| `Esc` | Close dialogs |

*Note: On Windows, use Ctrl instead of Cmd*

## Design Specifications

### Colors (Heat Map Intensity)
- **Level 0** (no notes): `bg-muted`
- **Level 1** (1-2 notes): `bg-primary/20`
- **Level 2** (3-5 notes): `bg-primary/40`
- **Level 3** (6-10 notes): `bg-primary/60`
- **Level 4** (11+ notes): `bg-primary/80`

### Day Card States
- **Today**: 100% opacity, scale 1.02x, accent border
- **Yesterday**: 75% opacity, scale 1.0x
- **2-7 days ago**: 60% opacity, scale 0.98x
- **Future**: 50-70% opacity, dotted border

### Animation Timings
- **Micro-interactions**: 150ms (button press, hover)
- **Standard transitions**: 300ms (fade, slide)
- **Scroll animations**: 800ms (smooth scroll to date)
- **Easing**: cubic-bezier(0.4, 0, 0.2, 1)

### Density Modes
| Mode | Gap | Padding | Font | Editor Height |
|------|-----|---------|------|---------------|
| Compact | 1rem | 1rem | text-sm | 12rem |
| Balanced | 1.5rem | 1.5rem | text-base | 16rem |
| Spacious | 2.5rem | 2rem | text-lg | 20rem |

## Testing Strategy

### Unit Tests (Optional)
- Date utilities (formatting, comparison)
- Storage utilities (CRUD operations)
- Animation functions

### Integration Tests
- Timeline scrolling and fade effect
- Editor auto-save flow
- Calendar navigation
- Keyboard shortcuts

### E2E Tests (Critical Path)
1. First-time user → sees welcome screen
2. Write first entry → content persists
3. Navigate to past day → shows content
4. Click calendar date → scrolls to day
5. Toggle focus mode → hides sidebar
6. Use keyboard shortcuts → all work

### Manual QA Checklist
See `12-integration-testing.md` for comprehensive checklist.

## Common Issues & Solutions

### Issue: Timeline doesn't center on today
**Solution**: Ensure `scrollToDate` is called in `useEffect` after mount

### Issue: Auto-save triggers too frequently
**Solution**: Check debounce delay is set to 1500ms (1.5 seconds)

### Issue: Calendar heat map shows wrong colors
**Solution**: Verify `getHeatIntensity` function uses correct thresholds

### Issue: Keyboard shortcuts don't work
**Solution**: Check event listener cleanup and `preventDefault()` calls

### Issue: Focus mode animation is janky
**Solution**: Use `transition-all` → specify properties: `transition: width 300ms, opacity 300ms`

### Issue: Past entries are editable
**Solution**: Set `editable={false}` on JournalEditor for past days

## Performance Optimization Tips

1. **Virtual scrolling**: If 100+ entries, consider `@tanstack/react-virtual`
2. **Memoization**: Use `useMemo` for expensive calculations (calendar data)
3. **Debouncing**: Auto-save, scroll events, window resize
4. **Code splitting**: Lazy load dialogs that aren't immediately visible
5. **Image optimization**: Use SVG for icons, not raster images

## Accessibility Checklist

- [ ] All colors meet WCAG AA contrast (4.5:1)
- [ ] Keyboard navigation works everywhere
- [ ] Focus indicators are visible
- [ ] Screen reader labels on interactive elements
- [ ] Respects `prefers-reduced-motion`
- [ ] Semantic HTML (headings, landmarks)
- [ ] Dialogs have proper ARIA roles

## Future Enhancements

Ideas for v2:
- **Search**: Full-text search across all entries
- **Export**: PDF, Markdown, JSON export
- **Attachments**: Images, files, voice notes
- **Tags**: Organize entries by topic
- **Themes**: Custom color schemes
- **Cloud Sync**: Multi-device sync
- **Collaboration**: Shared journals
- **Analytics**: Writing stats, streaks, insights

## Support & Troubleshooting

If you encounter issues during implementation:

1. **Check the README.md** in `.journal/` folder for feature overview
2. **Review the specific prompt** for the component you're working on
3. **Verify dependencies** are installed correctly
4. **Check TypeScript errors** in your IDE
5. **Test in isolation** - build one component at a time
6. **Use React DevTools** to debug state and props
7. **Check browser console** for runtime errors

## License & Attribution

This implementation guide was created for Memry - a personal knowledge management app.

Design inspiration:
- Reflect (daily notes + timestamps)
- mymind (density slider)
- iA Writer (focus mode)
- GitHub (activity heat map)

## Contributors

Created by: Claude (Anthropic)
For: Memry project
Date: December 2024

---

**Ready to start?** Begin with `01-project-setup.md` and work through each prompt sequentially. Happy coding!
