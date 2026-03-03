import type { Folder, LinkedNote } from '@/types'

// Sample folders for the filing panel
export const sampleFolders: Folder[] = [
  { id: '1', name: 'Design Systems', path: 'Design Systems' },
  { id: '2', name: 'Reading List', path: 'Reading List' },
  { id: '3', name: 'UX Research', path: 'UX Research' },
  { id: '4', name: 'Project Alpha', path: 'Work / Project Alpha', parent: 'Work' },
  { id: '5', name: 'Learning', path: 'Personal / Learning', parent: 'Personal' },
  { id: '6', name: 'Archive', path: 'Archive' },
  { id: '7', name: 'Ideas', path: 'Ideas' },
  { id: '8', name: 'Meeting Notes', path: 'Work / Meeting Notes', parent: 'Work' },
  { id: '9', name: 'Resources', path: 'Work / Resources', parent: 'Work' },
  { id: '10', name: 'Bookmarks', path: 'Personal / Bookmarks', parent: 'Personal' },
  { id: 'unsorted', name: 'Unsorted', path: 'Unsorted' } // For stale items escape hatch
]

// Unsorted folder ID constant for stale items
export const UNSORTED_FOLDER_ID = 'unsorted'

// AI-suggested folders (would be dynamic based on item content in production)
export const suggestedFolderIds = ['1', '2', '3']

// Recently used folders
export const recentFolderIds = ['4', '5']

// Suggested tags based on content analysis
export const suggestedTags = ['design', 'ux', 'books', 'reading', 'don-norman']

// Recent tags from user history
export const recentTags = ['work', 'research', 'reference', 'todo']

// Existing notes for linking
export const existingNotes: LinkedNote[] = [
  { id: 'n1', title: 'Design System Architecture', type: 'note' },
  { id: 'n2', title: 'UX Principles Overview', type: 'note' },
  { id: 'n3', title: 'Component Library Docs', type: 'folder' },
  { id: 'n4', title: 'Q1 Design Goals', type: 'note' },
  { id: 'n5', title: 'User Research Findings', type: 'note' },
  { id: 'n6', title: 'Accessibility Guidelines', type: 'note' },
  { id: 'n7', title: 'Brand Style Guide', type: 'note' },
  { id: 'n8', title: 'Design Tokens Reference', type: 'note' }
]

// Helper to get folders by IDs
export const getFoldersByIds = (ids: string[]): Folder[] => {
  return sampleFolders.filter((folder) => ids.includes(folder.id))
}

// Helper to get suggested folders
export const getSuggestedFolders = (): Folder[] => {
  return getFoldersByIds(suggestedFolderIds)
}

// Helper to get recent folders
export const getRecentFolders = (): Folder[] => {
  return getFoldersByIds(recentFolderIds)
}
