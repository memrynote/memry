import type { ComponentProps, HTMLAttributes } from 'react'
import { memo } from 'react'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import type { Pluggable, PluggableList, Plugin } from 'unified'
import {
  defaultRehypePlugins,
  defaultUrlTransform,
  Streamdown,
  type UrlTransform
} from 'streamdown'

import { cn } from '@/lib/utils'

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: 'assistant' | 'system' | 'tool' | 'user'
}

export function Message({ className, from, ...props }: MessageProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'group flex w-full max-w-[95%] flex-col gap-2',
        from === 'user' ? 'is-user ms-auto items-end' : 'is-assistant items-start',
        className
      )}
      data-role={from}
      {...props}
    />
  )
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export function MessageContent({
  children,
  className,
  ...props
}: MessageContentProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm',
        'group-[.is-user]:ms-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-3 group-[.is-user]:py-2 group-[.is-user]:text-foreground',
        'group-[.is-assistant]:text-foreground',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type MessageResponseProps = ComponentProps<typeof Streamdown>

const streamdownPlugins = { cjk, code, math, mermaid }
const memryUrlTransform: UrlTransform = (url, key, node) => {
  if (url.startsWith('memry://')) return url
  return defaultUrlTransform(url, key, node)
}
const defaultSanitizePlugin = defaultRehypePlugins.sanitize as unknown as [
  Plugin,
  { protocols?: Record<string, string[]> }
]
const memrySanitizePlugin: Pluggable = [
  defaultSanitizePlugin[0],
  {
    ...defaultSanitizePlugin[1],
    protocols: {
      ...defaultSanitizePlugin[1].protocols,
      href: [...(defaultSanitizePlugin[1].protocols?.href ?? []), 'memry']
    }
  }
] as Pluggable
const streamdownRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  memrySanitizePlugin,
  defaultRehypePlugins.harden
]

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        'min-w-0 max-w-full break-words leading-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className
      )}
      plugins={streamdownPlugins}
      rehypePlugins={streamdownRehypePlugins}
      urlTransform={memryUrlTransform}
      {...props}
    />
  ),
  (previousProps, nextProps) =>
    previousProps.children === nextProps.children &&
    previousProps.isAnimating === nextProps.isAnimating
)

MessageResponse.displayName = 'MessageResponse'
