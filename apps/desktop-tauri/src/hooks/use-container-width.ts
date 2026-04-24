import { useCallback, useEffect, useRef, useState } from 'react'

export function useContainerWidth(): [number, (node: HTMLElement | null) => void] {
  const [width, setWidth] = useState(0)
  const observerRef = useRef<ResizeObserver | null>(null)
  const nodeRef = useRef<HTMLElement | null>(null)

  const ref = useCallback((node: HTMLElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    nodeRef.current = node
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width)
      }
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect()
    }
  }, [])

  return [width, ref]
}
