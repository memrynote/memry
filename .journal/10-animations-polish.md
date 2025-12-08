# 10 - Animations & Polish

## Context

We now have all core functionality:
- Timeline with fade-to-focus
- Rich text editor with auto-save
- Calendar heat map and notes list
- Focus mode and density controls
- Comprehensive keyboard shortcuts

Now we add **animations and polish** to make the experience feel smooth, delightful, and professional.

## Objective

Enhance the user experience with:
1. Smooth scroll animations with custom easing
2. Micro-interactions (hover, click, focus states)
3. Loading states and skeletons
4. Entry/exit animations for dialogs
5. Stagger animations for lists
6. Haptic feedback indicators (visual, not actual haptic)

## Requirements

### 1. Smooth Scroll to Date Animation

Current implementation uses `scrollIntoView({ behavior: 'smooth' })`. Enhance with custom scroll animation:

Create `src/renderer/src/lib/journal/animations.ts`:

```typescript
/**
 * Smooth scroll to element with custom easing and duration.
 */
export function smoothScrollTo(
  container: HTMLElement,
  target: HTMLElement,
  duration: number = 800
) {
  const startPosition = container.scrollTop;
  const targetPosition = target.offsetTop - container.clientHeight / 2 + target.clientHeight / 2;
  const distance = targetPosition - startPosition;
  const startTime = performance.now();

  function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function scroll(currentTime: number) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easing = easeInOutCubic(progress);

    container.scrollTop = startPosition + distance * easing;

    if (progress < 1) {
      requestAnimationFrame(scroll);
    }
  }

  requestAnimationFrame(scroll);
}
```

Update scroll functions in `JournalTimeline.tsx`:

```typescript
import { smoothScrollTo } from '@/lib/journal/animations';

export function scrollToDate(date: Date, scrollRef: RefObject<HTMLDivElement>) {
  const container = scrollRef.current;
  if (!container) return;

  const dateStr = toISODate(date);
  const targetCard = container.querySelector(`[data-date="${dateStr}"]`) as HTMLElement;

  if (targetCard) {
    smoothScrollTo(container, targetCard, 800);
  }
}
```

### 2. Day Card Entrance Animations

Add stagger animation when day cards first appear:

```typescript
// In DayCard.tsx
import { useState, useEffect } from 'react';

export function DayCard(props: DayCardProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Delay based on index to create stagger effect
    const timer = setTimeout(() => setIsVisible(true), props.index * 50);
    return () => clearTimeout(timer);
  }, [props.index]);

  return (
    <div
      className={cn(
        'transition-all duration-500',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
      )}
      style={{
        transitionDelay: `${props.index * 30}ms`
      }}
    >
      {/* ... card content ... */}
    </div>
  );
}
```

### 3. Dialog Enter/Exit Animations

Add smooth fade and scale animations to dialogs:

```typescript
// In ShortcutsDialog.tsx
import { useEffect, useState } from 'react';

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (open) {
      setIsAnimating(true);
    }
  }, [open]);

  const handleClose = () => {
    setIsAnimating(false);
    setTimeout(() => onClose(), 200); // Wait for animation
  };

  if (!open && !isAnimating) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm transition-opacity duration-200',
        isAnimating ? 'opacity-100' : 'opacity-0'
      )}
      onClick={handleClose}
    >
      <div
        className={cn(
          'w-full max-w-2xl rounded-lg border border-border bg-card p-6 shadow-2xl transition-all duration-200',
          isAnimating ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ... dialog content ... */}
      </div>
    </div>
  );
}
```

### 4. Loading Skeletons

Create skeleton components for loading states:

Create `src/renderer/src/components/journal/LoadingSkeleton.tsx`:

```typescript
import React from 'react';
import { cn } from '@/lib/utils';

export function DayCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-lg border border-border bg-card p-6', className)}>
      {/* Date header skeleton */}
      <div className="mb-4 h-8 w-48 rounded bg-muted" />

      {/* Content skeleton */}
      <div className="space-y-3">
        <div className="h-4 w-full rounded bg-muted" />
        <div className="h-4 w-5/6 rounded bg-muted" />
        <div className="h-4 w-4/6 rounded bg-muted" />
      </div>

      {/* Footer skeleton */}
      <div className="mt-4 h-3 w-32 rounded bg-muted" />
    </div>
  );
}

export function CalendarSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-lg border border-border bg-card p-4', className)}>
      <div className="mb-4 h-5 w-32 rounded bg-muted" />
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 35 }).map((_, i) => (
          <div key={i} className="h-8 w-8 rounded bg-muted" />
        ))}
      </div>
    </div>
  );
}
```

### 5. Hover and Click Micro-Interactions

Add satisfying feedback to interactive elements:

```css
/* Add to global CSS or component styles */

/* Button press animation */
.btn-press {
  transition: transform 150ms ease;
}

.btn-press:active {
  transform: scale(0.95);
}

/* Smooth hover elevation */
.hover-lift {
  transition: transform 200ms ease, box-shadow 200ms ease;
}

.hover-lift:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

/* Focus ring animation */
.focus-ring {
  transition: outline 200ms ease, outline-offset 200ms ease;
}

.focus-ring:focus-visible {
  outline: 2px solid hsl(var(--primary));
  outline-offset: 2px;
}

/* Calendar cell scale on click */
.calendar-cell {
  transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1);
}

.calendar-cell:hover {
  transform: scale(1.1);
}

.calendar-cell:active {
  transform: scale(0.95);
}
```

### 6. Editor Focus Animation

Add subtle highlight when editor comes into focus:

```typescript
// In JournalEditor.tsx
const editor = useEditor({
  // ... existing config
  onFocus: () => {
    // Add highlight class
    editorRef.current?.classList.add('editor-focused');
  },
  onBlur: () => {
    // Remove highlight class
    editorRef.current?.classList.remove('editor-focused');
  }
});
```

```css
/* Editor focus state */
.editor-focused {
  @apply ring-2 ring-primary ring-offset-2;
  transition: box-shadow 200ms ease;
}
```

### 7. Notes List Item Animations

Stagger animation for notes appearing in sidebar:

```typescript
// In TodaysNotesList.tsx
function NoteItem({ note, index }: { note: JournalNote; index: number }) {
  return (
    <div
      className="animate-in fade-in slide-in-from-top-2"
      style={{
        animationDelay: `${index * 50}ms`,
        animationDuration: '300ms',
        animationFillMode: 'backwards'
      }}
    >
      {/* ... note content ... */}
    </div>
  );
}
```

Add Tailwind animation utilities if not already configured:

```typescript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'slide-in-from-top': {
          from: { transform: 'translateY(-8px)' },
          to: { transform: 'translateY(0)' }
        }
      },
      animation: {
        'fade-in': 'fade-in 300ms ease-out',
        'slide-in-from-top-2': 'slide-in-from-top 300ms ease-out'
      }
    }
  }
};
```

### 8. Focus Mode Transition

Enhance focus mode transition with smooth sidebar collapse:

```typescript
// In JournalPage.tsx
<aside
  className={cn(
    'w-80 shrink-0 overflow-hidden border-l transition-all duration-300 ease-in-out',
    focusMode && 'w-0 opacity-0 -translate-x-4'
  )}
>
  <JournalSidebar />
</aside>

<div
  className={cn(
    'flex-1 transition-all duration-300 ease-in-out',
    focusMode && 'mx-auto max-w-4xl px-8'
  )}
>
  <JournalTimeline />
</div>
```

### 9. Calendar Date Click Ripple Effect

Add ripple animation when clicking calendar dates:

```typescript
// In CalendarCell component
function CalendarCell({ day, onClick }: CalendarCellProps) {
  const [ripple, setRipple] = useState(false);

  const handleClick = () => {
    setRipple(true);
    setTimeout(() => setRipple(false), 600);
    onClick(day.date);
  };

  return (
    <button
      onClick={handleClick}
      className={cn(
        'relative overflow-hidden',
        // ... other classes
      )}
    >
      {format(day.date, 'd')}

      {/* Ripple effect */}
      {ripple && (
        <span className="absolute inset-0 animate-ripple rounded bg-primary/20" />
      )}
    </button>
  );
}
```

