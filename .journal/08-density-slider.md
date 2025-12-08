# 08 - Density Slider (Layout Control)

## Context

We now have:
- Day cards with configurable density prop
- Focus mode toggle for distraction-free writing
- Zustand store managing journal preferences

Now we implement the **DensitySlider** - a control that lets users choose between three layout densities:
- **Compact**: Tight spacing, smaller text, more content visible
- **Balanced**: Default, comfortable spacing (recommended)
- **Spacious**: Generous whitespace, larger text, relaxed reading

This is inspired by apps like mymind and Linear that offer visual density controls.

## Objective

Create a toggle component that:
1. Offers three density options: Compact, Balanced, Spacious
2. Updates the `density` state in Zustand store
3. Applies visual changes to day cards, timeline, and editor
4. Persists user preference
5. Shows current selection clearly

## Requirements

### Component File

Create `src/renderer/src/components/journal/DensitySlider.tsx`

### Density Configurations (Already Defined)

These configurations already exist in the types/utilities:

```typescript
const DENSITY_CONFIG = {
  compact: {
    cardGap: 'space-y-4',        // 1rem
    cardPadding: 'p-4',          // 1rem
    fontSize: 'text-sm',
    editorHeight: 'min-h-[12rem]'
  },
  balanced: {
    cardGap: 'space-y-6',        // 1.5rem
    cardPadding: 'p-6',          // 1.5rem
    fontSize: 'text-base',
    editorHeight: 'min-h-[16rem]'
  },
  spacious: {
    cardGap: 'space-y-10',       // 2.5rem
    cardPadding: 'p-8',          // 2rem
    fontSize: 'text-lg',
    editorHeight: 'min-h-[20rem]'
  }
};
```

### Component Design Options

#### Option 1: Segmented Control (Recommended)

A three-option segmented button group:

```typescript
import React from 'react';
import { useJournalStore } from '@/lib/stores/journal-store';
import { cn } from '@/lib/utils';

type DensityOption = 'compact' | 'balanced' | 'spacious';

interface DensityOption {
  value: DensityOption;
  label: string;
  icon: React.ReactNode;
}

const options: DensityOption[] = [
  {
    value: 'compact',
    label: 'Compact',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    )
  },
  {
    value: 'balanced',
    label: 'Balanced',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
      </svg>
    )
  },
  {
    value: 'spacious',
    label: 'Spacious',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 10h16M4 14h16" />
      </svg>
    )
  }
];

export function DensitySlider({ className }: { className?: string }) {
  const { density, setDensity } = useJournalStore();

  return (
    <div className={cn('rounded-lg border border-border bg-card p-4', className)}>
      <h3 className="mb-3 text-sm font-semibold">Layout Density</h3>

      <div className="inline-flex w-full rounded-md border border-border bg-muted/30 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            onClick={() => setDensity(option.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-2 rounded px-3 py-2 text-sm font-medium transition-all',
              density === option.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            title={option.label}
          >
            {option.icon}
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        ))}
      </div>

      {/* Description */}
      <p className="mt-2 text-xs text-muted-foreground">
        {getDensityDescription(density)}
      </p>
    </div>
  );
}

function getDensityDescription(density: DensityOption): string {
  const descriptions = {
    compact: 'Tight spacing, more content visible',
    balanced: 'Comfortable spacing, recommended for most',
    spacious: 'Generous whitespace, relaxed reading'
  };
  return descriptions[density];
}
```

#### Option 2: Icon-Only Toggle (Minimal)

Smaller, icon-only version for compact sidebar:

```typescript
export function DensitySlider({ className }: { className?: string }) {
  const { density, setDensity } = useJournalStore();

  return (
    <div className={cn('flex items-center justify-between', className)}>
      <span className="text-sm font-medium text-muted-foreground">Density</span>

      <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            onClick={() => setDensity(option.value)}
            className={cn(
              'rounded p-2 transition-colors',
              density === option.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            title={option.label}
          >
            {option.icon}
          </button>
        ))}
      </div>
    </div>
  );
}
```

### Apply Density to Components

#### Update JournalTimeline

The timeline already receives `density` prop, just ensure it's connected:

```typescript
// In JournalPage.tsx
const { density } = useJournalStore();

<JournalTimeline density={density} focusMode={focusMode} />
```

#### Update DayCard

The DayCard component already uses `density` prop to apply spacing configs. Ensure DENSITY_CONFIG is used:

```typescript
// In DayCard.tsx
const config = DENSITY_CONFIG[density];

<div className={cn(config.cardPadding, config.minHeight, config.gap)}>
  {/* ... */}
</div>
```

#### Update JournalEditor

Apply density-based sizing to editor:

