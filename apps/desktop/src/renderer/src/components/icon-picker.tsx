'use client'

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  // Files & Documents
  File,
  FileText,
  FileCode,
  FileJson,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileSpreadsheet,
  FilePen,
  FileCheck,
  FileX,
  FilePlus,
  FileMinus,
  FileSearch,
  Files,
  // Folders
  Folder,
  FolderOpen,
  FolderPlus,
  FolderMinus,
  FolderCheck,
  FolderX,
  FolderSearch,
  FolderArchive,
  FolderCog,
  FolderHeart,
  FolderKey,
  FolderLock,
  FolderInput,
  FolderOutput,
  FolderGit,
  // Objects & Items
  Book,
  BookOpen,
  Bookmark,
  Box,
  Package,
  Archive,
  Inbox,
  Mail,
  MailOpen,
  Calendar,
  Clock,
  Timer,
  AlarmClock,
  Bell,
  BellRing,
  Tag,
  Tags,
  Flag,
  Star,
  Heart,
  // Actions & Tools
  Pencil,
  PenTool,
  Eraser,
  Scissors,
  Clipboard,
  ClipboardList,
  ClipboardCheck,
  Copy,
  Trash,
  Trash2,
  Download,
  Upload,
  Share,
  Share2,
  Link,
  Link2,
  Unlink,
  Lock,
  Unlock,
  Key,
  // Arrows & Navigation
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUp,
  ChevronsDown,
  CornerDownLeft,
  CornerDownRight,
  MoveUp,
  MoveDown,
  // Social & Communication
  User,
  Users,
  UserPlus,
  UserMinus,
  UserCheck,
  UserX,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Send,
  AtSign,
  Hash,
  // UI & Interface
  Home,
  Settings,
  Cog,
  Menu,
  MoreHorizontal,
  MoreVertical,
  Grid,
  List,
  Layers,
  Layout,
  Maximize,
  Minimize,
  Eye,
  EyeOff,
  Search,
  Filter,
  // Status & Indicators
  Check,
  CheckCircle,
  X,
  XCircle,
  AlertCircle,
  AlertTriangle,
  Info,
  HelpCircle,
  Loader,
  RefreshCw,
  // Media & Creative
  Image,
  Camera,
  Video,
  Music,
  Mic,
  Play,
  Pause,
  Square,
  Circle,
  Triangle,
  Hexagon,
  Palette,
  Brush,
  // Tech & Development
  Code,
  Terminal,
  Database,
  Server,
  Cloud,
  Wifi,
  Globe,
  Smartphone,
  Monitor,
  Cpu,
  HardDrive,
  Usb,
  // Nature & Weather
  Sun,
  Moon,
  CloudRain,
  Snowflake,
  Wind,
  Zap,
  Flame,
  Droplet,
  Leaf,
  TreeDeciduous,
  type AppIcon
} from '@/lib/icons'

// Icon kategorileri ve ikonları
const ICON_CATEGORIES = {
  'Files & Documents': {
    File,
    FileText,
    FileCode,
    FileJson,
    FileImage,
    FileVideo,
    FileAudio,
    FileArchive,
    FileSpreadsheet,
    FilePen,
    FileCheck,
    FileX,
    FilePlus,
    FileMinus,
    FileSearch,
    Files
  },
  Folders: {
    Folder,
    FolderOpen,
    FolderPlus,
    FolderMinus,
    FolderCheck,
    FolderX,
    FolderSearch,
    FolderArchive,
    FolderCog,
    FolderHeart,
    FolderKey,
    FolderLock,
    FolderInput,
    FolderOutput,
    FolderGit
  },
  'Objects & Items': {
    Book,
    BookOpen,
    Bookmark,
    Box,
    Package,
    Archive,
    Inbox,
    Mail,
    MailOpen,
    Calendar,
    Clock,
    Timer,
    AlarmClock,
    Bell,
    BellRing,
    Tag,
    Tags,
    Flag,
    Star,
    Heart
  },
  'Actions & Tools': {
    Pencil,
    PenTool,
    Eraser,
    Scissors,
    Clipboard,
    ClipboardList,
    ClipboardCheck,
    Copy,
    Trash,
    Trash2,
    Download,
    Upload,
    Share,
    Share2,
    Link,
    Link2,
    Unlink,
    Lock,
    Unlock,
    Key
  },
  'Arrows & Navigation': {
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ChevronUp,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronsUp,
    ChevronsDown,
    CornerDownLeft,
    CornerDownRight,
    MoveUp,
    MoveDown
  },
  'Social & Communication': {
    User,
    Users,
    UserPlus,
    UserMinus,
    UserCheck,
    UserX,
    MessageCircle,
    MessageSquare,
    MessagesSquare,
    Send,
    AtSign,
    Hash
  },
  'UI & Interface': {
    Home,
    Settings,
    Cog,
    Menu,
    MoreHorizontal,
    MoreVertical,
    Grid,
    List,
    Layers,
    Layout,
    Maximize,
    Minimize,
    Eye,
    EyeOff,
    Search,
    Filter
  },
  'Status & Indicators': {
    Check,
    CheckCircle,
    X,
    XCircle,
    AlertCircle,
    AlertTriangle,
    Info,
    HelpCircle,
    Loader,
    RefreshCw
  },
  'Media & Creative': {
    Image,
    Camera,
    Video,
    Music,
    Mic,
    Play,
    Pause,
    Square,
    Circle,
    Triangle,
    Hexagon,
    Palette,
    Brush
  },
  'Tech & Development': {
    Code,
    Terminal,
    Database,
    Server,
    Cloud,
    Wifi,
    Globe,
    Smartphone,
    Monitor,
    Cpu,
    HardDrive,
    Usb
  },
  'Nature & Weather': {
    Sun,
    Moon,
    CloudRain,
    Snowflake,
    Wind,
    Zap,
    Flame,
    Droplet,
    Leaf,
    TreeDeciduous
  }
} as const

