import { useState, useEffect } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import type { IconSvgElement } from '@hugeicons/react'
import { CircleIcon } from '@hugeicons/core-free-icons'

let allIconsPromise: Promise<Record<string, unknown>> | null = null
const iconCache = new Map<string, IconSvgElement>()

export function loadAllIcons(): Promise<Record<string, unknown>> {
  if (!allIconsPromise) {
    allIconsPromise = import('@hugeicons/core-free-icons')
  }
  return allIconsPromise
}

export function HugeIconByName({
  name,
  className
}: {
  name: string
  className?: string
}): React.JSX.Element {
  const cached = iconCache.get(name)
  const [icon, setIcon] = useState<IconSvgElement | null>(cached ?? null)

  useEffect(() => {
    if (cached) return

    let cancelled = false
    loadAllIcons().then((mod) => {
      if (cancelled) return
      const resolved = mod[name] as IconSvgElement | undefined
      if (resolved) {
        iconCache.set(name, resolved)
        setIcon(resolved)
      }
    })
    return () => {
      cancelled = true
    }
  }, [name, cached])

  if (!icon) {
    return <HugeiconsIcon icon={CircleIcon} className={className} />
  }

  return <HugeiconsIcon icon={icon} className={className} />
}