```typescript
// In JournalEditor.tsx
interface JournalEditorProps {
  // ... existing props
  density?: 'compact' | 'balanced' | 'spacious';
}

export function JournalEditor({ density = 'balanced', ...props }: JournalEditorProps) {
  const config = DENSITY_CONFIG[density];

  return (
    <div className={cn('rounded-lg border', config.editorHeight)}>
      {/* ... */}
    </div>
  );
}
```

### Keyboard Shortcut (Optional Enhancement)

Add keyboard shortcuts for density control:

```typescript
// In JournalPage.tsx
useKeyboardShortcuts([
  {
    key: '-',
    meta: true,
    callback: () => {
      // Decrease density: spacious → balanced → compact
      if (density === 'spacious') setDensity('balanced');
      else if (density === 'balanced') setDensity('compact');
    }
  },
  {
    key: '=',
    meta: true,
    callback: () => {
      // Increase density: compact → balanced → spacious
      if (density === 'compact') setDensity('balanced');
      else if (density === 'balanced') setDensity('spacious');
    }
  }
]);
```

## Technical Constraints

- MUST use Zustand store for density state (already set up)
- MUST persist density preference in localStorage
- MUST apply density to: day cards, timeline gap, editor height
- Segmented control MUST highlight active selection
- MUST show description text explaining each option
- Transitions between densities MUST be smooth (use CSS transitions)

## Acceptance Criteria

- [ ] DensitySlider component renders correctly
- [ ] Three options visible: Compact, Balanced, Spacious
- [ ] Active option is highlighted with background color
- [ ] Clicking an option updates density in store
- [ ] Day card spacing changes when density changes
- [ ] Timeline gap changes when density changes
- [ ] Editor height changes when density changes
- [ ] Density preference persists between sessions
- [ ] Description text updates based on selection
- [ ] Icons are distinct for each density level
- [ ] Hover state on inactive options
- [ ] Smooth transition when switching densities

## Visual Reference

### Segmented Control Design

```
┌────────────────────────────────────────┐
│ Layout Density                         │
├────────────────────────────────────────┤
│                                        │
│ ┌──────────────────────────────────┐  │
│ │ [≡] Compact │ [=] Balanced │ [_] │  │
│ │             │  (active)    │     │  │
│ └──────────────────────────────────┘  │
│                                        │
│ Comfortable spacing, recommended       │
│ for most                               │
└────────────────────────────────────────┘
```

### Icon-Only Variant

```
┌────────────────────────────────────────┐
│ Density        [≡] [=] [_]            │
│                    ^^^                 │
│                  active                │
└────────────────────────────────────────┘
```

## Effect Comparison

### Compact Mode
- Card padding: 1rem (p-4)
- Card gap: 1rem (space-y-4)
- Font size: text-sm
- Editor height: 12rem
- More entries visible on screen

### Balanced Mode (Default)
- Card padding: 1.5rem (p-6)
- Card gap: 1.5rem (space-y-6)
- Font size: text-base
- Editor height: 16rem
- Comfortable reading experience

### Spacious Mode
- Card padding: 2rem (p-8)
- Card gap: 2.5rem (space-y-10)
- Font size: text-lg
- Editor height: 20rem
- Relaxed, magazine-like layout

## Placement Options

The DensitySlider can be placed:
1. **In sidebar** (below calendar and notes list) ✓ Recommended
2. **In top toolbar** (next to focus mode toggle)
3. **In settings menu** (less discoverable)

Choose option 1 (sidebar) for best visibility and accessibility.

## Responsive Considerations

On narrow screens:
- Hide label text, show only icons
- Reduce padding in segmented control
- Stack vertically if needed

```typescript
// Responsive text hiding
<span className="hidden sm:inline">{option.label}</span>
```

## Testing Instructions

1. Open journal page with sidebar visible
2. Locate DensitySlider widget
3. Click "Compact" → Cards should get tighter
4. Click "Spacious" → Cards should expand with more whitespace
5. Click "Balanced" → Should return to default
6. Refresh page → Density selection should persist
7. Verify editor height changes
8. Verify timeline gap changes
9. Test on narrow screen → Labels should hide

## Performance Considerations

- Density change triggers re-render of all day cards
- Use CSS transitions for smooth spacing changes
- Avoid layout thrashing by batching class updates
- Consider `transition-all` on card containers

## Accessibility Notes

- Each button should have proper title/aria-label
- Active state should be visually distinct (not just color)
- Keyboard navigation should work (tab through options)
- Consider adding aria-pressed to active button

## Next Steps

After completing the density slider, proceed to `09-keyboard-shortcuts.md` to implement all journal navigation keyboard shortcuts.
