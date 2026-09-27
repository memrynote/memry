import { forwardRef, useId, type ForwardRefExoticComponent, type ReactNode } from 'react'
import { useToday } from '@/hooks/use-today'

/*
 * The six top-level pages (Home, Inbox, Journal, Calendar, Tasks, Graph) share
 * one glyph each across the app: the rail, tabs, menus, search, mentions. Each
 * has an outline form and, for the rail's selected page, a solid form. Neither
 * icon set ships solid variants, so the solid form is built here: the
 * silhouette is filled, and inner details are punched out through a mask so
 * they show whatever sits behind the icon instead of a guessed colour.
 *
 * Path data: Home07, Inbox, Calendar01, ChartRelationship from
 * @hugeicons/core-free-icons (MIT); NotebookPen, ClipboardCheck from
 * lucide-react (ISC), all drawn at one stroke so they sit together.
 *
 * The stroke defaults to Hugeicons' 1.5 so the glyphs match the icons around
 * them. The rail passes 1.8: at its 20px size that lands on 1.5 device pixels,
 * where 1.5 came to 1.25px and smeared lines across two half-bright pixels on
 * 1x displays.
 */

export type PageIconProps = React.ComponentPropsWithoutRef<'svg'> & {
  /** Solid form, for the selected page. */
  active?: boolean
  size?: string | number
  strokeWidth?: number
}

/** Compatible with `AppIcon`, so a page icon drops in wherever one is expected. */
export type PageIcon = ForwardRefExoticComponent<PageIconProps & React.RefAttributes<SVGSVGElement>>

interface GlyphParts {
  /** Inactive form, stroked in currentColor. */
  outline: ReactNode
  /** Filled and stroked in currentColor when active. */
  solid: ReactNode
  /** Drawn in black inside the mask: whatever it covers is cut out of `solid`. */
  knockout?: ReactNode
  /** Drawn on top of the masked fill when active (parts the knockout separated). */
  overlay?: ReactNode
}

const PageGlyph = forwardRef<SVGSVGElement, PageIconProps & GlyphParts>(
  (
    { active = false, size = 24, strokeWidth = 1.5, outline, solid, knockout, overlay, ...rest },
    ref
  ) => {
    // useId output carries characters (`:`/`«»`) that are unsafe inside url(#…).
    const maskId = `page-icon-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        // Decorative by default; a caller that names the icon keeps it in the a11y tree.
        aria-hidden={rest['aria-label'] || rest['aria-labelledby'] ? undefined : true}
        data-active={active || undefined}
        {...rest}
      >
        {active ? (
          <>
            {knockout && (
              <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                <rect width="24" height="24" fill="white" stroke="none" />
                <g color="black" stroke="black">
                  {knockout}
                </g>
              </mask>
            )}
            <g fill="currentColor" mask={knockout ? `url(#${maskId})` : undefined}>
              {solid}
            </g>
            {overlay && <g fill="currentColor">{overlay}</g>}
          </>
        ) : (
          outline
        )}
      </svg>
    )
  }
)
PageGlyph.displayName = 'PageGlyph'

function definePageIcon(displayName: string, parts: GlyphParts): PageIcon {
  const Icon = forwardRef<SVGSVGElement, PageIconProps>((props, ref) => (
    <PageGlyph ref={ref} {...props} {...parts} />
  ))
  Icon.displayName = displayName
  return Icon
}

const HOME_BODY =
  'M12.8924 2.80982L21.4876 9.59547C21.8112 9.85095 22 10.2405 22 10.6528C22 11.3969 21.3969 12 20.6528 12H20V15.5C20 18.3284 20 19.7426 19.1213 20.6213C18.2426 21.5 16.8284 21.5 14 21.5H10C7.17157 21.5 5.75736 21.5 4.87868 20.6213C4 19.7426 4 18.3284 4 15.5V12H3.34716C2.60315 12 2 11.3969 2 10.6528C2 10.2405 2.1888 9.85095 2.5124 9.59547L11.1076 2.80982C11.3617 2.60915 11.6761 2.5 12 2.5C12.3239 2.5 12.6383 2.60915 12.8924 2.80982Z'
const HOME_DOOR =
  'M14.5 21.5V17C14.5 16.0654 14.5 15.5981 14.299 15.25C14.1674 15.022 13.978 14.8326 13.75 14.701C13.4019 14.5 12.9346 14.5 12 14.5C11.0654 14.5 10.5981 14.5 10.25 14.701C10.022 14.8326 9.83261 15.022 9.70096 15.25C9.5 15.5981 9.5 16.0654 9.5 17V21.5'

