// Use virtualized version for performance with large task lists
export { VirtualizedUpcomingView as UpcomingView } from "./virtualized-upcoming-view"
export { default } from "./virtualized-upcoming-view"

// Keep original for reference/fallback if needed
export { UpcomingView as UpcomingViewLegacy } from "./upcoming-view"
