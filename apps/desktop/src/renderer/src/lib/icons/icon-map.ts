import {
  // Direct matches
  AlertCircleIcon,
  AlignLeftIcon,
  ArchiveIcon,
  ArrowDown01Icon,
  ArrowDownAZIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUpDownIcon,
  Book01Icon,
  BookOpen01Icon,
  Bookmark01Icon,
  BotIcon,
  BrainIcon,
  BrushIcon,
  Calendar01Icon,
  Camera01Icon,
  CircleIcon,
  ClipboardIcon,
  Clock01Icon,
  CloudIcon,
  CloudOffIcon,
  CodeIcon,
  CogIcon,
  CopyIcon,
  CpuIcon,
  CreditCardIcon,
  DatabaseIcon,
  Download01Icon,
  DropletIcon,
  EraserIcon,
  EyeIcon,
  File01Icon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileImageIcon,
  FileInputIcon,
  FileMinusIcon,
  FilePenIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileSpreadsheetIcon,
  FileVideoIcon,
  FileXIcon,
  Files01Icon,
  FilterIcon,
  Flag01Icon,
  Folder01Icon,
  FolderArchiveIcon,
  FolderCheckIcon,
  FolderCogIcon,
  FolderGitIcon,
  FolderHeartIcon,
  FolderInputIcon,
  FolderKanbanIcon,
  FolderKeyIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  FolderOutputIcon,
  FolderSearchIcon,
  Forward01Icon,
  GlobeIcon,
  GridIcon,
  HardDriveIcon,
  HelpCircleIcon,
  HexagonIcon,
  Home01Icon,
  Image01Icon,
  InboxIcon,
  Key01Icon,
  Layers01Icon,
  Layout01Icon,
  LayoutGridIcon,
  Leaf01Icon,
  Link01Icon,
  LockIcon,
  Logout01Icon,
  Mail01Icon,
  MailOpenIcon,
  Maximize01Icon,
  Menu01Icon,
  Mic01Icon,
  Minimize01Icon,
  MoonIcon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  MoveIcon,
  PackageIcon,
  PanelRightIcon,
  PauseIcon,
  PenTool01Icon,
  PencilIcon,
  PlayIcon,
  QrCodeIcon,
  RepeatIcon,
  SaveIcon,
  Search01Icon,
  Settings01Icon,
  SlidersHorizontalIcon,
  SmartPhone01Icon,
  SmileIcon,
  SparklesIcon,
  SquareIcon,
  StarIcon,
  StickyNote01Icon,
  Sun01Icon,
  SunriseIcon,
  SunsetIcon,
  Tag01Icon,
  TagsIcon,
  Timer01Icon,
  TriangleIcon,
  Unlink01Icon,
  Upload01Icon,
  UsbIcon,
  UserCheck01Icon,
  UserIcon,
  UserMinus01Icon,
  Video01Icon,
  Wifi01Icon,
  ZapIcon,
  AlarmClockIcon,
  Share01Icon,

  // Manual matches
  Alert02Icon,
  ArrowDown05Icon,
  ArrowDownDoubleIcon,
  ArrowDownLeft01Icon,
  ArrowDownRight01Icon,
  ArrowUp05Icon,
  ArrowUpDoubleIcon,
  ArrowUpZAIcon,
  Attachment01Icon,
  BellDotIcon,
  BookBookmark01Icon,
  BulbIcon,
  Calendar03Icon,
  CancelCircleIcon,
  Cancel01Icon,
  ChartIncreaseIcon,
  CheckListIcon,
  CheckmarkBadge01Icon,
  CheckmarkCircle01Icon,
  CheckmarkCircle02Icon,
  CheckmarkSquare01Icon,
  ClipboardPasteIcon,
  CloudAngledRainIcon,
  ColorsIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  CubeIcon,
  Delete01Icon,
  DragDropHorizontalIcon,
  DragDropVerticalIcon,
  FastWindIcon,
  FavouriteIcon,
  File02Icon,
  FileExclamationPointIcon,
  FileTypeIcon,
  FileVerifiedIcon,
  FireIcon,
  FocusPointIcon,
  FolderAddIcon,
  FolderLockedIcon,
  FolderRemoveIcon,
  GitBranchIcon,
  GitMergeIcon,
  HashtagIcon,
  InformationCircleIcon,
  Key02Icon,
  LayoutThreeColumnIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  Layout03Icon,
  LeftToRightListBulletIcon,
  LeftToRightListDashIcon,
  Link02Icon,
  LinkForwardIcon,
  Loading03Icon,
  LoaderPinwheelIcon,
  Maximize02Icon,
  Message01Icon,
  MessageMultiple01Icon,
  MessageSquareCodeIcon,
  Minimize02Icon,
  MinusSignIcon,
  MusicNote01Icon,
  NeuralNetworkIcon,
  NextIcon,
  Notification01Icon,
  NodeMoveDownIcon,
  NodeMoveUpIcon,
  PanelLeftIcon,
  PencilEdit01Icon,
  PlusSignIcon,
  PreviousIcon,
  Refresh01Icon,
  RotateLeft01Icon,
  RotateRight01Icon,
  ScissorIcon,
  SentIcon,
  ServerStack01Icon,
  Settings02Icon,
  Share02Icon,
  Shield01Icon,
  SnowIcon,
  SquareUnlock01Icon,
  TextFontIcon,
  TextIcon,
  Tick01Icon,
  Tree01Icon,
  AtIcon,
  UserAdd01Icon,
  UserMultipleIcon,
  UserRemove01Icon,
  ViewOffIcon,
  VolumeHighIcon,
  VolumeLowIcon,
  VolumeMute01Icon,
  WorkHistoryIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,

  // Round 2: missing from typecheck
  ArrowShrinkIcon,
  CollapseIcon,
  ExpandIcon,
  FileImportIcon,
  FileQuestionMarkIcon,
  LaptopIcon,
  LanguageCircleIcon,
  PanelLeftCloseIcon,
  PinIcon,
  Plug01Icon,
  Shield02Icon,
  SortByUp01Icon,
  TextBoldIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
  TypeCursorIcon,

  // Round 3: editor toolbar + remaining
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  LeftToRightListNumberIcon,
  LeftToRightBlockQuoteIcon,
  SummationCircleIcon,
  ChartDecreaseIcon,
  NotificationOff01Icon,
  DashedLineCircleIcon,
  Progress03Icon
} from '@hugeicons/core-free-icons'
import { createIcon } from './create-icon'

