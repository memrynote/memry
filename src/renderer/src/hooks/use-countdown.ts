import { useState, useEffect } from 'react'

interface CountdownResult {
  secondsLeft: number
  isExpired: boolean
  formattedTime: string
}

export function useCountdown(expiresAt: number): CountdownResult {
  const [secondsLeft, setSecondsLeft] = useState(() => {
    const now = Math.floor(Date.now() / 1000)
    return Math.max(0, expiresAt - now)
  })

  useEffect(() => {
    const remaining = Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
    if (remaining <= 0) return

    const interval = setInterval(() => {
      const left = Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
      setSecondsLeft(left)
      if (left <= 0) clearInterval(interval)
    }, 1000)

    return () => clearInterval(interval)
  }, [expiresAt])

  const minutes = Math.floor(secondsLeft / 60)
  const secs = secondsLeft % 60

  return {
    secondsLeft,
    isExpired: secondsLeft <= 0,
    formattedTime: `${minutes}:${secs.toString().padStart(2, '0')}`
  }
}