// Tüm ikonları düz bir map olarak export et
export const ALL_ICONS: Record<string, AppIcon> = Object.values(ICON_CATEGORIES).reduce(
  (acc, category) => ({ ...acc, ...category }),
  {}
)

// İkon adından bileşeni al
export const getIconByName = (name: string): AppIcon | undefined => {
  return ALL_ICONS[name]
}

export type IconPickerProps = {
  isOpen: boolean
  onClose: () => void
  onSelect: (iconName: string) => void
  position?: { x: number; y: number }
  currentIcon?: string
}

export const IconPicker = ({
  isOpen,
  onClose,
  onSelect,
  position,
  currentIcon
}: IconPickerProps) => {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Dışarı tıklandığında kapat
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
      // Focus input when opened
      setTimeout(() => inputRef.current?.focus(), 100)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, onClose])

  // Filtrelenmiş ikonlar
  const filteredIcons = useMemo(() => {
    const query = searchQuery.toLowerCase().trim()

    if (!query && !selectedCategory) {
      return ICON_CATEGORIES
    }

    const result: Record<string, Record<string, AppIcon>> = {}

    for (const [categoryName, icons] of Object.entries(ICON_CATEGORIES)) {
      if (selectedCategory && categoryName !== selectedCategory) {
        continue
      }

      const filteredCategoryIcons: Record<string, AppIcon> = {}

      for (const [iconName, IconComponent] of Object.entries(icons)) {
        if (!query || iconName.toLowerCase().includes(query)) {
          filteredCategoryIcons[iconName] = IconComponent
        }
      }

      if (Object.keys(filteredCategoryIcons).length > 0) {
        result[categoryName] = filteredCategoryIcons
      }
    }

    return result
  }, [searchQuery, selectedCategory])

  const handleIconSelect = useCallback(
    (iconName: string) => {
      onSelect(iconName)
      onClose()
      setSearchQuery('')
      setSelectedCategory(null)
    },
    [onSelect, onClose]
  )

  const handleClearIcon = useCallback(() => {
    onSelect('')
    onClose()
    setSearchQuery('')
    setSelectedCategory(null)
  }, [onSelect, onClose])

  if (!isOpen) {
    return null
  }

  // Pozisyon hesaplama - ekran sınırlarını kontrol et
  const calculatePosition = () => {
    if (!position) {
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
    }

    const popoverWidth = 320
    const popoverHeight = 400
    const padding = 16

    let x = position.x
    let y = position.y

    // Sağ kenar kontrolü
    if (x + popoverWidth > window.innerWidth - padding) {
      x = window.innerWidth - popoverWidth - padding
    }

    // Alt kenar kontrolü
    if (y + popoverHeight > window.innerHeight - padding) {
      y = window.innerHeight - popoverHeight - padding
    }

    // Sol kenar kontrolü
    if (x < padding) {
      x = padding
    }

    // Üst kenar kontrolü
    if (y < padding) {
      y = padding
    }

    return { top: y, left: x }
  }

  const positionStyle = calculatePosition()

  return (
    <div
      ref={popoverRef}
      className={cn(
        'fixed z-[100] w-80 rounded-lg border bg-popover text-popover-foreground shadow-xl',
        'animate-in fade-in-0 zoom-in-95 duration-200'
      )}
      style={positionStyle}
      role="dialog"
      aria-label="Icon picker"
    >
      {/* Header */}
      <div className="border-b p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Select Icon</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 hover:bg-accent"
            aria-label="Close icon picker"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <Input
          ref={inputRef}
          type="text"
          placeholder="Search icons..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 text-sm"
        />
      </div>

      {/* Category Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b p-2">
        <button
          type="button"
          onClick={() => setSelectedCategory(null)}
          className={cn(
            'shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors',
            !selectedCategory ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
          )}
        >
          All
        </button>
        {Object.keys(ICON_CATEGORIES).map((category) => (
          <button
            key={category}
            type="button"
            onClick={() => setSelectedCategory(category)}
            className={cn(
              'shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors',
              selectedCategory === category
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-accent'
            )}
          >
            {category.split(' ')[0]}
          </button>
        ))}
      </div>

      {/* Icons Grid */}
      <div className="max-h-64 overflow-y-auto p-2">
        {/* Clear Icon Button */}
        {currentIcon && (
          <button
            type="button"
            onClick={handleClearIcon}
            className="mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
          >
            <X className="h-4 w-4" />
            Clear Icon
          </button>
        )}

        {Object.entries(filteredIcons).map(([categoryName, icons]) => (
          <div key={categoryName} className="mb-3">
            <h4 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">
              {categoryName}
            </h4>
            <div className="grid grid-cols-8 gap-1">
              {Object.entries(icons).map(([iconName, IconComponent]) => (
                <button
                  key={iconName}
                  type="button"
                  onClick={() => handleIconSelect(iconName)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                    'hover:bg-accent focus:bg-accent focus:outline-none',
                    currentIcon === iconName &&
                      'bg-primary text-primary-foreground hover:bg-primary/90'
                  )}
                  title={iconName}
                  aria-label={`Select ${iconName} icon`}
                >
                  <IconComponent className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
        ))}

        {Object.keys(filteredIcons).length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No icons found for "{searchQuery}"
          </div>
        )}
      </div>
    </div>
  )
}

export default IconPicker
