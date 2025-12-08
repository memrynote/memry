# 09 - Keyboard Shortcuts & Navigation

## Context

We now have:
- Timeline with scrollable day cards
- Focus mode toggle
- Density controls
- Basic keyboard support (Cmd+F for focus mode)

Now we implement a **complete keyboard shortcut system** for power users to navigate the journal without touching the mouse. This includes:
- Jump to today
- Navigate between days
- Open date picker
- Toggle focus mode
- Show keyboard shortcuts help dialog

## Objective

Create a comprehensive keyboard navigation system with:
1. All shortcuts defined in a central config
2. Visual shortcuts help dialog (Cmd+/)
3. Platform-specific handling (Mac vs Windows)
4. Conflict prevention with editor shortcuts

## Requirements

### Keyboard Shortcuts Specification

| Shortcut | Action | Description |
|----------|--------|-------------|
| `Cmd/Ctrl + T` | Jump to today | Scroll timeline to today's entry |
| `Cmd/Ctrl + J` | Open date picker | Jump to specific date |
| `Cmd/Ctrl + ↑` | Previous day | Scroll to previous day card |
| `Cmd/Ctrl + ↓` | Next day | Scroll to next day card |
| `Cmd/Ctrl + F` | Toggle focus mode | Hide/show sidebar |
| `Cmd/Ctrl + /` | Show shortcuts help | Display keyboard shortcuts dialog |
| `Cmd/Ctrl + -` | Decrease density | Compact → Balanced → Spacious |
| `Cmd/Ctrl + =` | Increase density | Spacious → Balanced → Compact |
| `Esc` | Close dialogs | Close shortcuts help or date picker |

### Shortcuts Configuration

Create `src/renderer/src/lib/journal/shortcuts.ts`:

```typescript
export interface ShortcutConfig {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  label: string;
  description: string;
  category: 'navigation' | 'view' | 'editing';
  action: string; // Unique action identifier
}

export const SHORTCUTS: ShortcutConfig[] = [
  // Navigation
  {
    key: 't',
    meta: true,
    label: '⌘T',
    description: 'Jump to today',
    category: 'navigation',
    action: 'jumpToToday'
  },
  {
    key: 'j',
    meta: true,
    label: '⌘J',
    description: 'Jump to date',
    category: 'navigation',
    action: 'openDatePicker'
  },
  {
    key: 'ArrowUp',
    meta: true,
    label: '⌘↑',
    description: 'Previous day',
    category: 'navigation',
    action: 'previousDay'
  },
  {
    key: 'ArrowDown',
    meta: true,
    label: '⌘↓',
    description: 'Next day',
    category: 'navigation',
    action: 'nextDay'
  },

  // View
  {
    key: 'f',
    meta: true,
    label: '⌘F',
    description: 'Toggle focus mode',
    category: 'view',
    action: 'toggleFocusMode'
  },
  {
    key: '-',
    meta: true,
    label: '⌘-',
    description: 'Decrease density',
    category: 'view',
    action: 'decreaseDensity'
  },
  {
    key: '=',
    meta: true,
    label: '⌘=',
    description: 'Increase density',
    category: 'view',
    action: 'increaseDensity'
  },
  {
    key: '/',
    meta: true,
    label: '⌘/',
    description: 'Show keyboard shortcuts',
    category: 'view',
    action: 'showShortcuts'
  }
];

/**
 * Convert shortcuts for Windows (Ctrl instead of Cmd).
 */
export function getPlatformShortcuts(): ShortcutConfig[] {
  const isMac = navigator.platform.toLowerCase().includes('mac');

  return SHORTCUTS.map((shortcut) => ({
    ...shortcut,
    label: isMac ? shortcut.label : shortcut.label.replace('⌘', 'Ctrl+')
  }));
}
```

### Keyboard Shortcuts Hook

Extend `src/renderer/src/lib/hooks/useKeyboardShortcuts.ts`:

```typescript
import { useEffect, useCallback } from 'react';
import type { ShortcutConfig } from '@/lib/journal/shortcuts';

interface ShortcutHandler {
  [action: string]: () => void;
}

/**
 * Register multiple keyboard shortcuts with action handlers.
 */
export function useJournalShortcuts(
  shortcuts: ShortcutConfig[],
  handlers: ShortcutHandler
) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea (except our editor)
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        // Allow shortcuts in Tiptap editor
        if (!target.closest('.ProseMirror')) {
          return;
        }
      }

      for (const shortcut of shortcuts) {
        const { key, ctrl = false, meta = false, shift = false, action } = shortcut;

        const keyMatch = event.key === key;
        const ctrlMatch = ctrl ? event.ctrlKey : !event.ctrlKey;
        const metaMatch = meta ? event.metaKey : !event.metaKey;
        const shiftMatch = shift ? event.shiftKey : !event.shiftKey;

        if (keyMatch && ctrlMatch && metaMatch && shiftMatch) {
          event.preventDefault();
          const handler = handlers[action];
          if (handler) {
            handler();
          }
          break;
        }
      }
    },
    [shortcuts, handlers]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
```

