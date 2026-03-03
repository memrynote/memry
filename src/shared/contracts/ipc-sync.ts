export * from './ipc-auth'
export * from './ipc-crypto'
export * from './ipc-sync-ops'
export * from './ipc-devices'
export * from './ipc-attachments'
export * from './ipc-events'
export * from './ipc-crdt'

import { AUTH_CHANNELS } from './ipc-auth'
import { CRYPTO_CHANNELS } from './ipc-crypto'
import { SYNC_OP_CHANNELS } from './ipc-sync-ops'
import { DEVICE_CHANNELS } from './ipc-devices'
import { ATTACHMENT_CHANNELS } from './ipc-attachments'
import { EVENT_CHANNELS } from './ipc-events'
import { CRDT_CHANNELS, CRDT_EVENTS } from './ipc-crdt'

export const SYNC_CHANNELS = {
  ...AUTH_CHANNELS,
  ...CRYPTO_CHANNELS,
  ...SYNC_OP_CHANNELS,
  ...DEVICE_CHANNELS,
  ...ATTACHMENT_CHANNELS,
  ...CRDT_CHANNELS
} as const

export const SYNC_EVENTS = {
  ...EVENT_CHANNELS,
  ...CRDT_EVENTS
} as const
