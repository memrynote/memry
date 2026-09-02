# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Product design

Read the root `PRODUCT.md` and `DESIGN.md` before mobile UI work. `DESIGN.md` is the global Memry product design authority. Desktop is the current reference implementation.

Mobile is in development and unreleased. Its current screens and Figma files are implementation inputs, not a separate design authority. Preserve Memry's semantic colors, typography roles, spacing rhythm, hierarchy, states, copy, and restraint. Adapt navigation, controls, touch targets, safe areas, gestures, and haptics to native mobile conventions.

New product UI uses `src/theme/` and `src/components/ui/`. Do not extend the legacy `src/constants/theme.ts`, `src/hooks/use-theme.ts`, `themed-text.tsx`, or `themed-view.tsx` system. Migrate those consumers when their screens are redesigned.