### Shortcuts Help Dialog

Create `src/renderer/src/components/journal/ShortcutsDialog.tsx`:

```typescript
import React from 'react';
import { X } from 'lucide-react';
import { SHORTCUTS, getPlatformShortcuts } from '@/lib/journal/shortcuts';
import { cn } from '@/lib/utils';

interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const shortcuts = getPlatformShortcuts();

  const categories = {
    navigation: shortcuts.filter((s) => s.category === 'navigation'),
    view: shortcuts.filter((s) => s.category === 'view'),
    editing: shortcuts.filter((s) => s.category === 'editing')
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="rounded-md p-2 hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Shortcuts grid */}
        <div className="space-y-6">
          {/* Navigation section */}
          {categories.navigation.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Navigation
              </h3>
              <div className="space-y-2">
                {categories.navigation.map((shortcut) => (
                  <ShortcutRow key={shortcut.action} shortcut={shortcut} />
                ))}
              </div>
            </div>
          )}

          {/* View section */}
          {categories.view.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                View
              </h3>
              <div className="space-y-2">
                {categories.view.map((shortcut) => (
                  <ShortcutRow key={shortcut.action} shortcut={shortcut} />
                ))}
              </div>
            </div>
          )}

          {/* Editing section */}
          {categories.editing.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Editing
              </h3>
              <div className="space-y-2">
                {categories.editing.map((shortcut) => (
                  <ShortcutRow key={shortcut.action} shortcut={shortcut} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 border-t pt-4 text-center text-sm text-muted-foreground">
          Press <kbd className="kbd">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}

function ShortcutRow({ shortcut }: { shortcut: ShortcutConfig }) {
  return (
    <div className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-accent">
      <span className="text-sm">{shortcut.description}</span>
      <kbd className="kbd">{shortcut.label}</kbd>
    </div>
  );
}
```

Add kbd styles to your global CSS or Tailwind config:

```css
/* Keyboard shortcut badge styling */
.kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem 0.5rem;
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  color: hsl(var(--foreground));
  background-color: hsl(var(--muted));
  border: 1px solid hsl(var(--border));
  border-radius: 0.375rem;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
}
```

### Date Picker Dialog (Simple Version)

Create `src/renderer/src/components/journal/DatePickerDialog.tsx`:

```typescript
import React, { useState } from 'react';
import { format } from 'date-fns';
import { X, Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DatePickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelectDate: (date: Date) => void;
}

export function DatePickerDialog({ open, onClose, onSelectDate }: DatePickerDialogProps) {
  const [inputValue, setInputValue] = useState('');

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const date = new Date(inputValue);
      if (!isNaN(date.getTime())) {
        onSelectDate(date);
        onClose();
      }
    } catch {
      // Invalid date, do nothing
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Jump to Date</h2>
          </div>
          <button onClick={onClose} className="rounded-md p-2 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <input
            type="date"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            autoFocus
          />
          <button
            type="submit"
            className="mt-4 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Jump to Date
          </button>
        </form>

        <p className="mt-4 text-xs text-muted-foreground">
          Or use <kbd className="kbd">⌘↑</kbd> and <kbd className="kbd">⌘↓</kbd> to navigate
        </p>
      </div>
    </div>
  );
}
```

### Integration in JournalPage

Update `JournalPage.tsx` to wire up all shortcuts:

```typescript
import React, { useState, useRef } from 'react';
import { JournalTimeline } from '@/components/journal/JournalTimeline';
import { ShortcutsDialog } from '@/components/journal/ShortcutsDialog';
import { DatePickerDialog } from '@/components/journal/DatePickerDialog';
import { useJournalStore } from '@/lib/stores/journal-store';
import { useJournalShortcuts } from '@/lib/hooks/useKeyboardShortcuts';
import { SHORTCUTS } from '@/lib/journal/shortcuts';

export function JournalPage() {
  const { density, focusMode, toggleFocusMode, setDensity } = useJournalStore();
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const timelineRef = useRef<any>(null);

  // Register all keyboard shortcuts
  useJournalShortcuts(SHORTCUTS, {
    jumpToToday: () => {
      timelineRef.current?.scrollToDate(new Date());
    },
    openDatePicker: () => {
      setShowDatePicker(true);
    },
    previousDay: () => {
      timelineRef.current?.scrollToPreviousDay();
    },
    nextDay: () => {
      timelineRef.current?.scrollToNextDay();
    },
    toggleFocusMode: () => {
      toggleFocusMode();
    },
    decreaseDensity: () => {
      if (density === 'spacious') setDensity('balanced');
      else if (density === 'balanced') setDensity('compact');
    },
    increaseDensity: () => {
      if (density === 'compact') setDensity('balanced');
      else if (density === 'balanced') setDensity('spacious');
    },
    showShortcuts: () => {
      setShowShortcutsDialog(true);
    }
  });

  // Close dialogs on Esc
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowShortcutsDialog(false);
        setShowDatePicker(false);
      }
    };

    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  return (
    <>
      <div className="flex h-full flex-col">
        {/* ... timeline and sidebar ... */}
        <JournalTimeline ref={timelineRef} density={density} focusMode={focusMode} />
      </div>

      {/* Dialogs */}
      <ShortcutsDialog open={showShortcutsDialog} onClose={() => setShowShortcutsDialog(false)} />
      <DatePickerDialog
        open={showDatePicker}
        onClose={() => setShowDatePicker(false)}
        onSelectDate={(date) => timelineRef.current?.scrollToDate(date)}
      />
    </>
  );
}
```

