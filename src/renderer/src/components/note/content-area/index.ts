/**
 * Content Area
 * Barrel exports for the rich text editor component
 */

// Main component
export { ContentArea } from './ContentArea'

// Sub-components
export { ContentDivider } from './ContentDivider'
export { FloatingToolbar } from './FloatingToolbar'
export { SlashCommandMenu, filterSlashCommands, getAllSlashCommands, SLASH_COMMAND_GROUPS } from './SlashCommandMenu'

// Extensions
export { HeadingExtractor, SlashCommands, Callout } from './extensions'

// Types
export type {
  ContentAreaProps,
  HeadingInfo,
  SelectionInfo,
  SlashCommandItem,
  SlashCommandGroupConfig,
  SlashCommandGroup,
  CalloutVariant,
  CalloutAttributes
} from './types'