```css
/* Ripple animation */
@keyframes ripple {
  0% {
    transform: scale(0);
    opacity: 1;
  }
  100% {
    transform: scale(2);
    opacity: 0;
  }
}

.animate-ripple {
  animation: ripple 600ms ease-out;
}
```

### 10. Save Indicator Animation

Show subtle save indicator when auto-save triggers:

Create `src/renderer/src/components/journal/SaveIndicator.tsx`:

```typescript
import React, { useEffect, useState } from 'react';
import { Check, Cloud } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SaveIndicatorProps {
  isSaving: boolean;
  lastSaved?: Date;
}

export function SaveIndicator({ isSaving, lastSaved }: SaveIndicatorProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isSaving || lastSaved) {
      setShow(true);
      const timer = setTimeout(() => setShow(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [isSaving, lastSaved]);

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 flex items-center gap-2 rounded-full bg-card px-4 py-2 text-sm shadow-lg transition-all duration-300',
        show ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
      )}
    >
      {isSaving ? (
        <>
          <Cloud className="h-4 w-4 animate-pulse text-muted-foreground" />
          <span className="text-muted-foreground">Saving...</span>
        </>
      ) : (
        <>
          <Check className="h-4 w-4 text-green-500" />
          <span className="text-muted-foreground">Saved</span>
        </>
      )}
    </div>
  );
}
```

## Technical Constraints

- MUST use CSS transitions where possible (better performance than JS animations)
- MUST use `will-change` sparingly (only during active animations)
- MUST clean up animation timers and listeners on unmount
- Animations MUST respect `prefers-reduced-motion` media query
- MUST use `requestAnimationFrame` for scroll animations
- Stagger delays MUST not exceed 1 second total

## Acceptance Criteria

- [ ] Scroll to date uses custom easing (800ms cubic-bezier)
- [ ] Day cards animate in with stagger effect
- [ ] Dialogs fade and scale in/out smoothly
- [ ] Loading skeletons show during initial load
- [ ] Buttons have press animation (scale 0.95)
- [ ] Calendar cells scale on hover and click
- [ ] Editor shows focus ring on focus
- [ ] Notes list items stagger in
- [ ] Focus mode transition is smooth
- [ ] Save indicator appears and fades out
- [ ] All animations respect prefers-reduced-motion
- [ ] No jank or layout shift during animations

## Accessibility: Reduced Motion

Respect user's motion preferences:

```css
/* Disable animations for users who prefer reduced motion */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Or in React:

```typescript
function useReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const listener = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, []);

  return prefersReducedMotion;
}

// Usage
const reducedMotion = useReducedMotion();
const duration = reducedMotion ? 0 : 800;
```

## Visual Polish Checklist

- [ ] Consistent transition timing (150ms for micro, 300ms for standard, 800ms for scroll)
- [ ] Smooth easing curves (cubic-bezier for natural feel)
- [ ] No abrupt state changes
- [ ] Loading states for all async operations
- [ ] Hover states on all interactive elements
- [ ] Focus states visible for keyboard navigation
- [ ] Disabled states clearly distinguishable
- [ ] Success/error feedback animations

## Performance Optimization

```typescript
// Use will-change during active animations only
function AnimatedElement() {
  const [isAnimating, setIsAnimating] = useState(false);

  return (
    <div
      style={{
        willChange: isAnimating ? 'transform, opacity' : 'auto'
      }}
      onAnimationStart={() => setIsAnimating(true)}
      onAnimationEnd={() => setIsAnimating(false)}
    />
  );
}
```

## Testing Instructions

1. Navigate between dates → Scroll should be smooth with easing
2. Open shortcuts dialog → Should fade and scale in
3. Close dialog → Should fade and scale out
4. Add a new note → Should appear with stagger
5. Toggle focus mode → Sidebar should smoothly collapse
6. Click calendar date → Should show ripple effect
7. Hover over buttons → Should have subtle lift
8. Click buttons → Should scale down
9. Focus editor → Should show ring animation
10. Watch auto-save → Save indicator should appear

## Next Steps

After completing animations, proceed to `11-empty-states.md` to implement first-time user experience and empty states.
