import { forwardRef } from 'react'
import type { AppIcon } from './types'

type SvgProps = React.ComponentPropsWithRef<'svg'> & {
  size?: string | number
}

function createSvgIcon(path: React.ReactNode, displayName: string, viewBox = '0 0 15 15'): AppIcon {
  const Icon = forwardRef<SVGSVGElement, SvgProps>(({ size = 15, className, ...rest }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      {path}
    </svg>
  ))
  Icon.displayName = displayName
  return Icon as AppIcon
}

export const SidebarInbox = createSvgIcon(
  <>
    <path d="M1.5 9.5h3.5l1 2h3l1-2h3.5" />
    <path d="M2.5 4.5l-1 5v3h12v-3l-1-5h-10z" />
  </>,
  'SidebarInbox'
)

export const SidebarJournal = createSvgIcon(
  <>
    <rect x="3" y="1.5" width="9.5" height="12" rx="1" />
    <path d="M5.5 4.5h4" />
    <path d="M5.5 7h3" />
    <path d="M1.5 3.5v8" />
  </>,
  'SidebarJournal'
)

export const SidebarTasks = createSvgIcon(
  <>
    <rect x="2" y="2" width="11" height="11" rx="2" />
    <path d="M5 7.5l1.5 1.5 3.5-3.5" />
  </>,
  'SidebarTasks'
)

export const SidebarGraph = createSvgIcon(
  <>
    <circle cx="7.5" cy="3.5" r="2" />
    <circle cx="3" cy="11.5" r="2" />
    <circle cx="12" cy="11.5" r="2" />
    <path d="M6.2 5.2l-2 4.5" />
    <path d="M8.8 5.2l2 4.5" />
  </>,
  'SidebarGraph'
)
