import {
  ArrowDownWideNarrow,
  ArrowLeft,
  Bell,
  Bookmark,
  BookmarkX,
  BookOpen,
  Calendar,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudOff,
  Copy,
  CreditCard,
  Ellipsis,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  Frame,
  House,
  Image,
  Inbox,
  Key,
  Link,
  Lock,
  Mail,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  ScanFace,
  Search,
  Shield,
  Share2,
  SlidersHorizontal,
  SquareCheck,
  Tag,
  Trash2,
  TriangleAlert,
  User,
  X
} from 'lucide-react-native'

import type { Color } from '@/theme/colors'
import { useColors } from '@/theme/use-colors'

const glyphs = {
  home: House,
  note: FileText,
  // The tree draws a plain page with a corner fold and no text lines; `note`
  // keeps its lines for the tab bar.
  file: File,
  image: Image,
  task: SquareCheck,
  journal: BookOpen,
  inbox: Inbox,
  search: Search,
  // Mirrored: the board draws lines-left with the arrow on the right, lucide
  // draws arrow-left with the lines on the right, and ships no flipped variant.
  sort: ArrowDownWideNarrow,
  plus: Plus,
  // The Figma glyph is two horizontal sliders with knobs, not a gear.
  settings: SlidersHorizontal,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  more: Ellipsis,
  calendar: Calendar,
  folder: Folder,
  'folder-open': FolderOpen,
  'file-plus': FilePlus,
  'folder-plus': FolderPlus,
  'folder-input': FolderInput,
  copy: Copy,
  pencil: Pencil,
  bookmark: Bookmark,
  'bookmark-off': BookmarkX,
  tag: Tag,
  close: X,
  'arrow-left': ArrowLeft,
  lock: Lock,
  key: Key,
  'face-id': ScanFace,
  shield: Shield,
  mail: Mail,
  cloud: Cloud,
  offline: CloudOff,
  warning: TriangleAlert,
  check: Check,
  trash: Trash2,
  bell: Bell,
  share: Share2,
  sync: RefreshCw,
  mic: Mic,
  camera: Camera,
  link: Link,
  canvas: Frame,
  user: User,
  billing: CreditCard,
  project: FolderKanban
} as const

export type IconName = keyof typeof glyphs

export const iconNames = Object.keys(glyphs) as IconName[]

export interface IconProps {
  name: IconName
  size?: number
  color?: Color
  strokeWidth?: number
}

export function Icon({ name, size = 24, color, strokeWidth = 1.75 }: IconProps) {
  const c = useColors()
  const Glyph = glyphs[name]
  // Figma reports a thinner stroke on smaller instances because it scales the
  // authored 1.75 when an instance is resized. That is resize behaviour, not
  // authored intent, so the stroke holds at 1.75 across sizes here.
  return <Glyph size={size} color={color ?? c.text.primary} strokeWidth={strokeWidth} />
}
