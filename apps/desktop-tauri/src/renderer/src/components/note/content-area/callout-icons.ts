import {
  Bell,
  Bookmark,
  Brain,
  Bug,
  Clock,
  Eye,
  Flag,
  Flame,
  Globe,
  Heart,
  Info,
  Lightbulb,
  Link,
  Lock,
  Music,
  Palette,
  Shield,
  Sparkles,
  Star,
  Tag,
  Zap,
  type AppIcon
} from '@/lib/icons'

/**
 * The icons a custom callout type can pick. The id is what syncs, so an id
 * never changes meaning; one this build does not know (added by a newer build)
 * draws `DEFAULT_CALLOUT_ICON` and keeps its stored id.
 */
export const CALLOUT_ICONS: Readonly<Record<string, AppIcon>> = {
  star: Star,
  heart: Heart,
  bolt: Zap,
  flame: Flame,
  sparkles: Sparkles,
  bell: Bell,
  bookmark: Bookmark,
  eye: Eye,
  lock: Lock,
  shield: Shield,
  flag: Flag,
  idea: Lightbulb,
  brain: Brain,
  globe: Globe,
  music: Music,
  tag: Tag,
  link: Link,
  clock: Clock,
  palette: Palette,
  bug: Bug,
  info: Info
}

export const CALLOUT_ICON_IDS = Object.keys(CALLOUT_ICONS)
export const DEFAULT_CALLOUT_ICON = 'star'

export function calloutIcon(id: string): AppIcon {
  return CALLOUT_ICONS[id] ?? CALLOUT_ICONS[DEFAULT_CALLOUT_ICON]
}
