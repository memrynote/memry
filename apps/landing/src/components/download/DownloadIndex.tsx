import type { ReactNode } from 'react'
import { Link } from 'react-router'
import {
  AppWindow,
  ArrowRight,
  ArrowUpRight,
  Copy,
  Download,
  Share,
  Smartphone,
  SquareTerminal
} from 'lucide-react'
import { ClipboardButton } from '@/components/download/ClipboardButton'
import { trackLandingEvent } from '@/lib/analytics'
import { CHROME_WEBSTORE_URL, FIREFOX_ADDONS_URL } from '@/lib/constants'
import {
  downloadHref,
  isMobileOS,
  type DesktopOS,
  type DetectedOS,
  type DownloadPlatform,
  type MobileOS
} from '@/lib/download'
import { getCanonicalUrl } from '@/lib/seo'
import { cn } from '@/lib/utils'

// Same cask the install guide documents (apps/docs/src/guide/install.md).
const BREW_COMMAND = 'brew install --cask memrynote/tap/memry'

type RowAction =
  | { kind: 'download'; platform: DownloadPlatform }
  | { kind: 'store'; browser: 'chrome' | 'firefox'; href: string }
  | { kind: 'copy'; text: string }
  | { kind: 'page'; href: string; label: string; target: string }
  | { kind: 'soon' }

interface IndexRow {
  platform: string
  detail: string
  /** The device this row is the pick for; marked once detection has run. */
  pickFor?: DesktopOS | MobileOS
  action: RowAction
}

interface IndexGroup {
  product: string
  /** Names the product in a share sheet: "memrynote Web Clipper for Chrome". */
  shareName: string
  icon: ReactNode
  /** Phone width only: the group header's trailing note, where there are no columns. */
  note: string
  rows: readonly IndexRow[]
}

const ICON_CLASS = 'size-[18px] text-ink'

const GROUPS: readonly IndexGroup[] = [
  {
    product: 'Desktop',
    shareName: 'memrynote',
    icon: <img src="/favicon.svg" alt="" width={20} height={20} className="size-5" />,
    note: 'on your computer',
    rows: [
      {
        platform: 'macOS',
        detail: 'Apple Silicon · .dmg · macOS 12+',
        pickFor: 'mac',
        action: { kind: 'download', platform: 'mac-arm64' }
      },
      {
        platform: 'macOS',
        detail: 'Intel · .dmg · macOS 12+',
        action: { kind: 'download', platform: 'mac-x64' }
      },
      {
        platform: 'Windows',
        detail: '.exe · Windows 10+',
        pickFor: 'windows',
        action: { kind: 'download', platform: 'windows' }
      },
      {
        platform: 'Linux',
        detail: '.AppImage · x64',
        pickFor: 'linux',
        action: { kind: 'download', platform: 'linux' }
      },
      {
        platform: 'Linux',
        detail: '.deb · x64',
        action: { kind: 'download', platform: 'linux-deb' }
      },
      { platform: 'Homebrew', detail: BREW_COMMAND, action: { kind: 'copy', text: BREW_COMMAND } }
    ]
  },
  {
    product: 'Web Clipper',
    shareName: 'memrynote Web Clipper',
    icon: <AppWindow className={ICON_CLASS} strokeWidth={1.8} />,
    note: 'desktop browsers',
    rows: [
      {
        platform: 'Chrome',
        detail: 'Chrome Web Store',
        action: { kind: 'store', browser: 'chrome', href: CHROME_WEBSTORE_URL }
      },
      {
        platform: 'Firefox',
        detail: 'Firefox Add-ons',
        action: { kind: 'store', browser: 'firefox', href: FIREFOX_ADDONS_URL }
      },
      { platform: 'Edge', detail: 'Edge Add-ons', action: { kind: 'soon' } }
    ]
  },
  {
    product: 'iPhone',
    shareName: 'memrynote',
    icon: <Smartphone className={ICON_CLASS} strokeWidth={1.8} />,
    note: 'beta',
    rows: [
      {
        platform: 'iOS',
        detail: 'TestFlight · iOS 26+',
        pickFor: 'ios',
        action: { kind: 'page', href: '/ios-beta', label: 'Join', target: 'ios-beta' }
      }
    ]
  },
  {
    product: 'CLI',
    shareName: 'memrynote CLI',
    icon: <SquareTerminal className={ICON_CLASS} strokeWidth={1.8} />,
    note: 'ships with desktop',
    rows: [
      {
        platform: 'Terminal',
        detail: 'Settings → Command Line',
        action: { kind: 'page', href: '/cli', label: 'Set up', target: 'cli' }
      }
    ]
  }
]

// The header and the rows share one column template, so each label sits over its values.
const GROUP_COLUMNS = 'md:grid-cols-[10.5rem_minmax(0,1fr)]'
const ROW_COLUMNS = 'gap-x-4 md:grid-cols-[7.75rem_minmax(0,1fr)_7rem]'

const ACTION_CLASS =
  'inline-flex min-h-10 items-center gap-1.5 rounded-md px-1 text-[14px] font-medium leading-5 text-ink underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40'

/**
 * Every product and build on one sheet: a four-column table from md up, product groups
 * with stacked rows below that. Phones get Share instead of Download on anything that
 * only installs on a computer, so the link can travel to the machine that can run it.
 */