// ── Files & Documents ───────────────────────────────
export const File = createIcon(File01Icon)
export const FileText = createIcon(File02Icon)
export const FileCode = createIcon(FileCodeIcon)
export const FileJson = createIcon(FileCodeIcon)
export const FileImage = createIcon(FileImageIcon)
export const FileVideo = createIcon(FileVideoIcon)
export const FileAudio = createIcon(FileAudioIcon)
export const FileArchive = createIcon(FileArchiveIcon)
export const FileSpreadsheet = createIcon(FileSpreadsheetIcon)
export const FilePen = createIcon(FilePenIcon)
export const FileCheck = createIcon(FileVerifiedIcon)
export const FileX = createIcon(FileXIcon)
export const FilePlus = createIcon(FilePlusIcon)
export const FileMinus = createIcon(FileMinusIcon)
export const FileSearch = createIcon(FileSearchIcon)
export const Files = createIcon(Files01Icon)
export const FileInput = createIcon(FileInputIcon)
export const FileWarning = createIcon(FileExclamationPointIcon)
export const FileType2 = createIcon(FileTypeIcon)
export const FileIcon_ = File

// ── Folders ─────────────────────────────────────────
export const Folder = createIcon(Folder01Icon)
export const FolderOpen = createIcon(FolderOpenIcon)
export const FolderPlus = createIcon(FolderAddIcon)
export const FolderMinus = createIcon(FolderMinusIcon)
export const FolderCheck = createIcon(FolderCheckIcon)
export const FolderX = createIcon(FolderRemoveIcon)
export const FolderSearch = createIcon(FolderSearchIcon)
export const FolderArchive = createIcon(FolderArchiveIcon)
export const FolderCog = createIcon(FolderCogIcon)
export const FolderHeart = createIcon(FolderHeartIcon)
export const FolderKey = createIcon(FolderKeyIcon)
export const FolderLock = createIcon(FolderLockedIcon)
export const FolderInput = createIcon(FolderInputIcon)
export const FolderOutput = createIcon(FolderOutputIcon)
export const FolderGit = createIcon(FolderGitIcon)
export const FolderKanban = createIcon(FolderKanbanIcon)

