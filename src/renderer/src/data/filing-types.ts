// ============================================================================
// FILING DATA MODEL
// ============================================================================
// Core data structures for the folder and tag system.
// Enables organizing inbox items into a hierarchical folder structure
// with flat tags for cross-cutting categorization.

// ============================================================================
// FOLDER SYSTEM
// ============================================================================

/**
 * A folder in the hierarchical filing system.
 * Folders can nest to any depth via parentId references.
 */
export interface Folder {
  /** Unique identifier */
  id: string
  /** Display name */
  name: string
  /** Parent folder ID, null = root level */
  parentId: string | null
  /** Full path like "Work / Projects / Alpha" */
  path: string
  /** Optional Lucide icon name */
  icon?: string
  /** Optional accent color */
  color?: FolderColor
  /** When the folder was created */
  createdAt: Date
  /** Number of items filed in this folder */
  itemCount: number
  /** Whether this is a system folder (Archive, Unsorted) */
  isSystem?: boolean
}

/**
 * Folder accent colors - muted earth tones that complement the app's warm aesthetic
 */
export type FolderColor =
  | 'slate'    // Neutral gray
  | 'stone'    // Warm gray
  | 'amber'    // Warm yellow
  | 'emerald'  // Fresh green
  | 'sky'      // Light blue
  | 'violet'   // Soft purple
  | 'rose'     // Soft pink

/**
 * Color configuration for folder accents
 */
export interface FolderColorConfig {
  /** Background class for folder icon container */
  bg: string
  /** Text/icon color class */
  text: string
  /** Border accent class */
  border: string
}

/**
 * Folder color palette - refined earth tones
 */
export const FOLDER_COLORS: Record<FolderColor, FolderColorConfig> = {
  slate: {
    bg: 'bg-slate-100 dark:bg-slate-800/50',
    text: 'text-slate-600 dark:text-slate-400',
    border: 'border-slate-200 dark:border-slate-700',
  },
  stone: {
    bg: 'bg-stone-100 dark:bg-stone-800/50',
    text: 'text-stone-600 dark:text-stone-400',
    border: 'border-stone-200 dark:border-stone-700',
  },
  amber: {
    bg: 'bg-amber-50 dark:bg-amber-900/30',
    text: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-200 dark:border-amber-800',
  },
  emerald: {
    bg: 'bg-emerald-50 dark:bg-emerald-900/30',
    text: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-200 dark:border-emerald-800',
  },
  sky: {
    bg: 'bg-sky-50 dark:bg-sky-900/30',
    text: 'text-sky-600 dark:text-sky-400',
    border: 'border-sky-200 dark:border-sky-800',
  },
  violet: {
    bg: 'bg-violet-50 dark:bg-violet-900/30',
    text: 'text-violet-600 dark:text-violet-400',
    border: 'border-violet-200 dark:border-violet-800',
  },
  rose: {
    bg: 'bg-rose-50 dark:bg-rose-900/30',
    text: 'text-rose-600 dark:text-rose-400',
    border: 'border-rose-200 dark:border-rose-800',
  },
}

/**
 * Default folder color
 */
export const DEFAULT_FOLDER_COLOR: FolderColor = 'slate'

// ============================================================================
// TAG SYSTEM
// ============================================================================

/**
 * A tag for cross-cutting categorization.
 * Tags are flat (no hierarchy) and can be applied to any item.
 */
export interface Tag {
  /** Unique identifier */
  id: string
  /** Display name (lowercase, no spaces recommended) */
  name: string
  /** Tag color from palette */
  color: TagColor
  /** Number of times this tag has been used */
  usageCount: number
  /** When the tag was created */
  createdAt: Date
}

/**
 * Tag color options - vibrant but not overwhelming
 */
export type TagColor =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'gray'

/**
 * Tag color configuration
 */
export interface TagColorConfig {
  /** Background class for tag badge */
  bg: string
  /** Text color class */
  text: string
  /** Dot/indicator color */
  dot: string
  /** Hover state background */
  hoverBg: string
  /** Border for outlined variant */
  border: string
}

/**
 * Tag color palette - designed to work on warm beige backgrounds
 * Each color has been carefully tuned for legibility and aesthetics
 */
export const TAG_COLORS: Record<TagColor, TagColorConfig> = {
  red: {
    bg: 'bg-red-100 dark:bg-red-900/40',
    text: 'text-red-700 dark:text-red-300',
    dot: 'bg-red-500',
    hoverBg: 'hover:bg-red-200 dark:hover:bg-red-900/60',
    border: 'border-red-200 dark:border-red-800',
  },
  orange: {
    bg: 'bg-orange-100 dark:bg-orange-900/40',
    text: 'text-orange-700 dark:text-orange-300',
    dot: 'bg-orange-500',
    hoverBg: 'hover:bg-orange-200 dark:hover:bg-orange-900/60',
    border: 'border-orange-200 dark:border-orange-800',
  },
  yellow: {
    bg: 'bg-yellow-100 dark:bg-yellow-900/40',
    text: 'text-yellow-700 dark:text-yellow-300',
    dot: 'bg-yellow-500',
    hoverBg: 'hover:bg-yellow-200 dark:hover:bg-yellow-900/60',
    border: 'border-yellow-200 dark:border-yellow-800',
  },
  green: {
    bg: 'bg-green-100 dark:bg-green-900/40',
    text: 'text-green-700 dark:text-green-300',
    dot: 'bg-green-500',
    hoverBg: 'hover:bg-green-200 dark:hover:bg-green-900/60',
    border: 'border-green-200 dark:border-green-800',
  },
  blue: {
    bg: 'bg-blue-100 dark:bg-blue-900/40',
    text: 'text-blue-700 dark:text-blue-300',
    dot: 'bg-blue-500',
    hoverBg: 'hover:bg-blue-200 dark:hover:bg-blue-900/60',
    border: 'border-blue-200 dark:border-blue-800',
  },
  purple: {
    bg: 'bg-purple-100 dark:bg-purple-900/40',
    text: 'text-purple-700 dark:text-purple-300',
    dot: 'bg-purple-500',
    hoverBg: 'hover:bg-purple-200 dark:hover:bg-purple-900/60',
    border: 'border-purple-200 dark:border-purple-800',
  },
  gray: {
    bg: 'bg-gray-100 dark:bg-gray-800/60',
    text: 'text-gray-700 dark:text-gray-300',
    dot: 'bg-gray-500',
    hoverBg: 'hover:bg-gray-200 dark:hover:bg-gray-700/60',
    border: 'border-gray-200 dark:border-gray-700',
  },
}

