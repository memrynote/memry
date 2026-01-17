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
 * Parses the QR JSON string and forwards structured fields to the API.
 */
export function useLinkViaQR() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { qrData: string; deviceName: string }) => {
      // Parse the QR JSON string to extract individual fields
      const parsed = JSON.parse(input.qrData) as {
        sessionId: string
        token: string
        ephemeralPublicKey: string
        expiresAt: number
      }
      const result = await window.api.sync.linkViaQR({
        sessionId: parsed.sessionId,
        token: parsed.token,
        ephemeralPublicKey: parsed.ephemeralPublicKey,
        deviceName: input.deviceName
      })
      return result as { success: boolean; error?: string; sessionId?: string }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkingKeys.status() })
      queryClient.invalidateQueries({ queryKey: linkingKeys.devices() })
    }
  })
}

/**
 * Approve a device linking request (on the existing device).
 * Requires proof data from the linking request event.
 */
export function useApproveLinking() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      sessionId: string
      newDevicePublicKey: string
      newDeviceConfirm: string
    }) => {
      const result = await window.api.sync.approveLinking(input)
      return result as { success: boolean; error?: string }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkingKeys.devices() })
    }
  })
}

/**
 * Reject a device linking request.
 * Uses cancelLinking since approveLinking now requires proof data.
 */
export function useRejectLinking() {
  return useMutation({
    mutationFn: async (_input: { sessionId: string }) => {
      // Note: rejecting uses cancel since approve requires proof data
      const result = await window.api.sync.cancelLinking()
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
    newDevicePublicKey: string
    newDeviceConfirm: string
  }) => void
  onLinkingApproved?: (e: { sessionId: string; deviceId: string }) => void
  onLinkingRejected?: (e: { sessionId: string; reason: string }) => void
  onLinkingExpired?: (e: { sessionId: string }) => void
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

    // Subscribe to linking expired events
    unsubs.push(
      window.api.onSyncLinkingExpired((event) => {
        callbacksRef.current.onLinkingExpired?.(event)
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
    newDevicePublicKey: string
    newDeviceConfirm: string
  }) => void
  onLinkingExpired?: (e: { sessionId: string }) => void
}) {
  const generateQR = useGenerateLinkingQR()
  const approveLinking = useApproveLinking()
  const rejectLinking = useRejectLinking()
  const cancelLinking = useCancelLinking()

  useLinkingEvents({
    onLinkingRequest: callbacks?.onLinkingRequest,
    onLinkingExpired: callbacks?.onLinkingExpired
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
  onLinkingExpired?: (e: { sessionId: string }) => void
}) {
  const linkViaQR = useLinkViaQR()
  const cancelLinking = useCancelLinking()

  useLinkingEvents({
    onLinkingApproved: callbacks?.onLinkingApproved,
    onLinkingRejected: callbacks?.onLinkingRejected,
    onLinkingExpired: callbacks?.onLinkingExpired
  })

  return {
    linkViaQR,
    cancelLinking
  }
}