export function DownloadIndex({ os }: { os: DetectedOS }) {
  const onPhone = isMobileOS(os)

  return (
    <section aria-label="Every memrynote download" className="xl:pt-3">
      <div
        aria-hidden
        className={cn(
          'hidden h-8 items-center border-b border-ink font-mono text-[11px] uppercase tracking-[0.06em] text-muted md:grid',
          GROUP_COLUMNS
        )}
      >
        <span>Product</span>
        <div className={cn('grid', ROW_COLUMNS)}>
          <span>Platform</span>
          <span>Build</span>
          {/* pe-1 matches the actions' own inset, so the label ends where their text ends. */}
          <span className="pe-1 text-end">Get</span>
        </div>
      </div>
      <ul className="flex flex-col gap-7 md:gap-0">
        {GROUPS.map((group) => (
          <li
            key={group.product}
            className={cn('md:grid md:border-b md:border-ink', GROUP_COLUMNS)}
          >
            {/* Type sits on the spans: the unlayered base h2 rule would beat utilities here. */}
            <h2 className="flex h-11 items-center gap-2.5 border-b border-ink md:h-[46px] md:border-b-0">
              <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
                {group.icon}
              </span>
              <span className="text-[16px] font-semibold leading-[22px] tracking-normal text-ink md:text-[15px]">
                {group.product}
              </span>
              <span className="ms-auto font-mono text-[11px] leading-[14px] tracking-normal text-muted md:hidden">
                {group.note}
              </span>
            </h2>
            <ul>
              {group.rows.map((row) => (
                <IndexRowItem
                  key={`${row.platform} ${row.detail}`}
                  row={row}
                  shareName={group.shareName}
                  isPick={row.pickFor !== undefined && row.pickFor === os}
                  onPhone={onPhone}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}

function IndexRowItem({
  row,
  shareName,
  isPick,
  onPhone
}: {
  row: IndexRow
  shareName: string
  isPick: boolean
  onPhone: boolean
}) {
  return (
    <li
      className={cn(
        'grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto] items-center border-b border-border/70 py-2 ps-[30px] last:border-b-0 md:min-h-[46px] md:py-1 md:ps-0',
        ROW_COLUMNS
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5 md:contents">
        <span
          className={cn(
            'flex items-center gap-[7px] text-[15px] leading-5 text-ink md:text-[14px]',
            isPick && 'font-semibold'
          )}
        >
          {row.platform}
          {isPick && (
            <>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-terracotta" />
              <span className="sr-only">, matches this device</span>
            </>
          )}
        </span>
        <span className="font-mono text-[12px] leading-4 text-muted">{row.detail}</span>
      </div>
      <div className="flex justify-end">
        <RowActionControl row={row} shareName={shareName} onPhone={onPhone} />
      </div>
    </li>
  )
}

function RowActionControl({
  row,
  shareName,
  onPhone
}: {
  row: IndexRow
  shareName: string
  onPhone: boolean
}) {
  const { action } = row

  switch (action.kind) {
    case 'download': {
      const href = downloadHref(action.platform)
      if (onPhone) {
        return (
          <ShareRowButton
            row={row}
            title={`${shareName} for ${row.platform}`}
            url={getCanonicalUrl(href)}
            target={action.platform}
          />
        )
      }
      return (
        <a
          href={href}
          onClick={() =>
            trackLandingEvent(
              'landing_download_click',
              `download:${action.platform}:download-index`
            )
          }
          className={ACTION_CLASS}
        >
          Download
          <span className="sr-only">
            {' '}
            for {row.platform}, {row.detail}
          </span>
          <Download className="size-3.5 shrink-0" aria-hidden />
        </a>
      )
    }
    case 'store':
      if (onPhone) {
        return (
          <ShareRowButton
            row={row}
            title={`${shareName} for ${row.platform}`}
            url={action.href}
            target={action.browser}
          />
        )
      }
      return (
        <a
          href={action.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() =>
            trackLandingEvent('landing_external_click', `download:${action.browser}:download-index`)
          }
          className={ACTION_CLASS}
        >
          Add
          <span className="sr-only"> the Web Clipper to {row.platform} (opens in a new tab)</span>
          <ArrowUpRight className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden />
        </a>
      )
    case 'copy':
      return (
        <ClipboardButton
          intent={{ kind: 'copy', text: action.text }}
          label="Copy"
          srLabel=" the Homebrew command"
          icon={<Copy className="size-3.5 shrink-0" aria-hidden />}
          className={ACTION_CLASS}
          onSuccess={() =>
            trackLandingEvent('landing_download_click', 'download:brew:download-index')
          }
        />
      )
    case 'page':
      return (
        <Link
          to={action.href}
          onClick={() =>
            trackLandingEvent('landing_nav_click', `download:${action.target}:download-index`)
          }
          className={ACTION_CLASS}
        >
          {action.label}
          <span className="sr-only">
            {' '}
            {row.platform}, {row.detail}
          </span>
          <ArrowRight className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden />
        </Link>
      )
    case 'soon':
      return <span className="px-1 text-[14px] leading-5 text-muted">Soon</span>
    default: {
      const exhaustive: never = action
      return exhaustive
    }
  }
}

function ShareRowButton({
  row,
  title,
  url,
  target
}: {
  row: IndexRow
  title: string
  url: string
  target: string
}) {
  return (
    <ClipboardButton
      intent={{ kind: 'share', title, url }}
      label="Share"
      srLabel={` the link for ${row.platform}, ${row.detail}`}
      icon={<Share className="size-3.5 shrink-0" aria-hidden />}
      className={ACTION_CLASS}
      onSuccess={() =>
        trackLandingEvent('landing_download_share', `share:${target}:download-index`)
      }
    />
  )
}