// ── Objects & Items ─────────────────────────────────
export const Book = createIcon(Book01Icon)
export const BookOpen = createIcon(BookOpen01Icon)
export const Bookmark = createIcon(Bookmark01Icon)
export const BookMarked = createIcon(BookBookmark01Icon)
export const Box = createIcon(CubeIcon)
export const Package = createIcon(PackageIcon)
export const Archive = createIcon(ArchiveIcon)
export const Inbox = createIcon(InboxIcon)
export const Mail = createIcon(Mail01Icon)
export const MailOpen = createIcon(MailOpenIcon)
export const Calendar = createIcon(Calendar01Icon)
export const CalendarDays = createIcon(Calendar03Icon)
export const CalendarClock = createIcon(Calendar03Icon)
export const Clock = createIcon(Clock01Icon)
export const Timer = createIcon(Timer01Icon)
export const AlarmClock = createIcon(AlarmClockIcon)
export const Bell = createIcon(Notification01Icon)
export const BellRing = createIcon(BellDotIcon)
export const Tag = createIcon(Tag01Icon)
export const Tags = createIcon(TagsIcon)
export const Flag = createIcon(Flag01Icon)
export const Star = createIcon(StarIcon)
export const Heart = createIcon(FavouriteIcon)
export const StickyNote = createIcon(StickyNote01Icon)

// ── Actions & Tools ─────────────────────────────────
export const Pencil = createIcon(PencilIcon)
export const PenLine = createIcon(PencilEdit01Icon)
export const PenTool = createIcon(PenTool01Icon)
export const Eraser = createIcon(EraserIcon)
export const Scissors = createIcon(ScissorIcon)
export const Clipboard = createIcon(ClipboardIcon)
export const ClipboardList = createIcon(ClipboardPasteIcon)
export const ClipboardCheck = createIcon(ClipboardIcon)
export const Copy = createIcon(CopyIcon)
export const Trash = createIcon(Delete01Icon)
export const Trash2 = createIcon(Delete01Icon)
export const Download = createIcon(Download01Icon)
export const Upload = createIcon(Upload01Icon)
export const Share = createIcon(Share01Icon)
export const Share2 = createIcon(Share02Icon)
export const Link = createIcon(Link01Icon)
export const Link2 = createIcon(Link02Icon)
export const Unlink = createIcon(Unlink01Icon)
export const Lock = createIcon(LockIcon)
export const Unlock = createIcon(SquareUnlock01Icon)
export const Key = createIcon(Key01Icon)
export const KeyRound = createIcon(Key02Icon)
export const Save = createIcon(SaveIcon)
export const Send = createIcon(SentIcon)
export const Merge = createIcon(GitMergeIcon)

// ── Arrows & Navigation ────────────────────────────
export const ArrowUp = createIcon(ArrowUp01Icon)
export const ArrowDown = createIcon(ArrowDown01Icon)
export const ArrowLeft = createIcon(ArrowLeft01Icon)
export const ArrowRight = createIcon(ArrowRight01Icon)
export const ArrowUpAZ = createIcon(ArrowUpDownIcon)
export const ArrowDownAZ = createIcon(ArrowDownAZIcon)
export const ArrowDownZA = createIcon(ArrowUpZAIcon)
export const ArrowUpDown = createIcon(ArrowUpDownIcon)
export const ArrowDownToLine = createIcon(ArrowDown05Icon)
export const ArrowUpFromLine = createIcon(ArrowUp05Icon)
export const ChevronUp = createIcon(ArrowUp01Icon)
export const ChevronDown = createIcon(ArrowDown01Icon)
export const ChevronLeft = createIcon(ArrowLeft01Icon)
export const ChevronRight = createIcon(ArrowRight01Icon)
export const ChevronsUp = createIcon(ArrowUpDoubleIcon)
export const ChevronsDown = createIcon(ArrowDownDoubleIcon)
export const ChevronsUpDown = createIcon(ArrowUpDownIcon)
export const CornerDownLeft = createIcon(ArrowDownLeft01Icon)
export const CornerDownRight = createIcon(ArrowDownRight01Icon)
export const MoveUp = createIcon(NodeMoveUpIcon)
export const MoveDown = createIcon(NodeMoveDownIcon)
export const Move = createIcon(MoveIcon)
export const Forward = createIcon(Forward01Icon)
export const ExternalLink = createIcon(LinkForwardIcon)

// ── Aliases (Icon suffix variants used in codebase) ─

// ── Social & Communication ──────────────────────────
export const User = createIcon(UserIcon)
export const Users = createIcon(UserMultipleIcon)
export const UserPlus = createIcon(UserAdd01Icon)
export const UserMinus = createIcon(UserMinus01Icon)
export const UserCheck = createIcon(UserCheck01Icon)
export const UserX = createIcon(UserRemove01Icon)
export const MessageCircle = createIcon(Message01Icon)
export const MessageSquare = createIcon(MessageSquareCodeIcon)
export const MessagesSquare = createIcon(MessageMultiple01Icon)
export const AtSign = createIcon(AtIcon)
export const Hash = createIcon(HashtagIcon)

