// ============================================================================
// SAMPLE FILING DATA
// ============================================================================
// Realistic folder structure and tags for development and testing.
// Represents a PKM (Personal Knowledge Management) oriented setup.

import type { Folder, Tag, RecentFolders, RecentTags } from './filing-types'

// ============================================================================
// SAMPLE FOLDERS
// ============================================================================

/**
 * Sample folder hierarchy for development.
 * Structure:
 *
 * Work
 *   └── Projects
 *       ├── Alpha
 *       └── Beta
 *   └── References
 *   └── Meeting Notes
 * Personal
 *   └── Health
 *   └── Finance
 *   └── Learning
 * Research
 *   └── PKM
 *   └── AI & ML
 *   └── Web Development
 * Archive (system)
 * Unsorted (system)
 */
export const sampleFolders: Folder[] = [
  // -------------------------------------------------------------------------
  // WORK
  // -------------------------------------------------------------------------
  {
    id: 'work',
    name: 'Work',
    parentId: null,
    path: 'Work',
    icon: 'Briefcase',
    color: 'sky',
    createdAt: new Date('2024-01-01'),
    itemCount: 12,
  },
  {
    id: 'work-projects',
    name: 'Projects',
    parentId: 'work',
    path: 'Work / Projects',
    icon: 'FolderKanban',
    createdAt: new Date('2024-01-05'),
    itemCount: 8,
  },
  {
    id: 'work-projects-alpha',
    name: 'Alpha',
    parentId: 'work-projects',
    path: 'Work / Projects / Alpha',
    color: 'emerald',
    createdAt: new Date('2024-02-01'),
    itemCount: 5,
  },
  {
    id: 'work-projects-beta',
    name: 'Beta',
    parentId: 'work-projects',
    path: 'Work / Projects / Beta',
    color: 'violet',
    createdAt: new Date('2024-03-15'),
    itemCount: 3,
  },
  {
    id: 'work-references',
    name: 'References',
    parentId: 'work',
    path: 'Work / References',
    icon: 'BookOpen',
    createdAt: new Date('2024-01-10'),
    itemCount: 15,
  },
  {
    id: 'work-meetings',
    name: 'Meeting Notes',
    parentId: 'work',
    path: 'Work / Meeting Notes',
    icon: 'Users',
    createdAt: new Date('2024-01-15'),
    itemCount: 24,
  },

  // -------------------------------------------------------------------------
  // PERSONAL
  // -------------------------------------------------------------------------
  {
    id: 'personal',
    name: 'Personal',
    parentId: null,
    path: 'Personal',
    icon: 'User',
    color: 'rose',
    createdAt: new Date('2024-01-01'),
    itemCount: 18,
  },
  {
    id: 'personal-health',
    name: 'Health',
    parentId: 'personal',
    path: 'Personal / Health',
    icon: 'Heart',
    color: 'rose',
    createdAt: new Date('2024-01-20'),
    itemCount: 7,
  },
  {
    id: 'personal-finance',
    name: 'Finance',
    parentId: 'personal',
    path: 'Personal / Finance',
    icon: 'Wallet',
    color: 'emerald',
    createdAt: new Date('2024-01-25'),
    itemCount: 11,
  },
  {
    id: 'personal-learning',
    name: 'Learning',
    parentId: 'personal',
    path: 'Personal / Learning',
    icon: 'GraduationCap',
    createdAt: new Date('2024-02-01'),
    itemCount: 9,
  },

  // -------------------------------------------------------------------------
  // RESEARCH
  // -------------------------------------------------------------------------
  {
    id: 'research',
    name: 'Research',
    parentId: null,
    path: 'Research',
    icon: 'Microscope',
    color: 'amber',
    createdAt: new Date('2024-01-01'),
    itemCount: 42,
  },
  {
    id: 'research-pkm',
    name: 'PKM',
    parentId: 'research',
    path: 'Research / PKM',
    icon: 'Brain',
    color: 'amber',
    createdAt: new Date('2024-02-10'),
    itemCount: 18,
  },
  {
    id: 'research-ai',
    name: 'AI & ML',
    parentId: 'research',
    path: 'Research / AI & ML',
    icon: 'Sparkles',
    color: 'violet',
    createdAt: new Date('2024-02-15'),
    itemCount: 15,
  },
  {
    id: 'research-webdev',
    name: 'Web Development',
    parentId: 'research',
    path: 'Research / Web Development',
    icon: 'Code2',
    color: 'sky',
    createdAt: new Date('2024-02-20'),
    itemCount: 9,
  },

  // -------------------------------------------------------------------------
  // SYSTEM FOLDERS
  // -------------------------------------------------------------------------
  {
    id: 'archive',
    name: 'Archive',
    parentId: null,
    path: 'Archive',
    icon: 'Archive',
    color: 'stone',
    createdAt: new Date('2024-01-01'),
    itemCount: 156,
    isSystem: true,
  },
  {
    id: 'unsorted',
    name: 'Unsorted',
    parentId: null,
    path: 'Unsorted',
    icon: 'Inbox',
    color: 'slate',
    createdAt: new Date('2024-01-01'),
    itemCount: 23,
    isSystem: true,
  },
]

