# 07 - Focus Mode Toggle

## Context

We now have:
- Timeline with day cards and rich text editor
- Sidebar with calendar heat map and notes list
- Layout: main content area + right sidebar

Now we implement **Focus Mode** - a distraction-free writing mode that:
- Hides the sidebar
- Centers the editor
- Reduces visual clutter
- Can be toggled with a button or keyboard shortcut (Cmd+F)

Think of this like iA Writer or Ulysses' focus mode.

## Objective

Create a toggle button and state management that:
1. Hides the sidebar when focus mode is active
2. Centers and expands the editor to maximum comfortable reading width
3. Dims past/future day cards (optional enhancement)
4. Persists focus mode preference
5. Supports keyboard shortcut (Cmd+F)

## Requirements

### Component File

Create `src/renderer/src/components/journal/FocusModeToggle.tsx`

### State Management

Use Zustand for global focus mode state:

Create `src/renderer/src/lib/stores/journal-store.ts`:

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface JournalStore {
  focusMode: boolean;
  density: 'compact' | 'balanced' | 'spacious';

  // Actions
  toggleFocusMode: () => void;
  setFocusMode: (enabled: boolean) => void;
  setDensity: (density: 'compact' | 'balanced' | 'spacious') => void;
}

export const useJournalStore = create<JournalStore>()(
  persist(
    (set) => ({
      focusMode: false,
      density: 'balanced',

      toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
      setFocusMode: (enabled) => set({ focusMode: enabled }),
      setDensity: (density) => set({ density })
    }),
    {
      name: 'journal-preferences' // localStorage key
    }
  )
);
```

### Toggle Button Component

```typescript
import React from 'react';
import { Maximize2, Minimize2 } from 'lucide-react'; // Or custom icons
import { useJournalStore } from '@/lib/stores/journal-store';
import { cn } from '@/lib/utils';

export function FocusModeToggle({ className }: { className?: string }) {
  const { focusMode, toggleFocusMode } = useJournalStore();

  return (
    <button
      onClick={toggleFocusMode}
      className={cn(
        'flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        focusMode && 'bg-primary text-primary-foreground hover:bg-primary/90',
        className
      )}
      title={focusMode ? 'Exit focus mode (Cmd+F)' : 'Enter focus mode (Cmd+F)'}
    >
      {focusMode ? (
        <>
          <Minimize2 className="h-4 w-4" />
          <span>Exit Focus</span>
        </>
      ) : (
        <>
          <Maximize2 className="h-4 w-4" />
          <span>Focus Mode</span>
        </>
      )}
    </button>
  );
}
```

### Keyboard Shortcut Hook

Create `src/renderer/src/lib/hooks/useKeyboardShortcuts.ts`:

```typescript
import { useEffect } from 'react';

interface ShortcutConfig {
  key: string;
  ctrl?: boolean;
  meta?: boolean; // Cmd on Mac
  shift?: boolean;
  callback: () => void;
}

export function useKeyboardShortcut(config: ShortcutConfig) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const { key, ctrl = false, meta = false, shift = false, callback } = config;

      const ctrlMatch = ctrl ? event.ctrlKey : !event.ctrlKey;
      const metaMatch = meta ? event.metaKey : !event.metaKey;
      const shiftMatch = shift ? event.shiftKey : !event.shiftKey;

      if (event.key === key && ctrlMatch && metaMatch && shiftMatch) {
        event.preventDefault();
        callback();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [config]);
}

/**
 * Hook to register multiple keyboard shortcuts.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutConfig[]) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      for (const shortcut of shortcuts) {
        const { key, ctrl = false, meta = false, shift = false, callback } = shortcut;

        const ctrlMatch = ctrl ? event.ctrlKey : !event.ctrlKey;
        const metaMatch = meta ? event.metaKey : !event.metaKey;
        const shiftMatch = shift ? event.shiftKey : !event.shiftKey;

        if (event.key === key && ctrlMatch && metaMatch && shiftMatch) {
          event.preventDefault();
          callback();
          break;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts]);
}
```

### Update JournalPage Layout

Modify `src/renderer/src/pages/JournalPage.tsx` to support focus mode:

```typescript
import React from 'react';
import { JournalTimeline } from '@/components/journal/JournalTimeline';
import { JournalSidebar } from '@/components/journal/JournalSidebar';
import { FocusModeToggle } from '@/components/journal/FocusModeToggle';
import { useJournalStore } from '@/lib/stores/journal-store';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcuts';
import { cn } from '@/lib/utils';

export function JournalPage() {
  const { focusMode, density, toggleFocusMode } = useJournalStore();

  // Keyboard shortcut: Cmd+F (Mac) or Ctrl+F (Windows)
  useKeyboardShortcut({
    key: 'f',
    meta: true, // Cmd on Mac
    callback: toggleFocusMode
  });

  return (
    <div className="flex h-full flex-col">
      {/* Top bar with focus mode toggle */}
      <div className="flex items-center justify-between border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Journal</h1>
        <FocusModeToggle />
      </div>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Timeline (main content) */}
        <div
          className={cn(
            'flex-1 overflow-hidden transition-all duration-300',
            focusMode && 'mx-auto max-w-4xl' // Center in focus mode
          )}
        >
          <JournalTimeline density={density} focusMode={focusMode} />
        </div>

        {/* Sidebar (hidden in focus mode) */}
        <aside
          className={cn(
            'w-80 shrink-0 overflow-y-auto border-l transition-all duration-300',
            focusMode && 'w-0 opacity-0' // Collapse and fade out
          )}
        >
          <JournalSidebar />
        </aside>
      </div>
    </div>
  );
}
```

### Sidebar Component

Create `src/renderer/src/components/journal/JournalSidebar.tsx`:

```typescript
import React from 'react';
import { CalendarHeatMap } from './CalendarHeatMap';
import { TodaysNotesList } from './TodaysNotesList';
import { DensitySlider } from './DensitySlider'; // Will create in next prompt
import { cn } from '@/lib/utils';

