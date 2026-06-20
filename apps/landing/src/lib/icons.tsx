import { HugeiconsIcon } from '@hugeicons/react'
import type { IconSvgElement } from '@hugeicons/react'
import { forwardRef } from 'react'
import type { ComponentPropsWithRef, ForwardRefExoticComponent } from 'react'
import {
  AppleIcon,
  ArchiveIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpDownIcon,
  ArrowUpRight01Icon,
  BarChartIcon,
  BookOpen01Icon,
  Bookmark01Icon,
  BrainIcon,
  Briefcase01Icon,
  Calendar01Icon,
  Calendar03Icon,
  Calendar04Icon,
  Cancel01Icon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CheckmarkSquare01Icon,
  Clock01Icon,
  CodeIcon,
  ColorsIcon,
  ComputerIcon,
  ComputerPhoneSyncIcon,
  ComputerTerminal01Icon,
  CpuIcon,
  Cursor01Icon,
  Download01Icon,
  EyeIcon,
  FavouriteIcon,
  File02Icon,
  FileCodeIcon,
  FileVideoIcon,
  FilterIcon,
  FireIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GithubIcon,
  GlobeIcon,
  HardDriveIcon,
  HashtagIcon,
  Home01Icon,
  Image01Icon,
  InboxIcon,
  Key02Icon,
  KeyboardIcon,
  LaptopIcon,
  Layers01Icon,
  Layout01Icon,
  LayoutThreeColumnIcon,
  LeftToRightBlockQuoteIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link02Icon,
  LinkForwardIcon,
  Loading03Icon,
  LockIcon,
  MagicWand01Icon,
  Mail01Icon,
  Maximize02Icon,
  Menu01Icon,
  Message01Icon,
  Mic01Icon,
  Minimize02Icon,
  MinusSignIcon,
  Moon02Icon,
  MoonIcon,
  Mortarboard01Icon,
  Notification01Icon,
  PackageIcon,
  PanelLeftIcon,
  PenTool01Icon,
  PencilEdit01Icon,
  PlayIcon,
  QrCodeIcon,
  RecordIcon,
  Refresh01Icon,
  RepeatIcon,
  RocketIcon,
  RotateLeft01Icon,
  ScissorIcon,
  Scroll01Icon,
  Search01Icon,
  ServerStack01Icon,
  Shield01Icon,
  Shield02Icon,
  SlidersHorizontalIcon,
  SmartPhone01Icon,
  SparklesIcon,
  StarIcon,
  StickyNote01Icon,
  Sun01Icon,
  SunriseIcon,
  SunsetIcon,
  Table01Icon,
  TagsIcon,
  Target01Icon,
  TextIcon,
  Tick01Icon,
  Timer01Icon,
  ToggleOffIcon,
  UserMultipleIcon,
  ViewOffIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
  WifiOff01Icon,
  WorkHistoryIcon,
  ZapIcon
} from '@hugeicons/core-free-icons'

export type LucideIcon = ForwardRefExoticComponent<
  ComponentPropsWithRef<'svg'> & {
    size?: string | number
    strokeWidth?: number
    absoluteStrokeWidth?: boolean
  }
>

function createIcon(icon: IconSvgElement): LucideIcon {
  const Wrapped = forwardRef<
    SVGSVGElement,
    ComponentPropsWithRef<'svg'> & {
      size?: string | number
      strokeWidth?: number
      absoluteStrokeWidth?: boolean
    }
  >(({ className, strokeWidth, size, ...rest }, ref) => (
    <HugeiconsIcon
      ref={ref}
      icon={icon}
      className={className}
      strokeWidth={strokeWidth}
      size={size}
      {...rest}
    />
  ))
  Wrapped.displayName = 'AppIcon'
  return Wrapped as LucideIcon
}