// ============================================================================
// SAMPLE TAGS
// ============================================================================

/**
 * Sample tags for development.
 * Mix of actionable, topical, and status tags.
 */
export const sampleTags: Tag[] = [
  // Actionable tags
  {
    id: 'tag-urgent',
    name: 'urgent',
    color: 'red',
    usageCount: 8,
    createdAt: new Date('2024-01-01'),
  },
  {
    id: 'tag-follow-up',
    name: 'follow-up',
    color: 'orange',
    usageCount: 23,
    createdAt: new Date('2024-01-05'),
  },
  {
    id: 'tag-review',
    name: 'review',
    color: 'yellow',
    usageCount: 15,
    createdAt: new Date('2024-01-10'),
  },

  // Topical tags
  {
    id: 'tag-productivity',
    name: 'productivity',
    color: 'blue',
    usageCount: 34,
    createdAt: new Date('2024-01-15'),
  },
  {
    id: 'tag-reading',
    name: 'reading',
    color: 'green',
    usageCount: 45,
    createdAt: new Date('2024-01-20'),
  },
  {
    id: 'tag-idea',
    name: 'idea',
    color: 'yellow',
    usageCount: 28,
    createdAt: new Date('2024-02-01'),
  },
  {
    id: 'tag-meeting',
    name: 'meeting',
    color: 'purple',
    usageCount: 19,
    createdAt: new Date('2024-02-05'),
  },
  {
    id: 'tag-tutorial',
    name: 'tutorial',
    color: 'blue',
    usageCount: 22,
    createdAt: new Date('2024-02-10'),
  },
  {
    id: 'tag-inspiration',
    name: 'inspiration',
    color: 'purple',
    usageCount: 17,
    createdAt: new Date('2024-02-15'),
  },

  // Status/meta tags
  {
    id: 'tag-reference',
    name: 'reference',
    color: 'gray',
    usageCount: 56,
    createdAt: new Date('2024-01-01'),
  },
  {
    id: 'tag-archived',
    name: 'archived',
    color: 'gray',
    usageCount: 12,
    createdAt: new Date('2024-03-01'),
  },
]

// ============================================================================
// SAMPLE RECENT ITEMS
// ============================================================================

/**
 * Sample recently used folders
 */
export const sampleRecentFolders: RecentFolders = {
  folderIds: [
    'research-pkm',
    'work-projects-alpha',
    'personal-learning',
    'research-ai',
    'work-meetings',
  ],
  updatedAt: new Date(),
}

/**
 * Sample recently used tags
 */
export const sampleRecentTags: RecentTags = {
  tagIds: [
    'tag-reading',
    'tag-productivity',
    'tag-idea',
    'tag-follow-up',
    'tag-tutorial',
    'tag-reference',
    'tag-review',
    'tag-inspiration',
  ],
  updatedAt: new Date(),
}

// ============================================================================
// HELPER: GET FOLDER BY ID
// ============================================================================

/**
 * Quick lookup helper for development
 */
export function getSampleFolderById(id: string): Folder | undefined {
  return sampleFolders.find((f) => f.id === id)
}

/**
 * Quick lookup helper for development
 */
export function getSampleTagById(id: string): Tag | undefined {
  return sampleTags.find((t) => t.id === id)
}

// ============================================================================
// FOLDER TREE STRUCTURE
// ============================================================================

/**
 * Folder with children for tree rendering
 */
export interface FolderNode extends Folder {
  children: FolderNode[]
  depth: number
}

/**
 * Build folder tree from flat array
 */
export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const folderMap = new Map<string, FolderNode>()

  // Create nodes with empty children
  folders.forEach((folder) => {
    folderMap.set(folder.id, {
      ...folder,
      children: [],
      depth: 0,
    })
  })

  const roots: FolderNode[] = []

  // Build tree structure
  folders.forEach((folder) => {
    const node = folderMap.get(folder.id)!

    if (folder.parentId === null) {
      roots.push(node)
    } else {
      const parent = folderMap.get(folder.parentId)
      if (parent) {
        parent.children.push(node)
      }
    }
  })

  // Calculate depths
  function setDepths(nodes: FolderNode[], depth: number): void {
    nodes.forEach((node) => {
      node.depth = depth
      setDepths(node.children, depth + 1)
    })
  }

  setDepths(roots, 0)

  return roots
}

/**
 * Sample folder tree for rendering
 */
export const sampleFolderTree = buildFolderTree(sampleFolders)