export function JournalSidebar({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-4 p-4', className)}>
      {/* Calendar heat map */}
      <CalendarHeatMap onDateClick={(date) => {
        // Scroll to date in timeline
        console.log('Navigate to', date);
      }} />

      {/* Today's notes list */}
      <TodaysNotesList />

      {/* Density slider (will implement in next prompt) */}
      {/* <DensitySlider /> */}
    </div>
  );
}
```

### Focus Mode Enhancements (Optional)

You can add visual enhancements when focus mode is active:

```typescript
// In DayCard component, dim non-today cards in focus mode
const { focusMode } = useJournalStore();

<div
  className={cn(
    // ... existing classes
    focusMode && !isToday && 'opacity-30' // Dim past/future in focus mode
  )}
>
```

## Technical Constraints

- MUST use Zustand for state management (not Context API)
- MUST persist focus mode preference in localStorage
- MUST support Cmd+F (Mac) and Ctrl+F (Windows) keyboard shortcuts
- Sidebar transition MUST be smooth (300ms)
- MUST prevent default browser "Find" behavior when Cmd+F is pressed
- Focus mode MUST center timeline with max-width constraint

## Acceptance Criteria

- [ ] FocusModeToggle button renders correctly
- [ ] Clicking button toggles focus mode on/off
- [ ] Button shows "Focus Mode" when off, "Exit Focus" when on
- [ ] Keyboard shortcut Cmd+F / Ctrl+F toggles focus mode
- [ ] Sidebar hides smoothly when focus mode is enabled
- [ ] Timeline centers and expands when focus mode is enabled
- [ ] Focus mode preference persists between sessions
- [ ] Button visual state changes when active (primary color)
- [ ] Sidebar width animates from 320px → 0px
- [ ] Sidebar opacity animates from 1 → 0
- [ ] No layout shift during transition

## Visual Reference

### Normal Mode
```
┌──────────────────────────────────────────────────────────────┐
│ Journal                              [Focus Mode]            │
├────────────────────────────────────┬─────────────────────────┤
│                                    │                         │
│  Today's Entry                     │  [Calendar Heat Map]    │
│  [Editor]                          │                         │
│                                    │  [Today's Notes List]   │
│                                    │                         │
│  Yesterday's Entry                 │  [Density Slider]       │
│  [Preview]                         │                         │
│                                    │                         │
└────────────────────────────────────┴─────────────────────────┘
```

### Focus Mode
```
┌──────────────────────────────────────────────────────────────┐
│ Journal                              [Exit Focus]            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│            Today's Entry                                     │
│            [Editor - Centered & Expanded]                    │
│                                                              │
│                                                              │
│            Yesterday's Entry (dimmed)                        │
│            [Preview]                                         │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Animation Details

```css
/* Sidebar collapse animation */
.sidebar {
  width: 320px;
  opacity: 1;
  transition: width 300ms ease, opacity 300ms ease;
}

.sidebar-hidden {
  width: 0;
  opacity: 0;
  overflow: hidden;
}

/* Timeline centering animation */
.timeline {
  max-width: 100%;
  margin: 0 auto;
  transition: max-width 300ms ease;
}

.timeline-focused {
  max-width: 896px; /* 4xl */
}
```

## Testing Instructions

1. Open journal page
2. Click "Focus Mode" button → Sidebar should hide
3. Timeline should center and expand
4. Button should change to "Exit Focus"
5. Press Cmd+F (Mac) or Ctrl+F (Windows) → Should toggle
6. Refresh page → Focus mode state should persist
7. Click "Exit Focus" → Sidebar should reappear

## Edge Cases to Handle

- What if user presses Cmd+F while typing in editor?
  - Prevent default to avoid browser "Find" dialog
- What if window is very narrow?
  - Ensure timeline doesn't overflow in focus mode
- What if user has multiple tabs open?
  - Each tab has its own focus mode state

## Performance Considerations

- Use `transition-all` sparingly (specify properties: width, opacity)
- Zustand persist middleware should debounce writes
- Keyboard event listener should be cleaned up on unmount

## Next Steps

After completing focus mode, proceed to `08-density-slider.md` to implement the layout density control (compact/balanced/spacious).
