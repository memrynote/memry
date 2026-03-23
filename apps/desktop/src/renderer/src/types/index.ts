export interface TreeDataItem {
  id: string
  name: string
  type?: 'file' | 'folder'
  children?: TreeDataItem[]
  isOpen?: boolean
  iconName?: string
  iconColor?: string
  disabled?: boolean
  draggable?: boolean
  customIcon?: string // Kullanıcının seçtiği ikon adı (icon name)
  inheritedIcon?: string // Parent'tan gelen ikon adı
}

// Re-export inbox types from preload (backend types)
export type {
  InboxItemType,
  InboxItem,
  InboxItemListItem,
  InboxListResponse,
  InboxCaptureResponse,
  InboxFileResponse,
  InboxBulkResponse,
  InboxStats,
  InboxProcessingStatus,
  InboxFilingAction
} from '../../../preload/index.d'

// Metadata types for type-specific content
export interface LinkMetadata {
  url: string
  siteName?: string
  description?: string
  excerpt?: string
  heroImage?: string | null
  favicon?: string | null
  author?: string
  publishedDate?: string
  fetchedAt?: string
  fetchStatus?: 'success' | 'partial' | 'failed' | 'pending'
}

export interface ImageMetadata {
  originalFilename: string
  format: string
  width: number
  height: number
  fileSize: number
  hasExif: boolean
  caption?: string
}

export interface VoiceMetadata {
  duration: number
  format: string
  fileSize: number
  sampleRate?: number
}

export interface ClipMetadata {
  sourceUrl: string
  sourceTitle: string
  quotedText: string
  selectionContext?: string
  capturedImages: string[]
  hasFormatting: boolean
}

export interface PdfMetadata {
  originalFilename: string
  pageCount: number
  fileSize: number
  extractedTitle?: string
  author?: string
  creationDate?: string
  textExcerpt?: string
  hasText: boolean
}

export interface SocialMetadata {
  platform: 'twitter' | 'other'
  tweetId?: string
  postUrl: string
  authorName: string
  authorHandle: string
  authorAvatar?: string
  postContent: string
  timestamp?: string
  mediaUrls: string[]
  metrics?: {
    likes?: number
    reposts?: number
    replies?: number
  }
  isThread?: boolean
  threadId?: string
  extractionStatus?: 'pending' | 'full' | 'partial' | 'failed'
}

export type InboxMetadata =
  | LinkMetadata
  | ImageMetadata
  | VoiceMetadata
  | ClipMetadata
  | PdfMetadata
  | SocialMetadata

// Filing system types
export interface Folder {
  id: string
  name: string
  path: string // Full path like "Work / Project Alpha"
  parent?: string // Parent folder name for hierarchy
}

export interface LinkedNote {
  id: string
  title: string
  type: 'note' | 'folder'
  emoji?: string | null
}