export const PageHomeIcon = definePageIcon('PageHomeIcon', {
  outline: (
    <>
      <path d={HOME_BODY} />
      <path d={HOME_DOOR} />
    </>
  ),
  solid: <path d={HOME_BODY} />,
  // The door is cut out whole and the cut runs past the floor line, so the
  // doorway opens cleanly instead of leaving a sliver of floor under it.
  knockout: (
    <>
      <path d={HOME_DOOR} fill="black" />
      <rect x="9.5" y="18" width="5" height="6" fill="black" />
    </>
  )
})

const INBOX_BODY =
  'M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z'
const INBOX_TRAY =
  'M21.5 13.5H16.5743C15.7322 13.5 15.0706 14.2036 14.6995 14.9472C14.2963 15.7551 13.4889 16.5 12 16.5C10.5111 16.5 9.70373 15.7551 9.30054 14.9472C8.92942 14.2036 8.26777 13.5 7.42566 13.5H2.5'

export const PageInboxIcon = definePageIcon('PageInboxIcon', {
  outline: (
    <>
      <path d={INBOX_BODY} />
      <path d={INBOX_TRAY} />
    </>
  ),
  solid: <path d={INBOX_BODY} />,
  knockout: <path d={INBOX_TRAY} />
})

const NOTEBOOK_BODY = 'M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4'
const NOTEBOOK_RINGS = 'M2 6h4M2 10h4M2 14h4M2 18h4'
const NOTEBOOK_PEN =
  'M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z'

export const PageJournalIcon = definePageIcon('PageJournalIcon', {
  outline: (
    <>
      <path d={NOTEBOOK_BODY} />
      <path d={NOTEBOOK_RINGS} />
      <path d={NOTEBOOK_PEN} />
    </>
  ),
  solid: <path d={NOTEBOOK_BODY} />,
  // A wide halo around the pen parts it from the filled page.
  knockout: <path d={NOTEBOOK_PEN} strokeWidth={4} fill="black" />,
  overlay: (
    <>
      <path d={NOTEBOOK_RINGS} />
      <path d={NOTEBOOK_PEN} />
    </>
  )
})

const CALENDAR_RINGS = 'M16 2V6M8 2V6'
const CALENDAR_BODY =
  'M13 4H11C7.22876 4 5.34315 4 4.17157 5.17157C3 6.34315 3 8.22876 3 12V14C3 17.7712 3 19.6569 4.17157 20.8284C5.34315 22 7.22876 22 11 22H13C16.7712 22 18.6569 22 19.8284 20.8284C21 19.6569 21 17.7712 21 14V12C21 8.22876 21 6.34315 19.8284 5.17157C18.6569 4 16.7712 4 13 4Z'
const CALENDAR_HEADER = 'M3 10H21'

/** Calendar01 with today's day of month in place of the stock "17". */
export const PageCalendarIcon: PageIcon = forwardRef<SVGSVGElement, PageIconProps>((props, ref) => {
  const day = String(Number(useToday().slice(8, 10)))
  const dayText = (
    <text
      x="12"
      y="16.25"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize="8"
      fontWeight="700"
      fill="currentColor"
      stroke="none"
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {day}
    </text>
  )

  return (
    <PageGlyph
      ref={ref}
      {...props}
      outline={
        <>
          <path d={CALENDAR_RINGS} />
          <path d={CALENDAR_BODY} />
          <path d={CALENDAR_HEADER} />
          {dayText}
        </>
      }
      solid={
        <>
          <path d={CALENDAR_RINGS} />
          <path d={CALENDAR_BODY} />
        </>
      }
      knockout={
        <>
          <path d={CALENDAR_HEADER} />
          {dayText}
        </>
      }
    />
  )
})
PageCalendarIcon.displayName = 'PageCalendarIcon'

const CLIPBOARD_CLIP = <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
const CLIPBOARD_BODY = 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'
const CLIPBOARD_CHECK = 'm9 14 2 2 4-4'

export const PageTasksIcon = definePageIcon('PageTasksIcon', {
  outline: (
    <>
      {CLIPBOARD_CLIP}
      <path d={CLIPBOARD_BODY} />
      <path d={CLIPBOARD_CHECK} />
    </>
  ),
  solid: <path d={CLIPBOARD_BODY} />,
  knockout: (
    <>
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" strokeWidth={4} fill="black" />
      <path d={CLIPBOARD_CHECK} />
    </>
  ),
  overlay: CLIPBOARD_CLIP
})

const GRAPH_SHAPES = (
  <>
    <path d="M11 5L18 5" />
    <path d="M10 10L14.5 14.5" />
    <path d="M5 11L5 18" />
    <circle cx="6.44444" cy="6.44444" r="4.44444" />
    <circle cx="5" cy="20" r="2" />
    <circle cx="16" cy="16" r="2" />
    <circle cx="20" cy="5" r="2" />
  </>
)

/** Graph has no closed silhouette to fill; its active form is the same lines. */
export const PageGraphIcon = definePageIcon('PageGraphIcon', {
  outline: GRAPH_SHAPES,
  solid: GRAPH_SHAPES
})