/**
 * Default tag color for new tags
 */
export const DEFAULT_TAG_COLOR: TagColor = 'blue'

/**
 * All available tag colors as array for UI selectors
 */
export const TAG_COLOR_OPTIONS: TagColor[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'gray',
]

// ============================================================================
// AI SUGGESTION SYSTEM
// ============================================================================

/**
 * A folder suggestion from AI analysis
 */
export interface FolderSuggestion {
  /** Suggested folder ID */
  folderId: string
  /** Confidence score 0-100 */
  confidence: number
  /** Human-readable reason for suggestion */
  reason: string
  /** IDs of similar items already in this folder */
  similarItemIds: string[]
}

/**
 * AI-generated suggestions for filing an item
 */
export interface AISuggestions {
  /** Highest confidence suggestion (null if none confident enough) */
  primary: FolderSuggestion | null
  /** Other possible destinations */
  alternatives: FolderSuggestion[]
  /** When suggestions were generated */
  generatedAt: Date
  /** Whether suggestions are still being computed */
  isLoading?: boolean
}

/**
 * Confidence thresholds for AI suggestions
 */
export const AI_CONFIDENCE_THRESHOLDS = {
  /** Show with prominent "Accept" button */
  HIGH: 80,
  /** Show as selectable option */
  MEDIUM: 50,
  /** Don't show to user */
  LOW: 50,
} as const

/**
 * Factors that influence AI suggestions
 */
export type SuggestionFactor =
  | 'content_similarity'  // Content matches items in folder
  | 'domain_match'        // Same domain for links
  | 'tag_overlap'         // Shares tags with folder items
  | 'recent_pattern'      // User recently filed similar items here
  | 'title_match'         // Title keywords match folder items

// ============================================================================
// RECENT TRACKING
// ============================================================================

/**
 * Recently used folders for quick access
 */
export interface RecentFolders {
  /** Folder IDs in order of most recent first */
  folderIds: string[]
  /** When the list was last updated */
  updatedAt: Date
}

/**
 * Recently used tags for quick access
 */
export interface RecentTags {
  /** Tag IDs in order of most recent first */
  tagIds: string[]
  /** When the list was last updated */
  updatedAt: Date
}

/**
 * Maximum items to track in recent lists
 */
export const RECENT_LIMITS = {
  FOLDERS: 5,
  TAGS: 10,
} as const

// ============================================================================
// FILING STATE
// ============================================================================

/**
 * Complete filing state for the application
 */
export interface FilingState {
  /** All folders in the system */
  folders: Folder[]
  /** All tags in the system */
  tags: Tag[]
  /** Recently used folder IDs */
  recentFolderIds: string[]
  /** Recently used tag IDs */
  recentTagIds: string[]
  /** Whether data is loading */
  isLoading: boolean
  /** Error message if any */
  error: string | null
}

/**
 * Default/initial filing state
 */
export const defaultFilingState: FilingState = {
  folders: [],
  tags: [],
  recentFolderIds: [],
  recentTagIds: [],
  isLoading: false,
  error: null,
}

// ============================================================================
// FILING ACTIONS
// ============================================================================

/**
 * Result of a filing operation
 */
export interface FileItemResult {
  success: boolean
  /** Updated item ID */
  itemId: string
  /** Destination folder ID */
  folderId: string
  /** Error message if failed */
  error?: string
}

/**
 * Result of a tagging operation
 */
export interface TagItemResult {
  success: boolean
  /** Updated item ID */
  itemId: string
  /** Tag IDs that were added */
  addedTagIds: string[]
  /** Tag IDs that were removed */
  removedTagIds: string[]
  /** Error message if failed */
  error?: string
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

/**
 * Check if a folder is a root folder
 */
export const isRootFolder = (folder: Folder): boolean =>
  folder.parentId === null

/**
 * Check if a folder is a system folder
 */
export const isSystemFolder = (folder: Folder): boolean =>
  folder.isSystem === true

/**
 * Check if a suggestion is high confidence
 */
export const isHighConfidenceSuggestion = (suggestion: FolderSuggestion): boolean =>
  suggestion.confidence >= AI_CONFIDENCE_THRESHOLDS.HIGH

/**
 * Check if a suggestion should be shown
 */
export const shouldShowSuggestion = (suggestion: FolderSuggestion): boolean =>
  suggestion.confidence >= AI_CONFIDENCE_THRESHOLDS.MEDIUM
