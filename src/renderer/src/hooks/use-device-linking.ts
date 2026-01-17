/**
 * Device Linking Hooks
 *
 * React hooks for QR code device linking operations.
 *
 * @module hooks/use-device-linking
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

// =============================================================================
// Query Keys
// =============================================================================

export const linkingKeys = {
  all: ['linking'] as const,
  status: () => [...linkingKeys.all, 'status'] as const,
  devices: () => [...linkingKeys.all, 'devices'] as const
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Generate a QR code for device linking.
 * Returns QR data string and expiration timestamp.
 */
export function useGenerateLinkingQR() {
  return useMutation({
    mutationFn: async () => {
      const result = await window.api.sync.generateLinkingQR()
      return result as { qrData: string; expiresAt: number }
    }
  })
}

/**
 * Link a new device via QR code data.
 */
export function useLinkViaQR() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { qrData: string; deviceName: string }) => {
      const result = await window.api.sync.linkViaQR(input)
      return result as { success: boolean; error?: string }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkingKeys.status() })
      queryClient.invalidateQueries({ queryKey: linkingKeys.devices() })
    }
  })
}

/**
 * Approve a device linking request (on the existing device).
 */
export function useApproveLinking() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      const result = await window.api.sync.approveLinking(sessionId, true)
      return result as { success: boolean; error?: string }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkingKeys.devices() })
    }
  })
}

/**
 * Reject a device linking request.
 */
export function useRejectLinking() {
  return useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      const result = await window.api.sync.approveLinking(sessionId, false)
      return result as { success: boolean; error?: string }
    }
  })
}

/**
 * Cancel the current device linking session.
 */
export function useCancelLinking() {
  return useMutation({
    mutationFn: async () => {
      const result = await window.api.sync.cancelLinking()
      return result as { success: boolean }
    }
  })
}

/**
 * Get current linking session status.
 */
export function useGetLinkingStatus() {
  return useMutation({
    mutationFn: async () => {
      const result = await window.api.sync.getLinkingStatus()
      return result as { status: string; session: unknown | null }
    }
  })
}

// =============================================================================
// Event Subscriptions
// =============================================================================

interface LinkingEventCallbacks {
  onLinkingRequest?: (e: {
    sessionId: string
    deviceName: string
    devicePlatform: string
  }) => void
  onLinkingApproved?: (e: { sessionId: string; deviceId: string }) => void
  onLinkingRejected?: (e: { sessionId: string; reason: string }) => void
}

/**
 * Subscribe to device linking events.
 * Automatically handles cleanup on unmount.
 */
export function useLinkingEvents(callbacks: LinkingEventCallbacks) {
  // Use refs to avoid re-subscribing when callbacks change
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    const unsubs: Array<() => void> = []

    // Subscribe to linking request events
    unsubs.push(
      window.api.onSyncLinkingRequest((event) => {
        callbacksRef.current.onLinkingRequest?.(event)
      })
    )

    // Subscribe to linking approved events
    unsubs.push(
      window.api.onSyncLinkingApproved((event) => {
        callbacksRef.current.onLinkingApproved?.(event)
      })
    )

    // Subscribe to linking rejected events
    unsubs.push(
      window.api.onSyncLinkingRejected((event) => {
        callbacksRef.current.onLinkingRejected?.(event)
      })
    )

    return () => {
      unsubs.forEach((fn) => fn())
    }
  }, [])
}

/**
 * Combined hook for the existing device flow:
 * - Generates QR code
 * - Subscribes to linking request events
 * - Provides approve/reject/cancel mutations
 */
export function useExistingDeviceLinking(callbacks?: {
  onLinkingRequest?: (e: {
    sessionId: string
    deviceName: string
    devicePlatform: string
  }) => void
}) {
  const generateQR = useGenerateLinkingQR()
  const approveLinking = useApproveLinking()
  const rejectLinking = useRejectLinking()
  const cancelLinking = useCancelLinking()

  useLinkingEvents({
    onLinkingRequest: callbacks?.onLinkingRequest
  })

  return {
    generateQR,
    approveLinking,
    rejectLinking,
    cancelLinking
  }
}

/**
 * Combined hook for the new device flow:
 * - Links via QR code data
 * - Subscribes to approval/rejection events
 * - Provides cancel mutation
 */
export function useNewDeviceLinking(callbacks?: {
  onLinkingApproved?: (e: { sessionId: string; deviceId: string }) => void
  onLinkingRejected?: (e: { sessionId: string; reason: string }) => void
}) {
  const linkViaQR = useLinkViaQR()
  const cancelLinking = useCancelLinking()

  useLinkingEvents({
    onLinkingApproved: callbacks?.onLinkingApproved,
    onLinkingRejected: callbacks?.onLinkingRejected
  })

  return {
    linkViaQR,
    cancelLinking
  }
}