// ── UI & Interface ──────────────────────────────────
export const Home = createIcon(Home01Icon)
export const Settings = createIcon(Settings01Icon)
export const Settings2 = createIcon(Settings02Icon)
export const Cog = createIcon(CogIcon)
export const Menu = createIcon(Menu01Icon)
export const MoreHorizontal = createIcon(MoreHorizontalIcon)
export const MoreVertical = createIcon(MoreVerticalIcon)
export const Grid = createIcon(GridIcon)
export const Grid2X2 = createIcon(GridIcon)
export const List = createIcon(LeftToRightListBulletIcon)
export const ListChecks = createIcon(CheckListIcon)
export const ListTodo = createIcon(LeftToRightListDashIcon)
export const Layers = createIcon(Layers01Icon)
export const Layout = createIcon(Layout01Icon)
export const LayoutGrid = createIcon(LayoutGridIcon)
export const LayoutTemplate = createIcon(Layout03Icon)
export const Columns2 = createIcon(LayoutTwoColumnIcon)
export const Columns3 = createIcon(LayoutThreeColumnIcon)
export const Rows2 = createIcon(LayoutTwoRowIcon)
export const Maximize = createIcon(Maximize01Icon)
export const Maximize2 = createIcon(Maximize02Icon)
export const Minimize = createIcon(Minimize01Icon)
export const Minimize2 = createIcon(Minimize02Icon)
export const Eye = createIcon(EyeIcon)
export const EyeOff = createIcon(ViewOffIcon)
export const Search = createIcon(Search01Icon)
export const Filter = createIcon(FilterIcon)
export const Focus = createIcon(FocusPointIcon)
export const SlidersHorizontal = createIcon(SlidersHorizontalIcon)
export const GripHorizontal = createIcon(DragDropHorizontalIcon)
export const GripVertical = createIcon(DragDropVerticalIcon)
export const PanelLeft = createIcon(PanelLeftIcon)
export const PanelRight = createIcon(PanelRightIcon)
export const AlignLeft = createIcon(AlignLeftIcon)

// ── Status & Indicators ─────────────────────────────
export const Check = createIcon(Tick01Icon)
export const CheckCircle = createIcon(CheckmarkCircle01Icon)
export const CheckCircle2 = createIcon(CheckmarkCircle02Icon)
export const CheckSquare = createIcon(CheckmarkSquare01Icon)
export const X = createIcon(Cancel01Icon)
export const XCircle = createIcon(CancelCircleIcon)
export const AlertCircle = createIcon(AlertCircleIcon)
export const AlertTriangle = createIcon(Alert02Icon)
export const Info = createIcon(InformationCircleIcon)
export const HelpCircle = createIcon(HelpCircleIcon)
export const Loader = createIcon(LoaderPinwheelIcon)
export const Loader2 = createIcon(Loading03Icon)
export const RefreshCw = createIcon(Refresh01Icon)
export const RotateCcw = createIcon(RotateLeft01Icon)
export const RotateCw = createIcon(RotateRight01Icon)
export const CircleDashed = createIcon(DashedLineCircleIcon)
export const Progress = createIcon(Progress03Icon)
export const BadgeCheck = createIcon(CheckmarkBadge01Icon)
export const ShieldAlert = createIcon(Shield01Icon)
export const Repeat = createIcon(RepeatIcon)

// ── Media & Creative ────────────────────────────────
export const Image = createIcon(Image01Icon)
export const Camera = createIcon(Camera01Icon)
export const Video = createIcon(Video01Icon)
export const Music = createIcon(MusicNote01Icon)
export const Mic = createIcon(Mic01Icon)
export const Play = createIcon(PlayIcon)
export const Pause = createIcon(PauseIcon)
export const SkipBack = createIcon(PreviousIcon)
export const SkipForward = createIcon(NextIcon)
export const Square = createIcon(SquareIcon)
export const Circle = createIcon(CircleIcon)
export const Triangle = createIcon(TriangleIcon)
export const Hexagon = createIcon(HexagonIcon)
export const Palette = createIcon(ColorsIcon)
export const Brush = createIcon(BrushIcon)
export const Volume1 = createIcon(VolumeLowIcon)
export const Volume2 = createIcon(VolumeHighIcon)
export const VolumeX = createIcon(VolumeMute01Icon)