### Add Timeline Methods

Update `JournalTimeline.tsx` to expose navigation methods:

```typescript
import { forwardRef, useImperativeHandle } from 'react';

export interface JournalTimelineHandle {
  scrollToDate: (date: Date) => void;
  scrollToNextDay: () => void;
  scrollToPreviousDay: () => void;
}

export const JournalTimeline = forwardRef<JournalTimelineHandle, JournalTimelineProps>(
  (props, ref) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [centerDate, setCenterDate] = useState<Date | null>(null);

    useImperativeHandle(ref, () => ({
      scrollToDate: (date: Date) => {
        scrollToDate(date, scrollRef);
      },
      scrollToNextDay: () => {
        if (centerDate) {
          const nextDay = new Date(centerDate);
          nextDay.setDate(nextDay.getDate() + 1);
          scrollToDate(nextDay, scrollRef);
        }
      },
      scrollToPreviousDay: () => {
        if (centerDate) {
          const prevDay = new Date(centerDate);
          prevDay.setDate(prevDay.getDate() - 1);
          scrollToDate(prevDay, scrollRef);
        }
      }
    }));

    // ... rest of component
  }
);
```

## Technical Constraints

- MUST prevent default browser behavior for all shortcuts
- MUST NOT trigger shortcuts when typing in inputs (except Tiptap editor)
- MUST support both Mac (Cmd) and Windows (Ctrl) modifiers
- MUST show platform-specific labels (⌘ on Mac, Ctrl+ on Windows)
- Esc MUST close all dialogs
- Shortcuts dialog MUST be keyboard-navigable
- Date picker MUST use native input type="date"

## Acceptance Criteria

- [ ] All shortcuts work as specified in table
- [ ] Cmd+T scrolls to today
- [ ] Cmd+J opens date picker dialog
- [ ] Cmd+↑ scrolls to previous day
- [ ] Cmd+↓ scrolls to next day
- [ ] Cmd+F toggles focus mode
- [ ] Cmd+/ shows shortcuts help dialog
- [ ] Cmd+- and Cmd+= change density
- [ ] Esc closes all dialogs
- [ ] Shortcuts don't trigger when typing in editor
- [ ] Platform-specific labels show correctly (Mac vs Windows)
- [ ] Date picker allows selecting any date
- [ ] Shortcuts help dialog is visually clear
- [ ] All shortcuts are documented in help dialog

## Visual Reference

### Shortcuts Help Dialog

```
┌────────────────────────────────────────────────────┐
│ Keyboard Shortcuts                            [X]  │
├────────────────────────────────────────────────────┤
│                                                    │
│ NAVIGATION                                         │
│ Jump to today                            [⌘T]     │
│ Jump to date                             [⌘J]     │
│ Previous day                             [⌘↑]     │
│ Next day                                 [⌘↓]     │
│                                                    │
│ VIEW                                               │
│ Toggle focus mode                        [⌘F]     │
│ Decrease density                         [⌘-]     │
│ Increase density                         [⌘=]     │
│ Show keyboard shortcuts                  [⌘/]     │
│                                                    │
│ Press Esc to close                                 │
└────────────────────────────────────────────────────┘
```

### Date Picker Dialog

```
┌───────────────────────────────────────┐
│ 📅 Jump to Date                  [X]  │
├───────────────────────────────────────┤
│                                       │
│ ┌───────────────────────────────────┐ │
│ │ 2024-01-15                        │ │
│ └───────────────────────────────────┘ │
│                                       │
│ [       Jump to Date       ]          │
│                                       │
│ Or use ⌘↑ and ⌘↓ to navigate          │
└───────────────────────────────────────┘
```

## Testing Instructions

1. Open journal page
2. Press Cmd+/ → Shortcuts help should appear
3. Press Esc → Dialog should close
4. Press Cmd+T → Should scroll to today
5. Press Cmd+J → Date picker should appear
6. Select a date → Should jump to that date
7. Press Cmd+↑ repeatedly → Should navigate up
8. Press Cmd+↓ repeatedly → Should navigate down
9. Press Cmd+F → Focus mode should toggle
10. Press Cmd+- → Density should decrease
11. Press Cmd+= → Density should increase

## Performance Considerations

- Shortcuts listener should be a single global handler
- Debounce rapid arrow key presses if needed
- Dialog renders should not block main thread

## Next Steps

After completing keyboard shortcuts, proceed to `10-animations-polish.md` to add smooth animations and transitions.