export const Apple = createIcon(AppleIcon)
export const Archive = createIcon(ArchiveIcon)
export const ArrowRight = createIcon(ArrowRight01Icon)
export const ArrowUpDown = createIcon(ArrowUpDownIcon)
export const ArrowUpRight = createIcon(ArrowUpRight01Icon)
export const BarChart3 = createIcon(BarChartIcon)
export const Bell = createIcon(Notification01Icon)
export const Bookmark = createIcon(Bookmark01Icon)
export const BookOpen = createIcon(BookOpen01Icon)
export const Brain = createIcon(BrainIcon)
export const Briefcase = createIcon(Briefcase01Icon)
export const Calendar = createIcon(Calendar01Icon)
export const CalendarDays = createIcon(Calendar03Icon)
export const CalendarRange = createIcon(Calendar04Icon)
export const Check = createIcon(Tick01Icon)
export const CheckCircle2 = createIcon(CheckmarkCircle02Icon)
export const CheckSquare = createIcon(CheckmarkSquare01Icon)
export const ChevronDown = createIcon(ArrowDown01Icon)
export const ChevronRight = createIcon(ArrowRight01Icon)
export const CircleDot = createIcon(RecordIcon)
export const Clock = createIcon(Clock01Icon)
export const Code = createIcon(CodeIcon)
export const Columns3 = createIcon(LayoutThreeColumnIcon)
export const Cpu = createIcon(CpuIcon)
export const Download = createIcon(Download01Icon)
export const ExternalLink = createIcon(LinkForwardIcon)
export const Eye = createIcon(EyeIcon)
export const EyeOff = createIcon(ViewOffIcon)
export const FileCode = createIcon(FileCodeIcon)
export const FileText = createIcon(File02Icon)
export const FileVideo = createIcon(FileVideoIcon)
export const Filter = createIcon(FilterIcon)
export const Flame = createIcon(FireIcon)
export const FolderOpen = createIcon(FolderOpenIcon)
export const GitBranch = createIcon(GitBranchIcon)
export const Github = createIcon(GithubIcon)
export const Globe = createIcon(GlobeIcon)
export const GraduationCap = createIcon(Mortarboard01Icon)
export const HardDrive = createIcon(HardDriveIcon)
export const Hash = createIcon(HashtagIcon)
export const Heart = createIcon(FavouriteIcon)
export const History = createIcon(WorkHistoryIcon)
export const Home = createIcon(Home01Icon)
export const Image = createIcon(Image01Icon)
export const Inbox = createIcon(InboxIcon)
export const Keyboard = createIcon(KeyboardIcon)
export const KeyRound = createIcon(Key02Icon)
export const Laptop = createIcon(LaptopIcon)
export const Layers = createIcon(Layers01Icon)
export const Layout = createIcon(Layout01Icon)
export const Link2 = createIcon(Link02Icon)
export const List = createIcon(LeftToRightListBulletIcon)
export const ListChecks = createIcon(CheckListIcon)
export const ListOrdered = createIcon(LeftToRightListNumberIcon)
export const Loader2 = createIcon(Loading03Icon)
export const Lock = createIcon(LockIcon)
export const Mail = createIcon(Mail01Icon)
export const Maximize2 = createIcon(Maximize02Icon)
export const Menu = createIcon(Menu01Icon)
export const MessageSquare = createIcon(Message01Icon)
export const Mic = createIcon(Mic01Icon)
export const Minimize2 = createIcon(Minimize02Icon)
export const Minus = createIcon(MinusSignIcon)
export const Monitor = createIcon(ComputerIcon)
export const MonitorSmartphone = createIcon(ComputerPhoneSyncIcon)
export const Moon = createIcon(MoonIcon)
export const MoonStar = createIcon(Moon02Icon)
export const MousePointer2 = createIcon(Cursor01Icon)
export const Package = createIcon(PackageIcon)
export const Palette = createIcon(ColorsIcon)
export const PanelLeft = createIcon(PanelLeftIcon)
export const PenLine = createIcon(PencilEdit01Icon)
export const PenTool = createIcon(PenTool01Icon)
export const Play = createIcon(PlayIcon)
export const QrCode = createIcon(QrCodeIcon)
export const Quote = createIcon(LeftToRightBlockQuoteIcon)
export const RefreshCw = createIcon(Refresh01Icon)
export const Repeat = createIcon(RepeatIcon)
export const Rocket = createIcon(RocketIcon)
export const RotateCcw = createIcon(RotateLeft01Icon)
export const Scissors = createIcon(ScissorIcon)
export const ScrollText = createIcon(Scroll01Icon)
export const Search = createIcon(Search01Icon)
export const Server = createIcon(ServerStack01Icon)
export const Shield = createIcon(Shield02Icon)
export const ShieldCheck = createIcon(Shield01Icon)
export const Sliders = createIcon(SlidersHorizontalIcon)
export const Smartphone = createIcon(SmartPhone01Icon)
export const Sparkles = createIcon(SparklesIcon)
export const Star = createIcon(StarIcon)
export const StickyNote = createIcon(StickyNote01Icon)
export const Sun = createIcon(Sun01Icon)
export const Sunrise = createIcon(SunriseIcon)
export const Sunset = createIcon(SunsetIcon)
export const Table = createIcon(Table01Icon)
export const Tags = createIcon(TagsIcon)
export const Target = createIcon(Target01Icon)
export const Terminal = createIcon(ComputerTerminal01Icon)
export const Timer = createIcon(Timer01Icon)
export const ToggleLeft = createIcon(ToggleOffIcon)
export const Type = createIcon(TextIcon)
export const Users = createIcon(UserMultipleIcon)
export const Volume2 = createIcon(VolumeHighIcon)
export const VolumeX = createIcon(VolumeMute01Icon)
export const Wand2 = createIcon(MagicWand01Icon)
export const WifiOff = createIcon(WifiOff01Icon)
export const X = createIcon(Cancel01Icon)
export const Zap = createIcon(ZapIcon)