// ── Tech & Development ──────────────────────────────
export const Code = createIcon(CodeIcon)
export const Terminal = createIcon(ComputerTerminal01Icon)
export const Database = createIcon(DatabaseIcon)
export const Server = createIcon(ServerStack01Icon)
export const Cloud = createIcon(CloudIcon)
export const CloudOff = createIcon(CloudOffIcon)
export const Wifi = createIcon(Wifi01Icon)
export const Globe = createIcon(GlobeIcon)
export const Smartphone = createIcon(SmartPhone01Icon)
export const Monitor = createIcon(ComputerIcon)
export const Cpu = createIcon(CpuIcon)
export const HardDrive = createIcon(HardDriveIcon)
export const Usb = createIcon(UsbIcon)
export const Network = createIcon(NeuralNetworkIcon)
export const GitGraph = createIcon(GitBranchIcon)
export const QrCode = createIcon(QrCodeIcon)

// ── Nature & Weather ────────────────────────────────
export const Sun = createIcon(Sun01Icon)
export const Moon = createIcon(MoonIcon)
export const CloudRain = createIcon(CloudAngledRainIcon)
export const Snowflake = createIcon(SnowIcon)
export const Wind = createIcon(FastWindIcon)
export const Zap = createIcon(ZapIcon)
export const Flame = createIcon(FireIcon)
export const Droplet = createIcon(DropletIcon)
export const Leaf = createIcon(Leaf01Icon)
export const Sunrise = createIcon(SunriseIcon)
export const Sunset = createIcon(SunsetIcon)
export const TreeDeciduous = createIcon(Tree01Icon)

// ── Misc ────────────────────────────────────────────
export const ALargeSmall = createIcon(TextFontIcon)
export const Type = createIcon(TextIcon)
export const CreditCard = createIcon(CreditCardIcon)
export const Lightbulb = createIcon(BulbIcon)
export const Paperclip = createIcon(Attachment01Icon)
export const Smile = createIcon(SmileIcon)
export const Sparkles = createIcon(SparklesIcon)
export const Bot = createIcon(BotIcon)
export const Brain = createIcon(BrainIcon)
export const History = createIcon(WorkHistoryIcon)
export const LogOut = createIcon(Logout01Icon)
export const Plus = createIcon(PlusSignIcon)
export const Minus = createIcon(MinusSignIcon)
export const TrendingUp = createIcon(ChartIncreaseIcon)
export const ZoomIn = createIcon(ZoomInAreaIcon)
export const ZoomOut = createIcon(ZoomOutAreaIcon)

// ── Text formatting ─────────────────────────────────
export const Bold = createIcon(TextBoldIcon)
export const Italic = createIcon(TextItalicIcon)
export const Underline = createIcon(TextUnderlineIcon)
export const Strikethrough = createIcon(TextStrikethroughIcon)
export const TextCursorInput = createIcon(TypeCursorIcon)
export const Languages = createIcon(LanguageCircleIcon)
export const Expand = createIcon(ExpandIcon)
export const Shrink = createIcon(ArrowShrinkIcon)

// ── Additional UI ───────────────────────────────────
export const PanelLeftClose = createIcon(PanelLeftCloseIcon)
export const FileQuestion = createIcon(FileQuestionMarkIcon)
export const Import = createIcon(FileImportIcon)
export const Pin = createIcon(PinIcon)
export const SortAsc = createIcon(SortByUp01Icon)
export const Laptop = createIcon(LaptopIcon)
export const Shield = createIcon(Shield02Icon)
export const MoveVertical = createIcon(ArrowUpDownIcon)
export const Plug = createIcon(Plug01Icon)
export const Collapse = createIcon(CollapseIcon)
export const Heading1 = createIcon(Heading01Icon)
export const Heading2 = createIcon(Heading02Icon)
export const Heading3 = createIcon(Heading03Icon)
export const ListOrdered = createIcon(LeftToRightListNumberIcon)
export const Quote = createIcon(LeftToRightBlockQuoteIcon)
export const Sigma = createIcon(SummationCircleIcon)
export const FileType = createIcon(FileTypeIcon)
export const TrendingDown = createIcon(ChartDecreaseIcon)
export const BellOff = createIcon(NotificationOff01Icon)

// ── Alias exports for "Icon"-suffixed names ─────────
export { PanelLeft as PanelLeftIcon }
export { Calendar as CalendarIcon }
export { Check as CheckIcon }
export { ChevronRight as ChevronRightIcon }
export { Circle as CircleIcon }
export { FileIcon_ as FileIcon }
export { X as XIcon }
