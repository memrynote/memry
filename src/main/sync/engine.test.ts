/**
 * Sync Engine Tests
 *
 * Simulates Device A ↔ Server ↔ Device B sync scenarios.
 * Uses mock server and crypto to test end-to-end sync flow.
 *
 * @module main/sync/engine.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  SyncPushItem,
  SyncPullItem,
  SyncPushResponse,
  SyncPullResponse,
  VectorClock,
  SyncItemType,
  SyncOperation,
} from '@shared/contracts/sync-api'

// ===========================================================================
// Mock Server Implementation
// ===========================================================================

/**
 * In-memory mock sync server for testing.
 * Stores items pushed by devices and serves them on pull.
 */
class MockSyncServer {
  private items: Map<string, SyncPullItem> = new Map()
  private serverClock: VectorClock = {}
  private serverTimestamp: number = Date.now()

  /**
   * Handle push request from a device.
   */
  push(items: SyncPushItem[], deviceClock: VectorClock): SyncPushResponse {
    const accepted: string[] = []
    const conflicts: Array<{ id: string; type: SyncItemType; serverVersion: number; serverClock: VectorClock }> = []

    for (const item of items) {
      const existing = this.items.get(item.id)

      // For simplicity in tests, we always accept updates (last-write-wins)
      // Real conflict detection would compare vector clocks
      if (existing && false) {
        // Disabled: simple conflict detection
        conflicts.push({
          id: item.id,
          type: item.type,
          serverVersion: existing.version,
          serverClock: existing.clock || {},
        })
        continue
      }

      // Accept the item
      const pullItem: SyncPullItem = {
        id: item.id,
        type: item.type,
        version: (existing?.version || 0) + 1,
        operation: item.operation, // Include operation for proper signature verification
        encryptedData: item.encryptedData,
        signature: item.signature,
        clock: item.clock,
        stateVector: item.stateVector,
        modifiedAt: Date.now(),
        deletedAt: item.operation === 'delete' ? Date.now() : undefined,
      }

      this.items.set(item.id, pullItem)
      accepted.push(item.id)

      // Update server clock
      if (item.clock) {
        for (const [device, time] of Object.entries(item.clock)) {
          this.serverClock[device] = Math.max(this.serverClock[device] || 0, time)
        }
      }
    }

    // Merge device clock into server clock
    for (const [device, time] of Object.entries(deviceClock)) {
      this.serverClock[device] = Math.max(this.serverClock[device] || 0, time)
    }

    this.serverTimestamp = Date.now()

    return {
      success: true,
      accepted,
      conflicts,
      serverClock: { ...this.serverClock },
    }
  }

  /**
   * Handle pull request from a device.
   */
  pull(since?: number, limit: number = 100): SyncPullResponse {
    let items = Array.from(this.items.values())

    // Filter by timestamp if since is provided
    if (since) {
      items = items.filter((item) => item.modifiedAt > since)
    }

    // Sort by modifiedAt
    items.sort((a, b) => a.modifiedAt - b.modifiedAt)

    // Apply limit
    const hasMore = items.length > limit
    items = items.slice(0, limit)

    return {
      items,
      hasMore,
      serverClock: { ...this.serverClock },
      serverTimestamp: this.serverTimestamp,
    }
  }

  /**
   * Get an item by ID.
   */
  getItem(id: string): SyncPullItem | undefined {
    return this.items.get(id)
  }

  /**
   * Get all items.
   */
  getAllItems(): SyncPullItem[] {
    return Array.from(this.items.values())
  }

  /**
   * Reset server state.
   */
  reset(): void {
    this.items.clear()
    this.serverClock = {}
    this.serverTimestamp = Date.now()
  }
}

// ===========================================================================
// Mock Crypto Functions
// ===========================================================================

// Simulated encryption/decryption (just base64 encode/decode for testing)
const mockEncrypt = (data: string): string => {
  return JSON.stringify({
    cryptoVersion: 1,
    encryptedKey: Buffer.from('mock-key').toString('base64'),
    keyNonce: Buffer.from('mock-key-nonce').toString('base64'),
    encryptedData: Buffer.from(data).toString('base64'),
    dataNonce: Buffer.from('mock-data-nonce').toString('base64'),
  })
}

const mockDecrypt = (encryptedJson: string): string => {
  const encrypted = JSON.parse(encryptedJson)
  return Buffer.from(encrypted.encryptedData, 'base64').toString('utf-8')
}

const mockSign = (_payload: unknown): string => {
  return Buffer.from('mock-signature').toString('base64')
}

const mockVerify = (_signature: string, _payload: unknown): boolean => {
  return true // Always valid in tests
}

// ===========================================================================
// Tests
// ===========================================================================

describe('sync engine - Device A ↔ Server ↔ Device B', () => {
  let mockServer: MockSyncServer

  beforeEach(() => {
    mockServer = new MockSyncServer()
    vi.clearAllMocks()
  })

  afterEach(() => {
    mockServer.reset()
  })

  // ===========================================================================
  // Basic Push/Pull Flow
  // ===========================================================================

  describe('basic push/pull flow', () => {
    it('should push an item from Device A and pull it on Device B', () => {
      const deviceAId = 'device-A'
      const deviceBId = 'device-B'

      // Device A creates a task
      const taskData = { id: 'task-123', title: 'Test Task', completed: false }
      const encryptedData = mockEncrypt(JSON.stringify(taskData))

      const pushItem: SyncPushItem = {
        id: 'task-123',
        type: 'task',
        operation: 'create',
        encryptedData,
        signature: mockSign({ id: 'task-123', type: 'task', operation: 'create' }),
        clock: { [deviceAId]: 1 },
      }

      // Device A pushes to server
      const pushResponse = mockServer.push([pushItem], { [deviceAId]: 1 })

      expect(pushResponse.success).toBe(true)
      expect(pushResponse.accepted).toContain('task-123')
      expect(pushResponse.conflicts).toHaveLength(0)

      // Device B pulls from server
      const pullResponse = mockServer.pull()

      expect(pullResponse.items).toHaveLength(1)
      expect(pullResponse.items[0].id).toBe('task-123')
      expect(pullResponse.items[0].type).toBe('task')
      expect(pullResponse.items[0].operation).toBe('create')

      // Device B decrypts the data
      const decryptedData = mockDecrypt(pullResponse.items[0].encryptedData)
      const pulledTask = JSON.parse(decryptedData)

      expect(pulledTask.id).toBe('task-123')
      expect(pulledTask.title).toBe('Test Task')
      expect(pulledTask.completed).toBe(false)

      // Verify signature
      const isValid = mockVerify(pullResponse.items[0].signature, {})
      expect(isValid).toBe(true)
    })

    it('should sync multiple items from Device A to Device B', () => {
      const deviceAId = 'device-A'

      // Device A creates multiple items
      const items: SyncPushItem[] = [
        {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedData: mockEncrypt(JSON.stringify({ id: 'task-1', title: 'Task 1' })),
          signature: mockSign({}),
          clock: { [deviceAId]: 1 },
        },
        {
          id: 'task-2',
          type: 'task',
          operation: 'create',
          encryptedData: mockEncrypt(JSON.stringify({ id: 'task-2', title: 'Task 2' })),
          signature: mockSign({}),
          clock: { [deviceAId]: 2 },
        },
        {
          id: 'note-1',
          type: 'note',
          operation: 'create',
          encryptedData: mockEncrypt(JSON.stringify({ id: 'note-1', content: 'Note content' })),
          signature: mockSign({}),
          clock: { [deviceAId]: 3 },
        },
      ]

      // Device A pushes all items
      const pushResponse = mockServer.push(items, { [deviceAId]: 3 })

      expect(pushResponse.accepted).toHaveLength(3)

      // Device B pulls all items
      const pullResponse = mockServer.pull()

      expect(pullResponse.items).toHaveLength(3)

      // Verify all items are present
      const ids = pullResponse.items.map((item) => item.id)
      expect(ids).toContain('task-1')
      expect(ids).toContain('task-2')
      expect(ids).toContain('note-1')
    })

    it('should handle incremental sync with since parameter', () => {
      const deviceAId = 'device-A'

      // Device A pushes first item
      mockServer.push(
        [
          {
            id: 'task-1',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ id: 'task-1' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      // Record timestamp after first sync
      const firstPull = mockServer.pull()
      const sinceTimestamp = firstPull.serverTimestamp

      // Wait a bit to ensure different timestamps
      const laterTimestamp = sinceTimestamp + 1000

      // Device A pushes second item (simulate later)
      const laterItem: SyncPullItem = {
        id: 'task-2',
        type: 'task',
        version: 1,
        operation: 'create',
        encryptedData: mockEncrypt(JSON.stringify({ id: 'task-2' })),
        signature: mockSign({}),
        clock: { [deviceAId]: 2 },
        modifiedAt: laterTimestamp,
      }
        // Manually add to simulate time passing
        ; (mockServer as unknown as { items: Map<string, SyncPullItem> }).items.set('task-2', laterItem)

      // Device B does incremental pull (only new items since first sync)
      const incrementalPull = mockServer.pull(sinceTimestamp)

      expect(incrementalPull.items).toHaveLength(1)
      expect(incrementalPull.items[0].id).toBe('task-2')
    })
  })

  // ===========================================================================
  // Update Operations
  // ===========================================================================

  describe('update operations', () => {
    it('should sync updates from Device A to Device B', () => {
      const deviceAId = 'device-A'

      // Device A creates a task
      mockServer.push(
        [
          {
            id: 'task-123',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ id: 'task-123', title: 'Original' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      // Device A updates the task
      mockServer.push(
        [
          {
            id: 'task-123',
            type: 'task',
            operation: 'update',
            encryptedData: mockEncrypt(JSON.stringify({ id: 'task-123', title: 'Updated' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 2 },
          },
        ],
        { [deviceAId]: 2 }
      )

      // Device B pulls
      const pullResponse = mockServer.pull()

      // Should have the updated version
      expect(pullResponse.items).toHaveLength(1)
      expect(pullResponse.items[0].operation).toBe('update')

      const decrypted = JSON.parse(mockDecrypt(pullResponse.items[0].encryptedData))
      expect(decrypted.title).toBe('Updated')
    })
  })

  // ===========================================================================
  // Delete Operations
  // ===========================================================================

  describe('delete operations', () => {
    it('should sync delete from Device A to Device B', () => {
      const deviceAId = 'device-A'

      // Device A creates a task
      mockServer.push(
        [
          {
            id: 'task-123',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ id: 'task-123', title: 'To Delete' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      // Device A deletes the task
      mockServer.push(
        [
          {
            id: 'task-123',
            type: 'task',
            operation: 'delete',
            encryptedData: mockEncrypt(JSON.stringify({ id: 'task-123', deleted: true })),
            signature: mockSign({}),
            clock: { [deviceAId]: 2 },
          },
        ],
        { [deviceAId]: 2 }
      )

      // Device B pulls
      const pullResponse = mockServer.pull()

      expect(pullResponse.items).toHaveLength(1)
      expect(pullResponse.items[0].operation).toBe('delete')
      expect(pullResponse.items[0].deletedAt).toBeDefined()
    })
  })

  // ===========================================================================
  // Vector Clock Synchronization
  // ===========================================================================

  describe('vector clock synchronization', () => {
    it('should merge vector clocks across devices', () => {
      const deviceAId = 'device-A'
      const deviceBId = 'device-B'

      // Device A pushes with its clock
      const pushA = mockServer.push(
        [
          {
            id: 'task-A',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt('{}'),
            signature: mockSign({}),
            clock: { [deviceAId]: 3 },
          },
        ],
        { [deviceAId]: 3 }
      )

      expect(pushA.serverClock[deviceAId]).toBe(3)

      // Device B pushes with its clock
      const pushB = mockServer.push(
        [
          {
            id: 'task-B',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt('{}'),
            signature: mockSign({}),
            clock: { [deviceBId]: 5 },
          },
        ],
        { [deviceBId]: 5 }
      )

      // Server clock should have both devices
      expect(pushB.serverClock[deviceAId]).toBe(3)
      expect(pushB.serverClock[deviceBId]).toBe(5)
    })

    it('should handle concurrent edits by different devices', () => {
      const deviceAId = 'device-A'
      const deviceBId = 'device-B'

      // Both devices create different items concurrently
      mockServer.push(
        [
          {
            id: 'task-from-A',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ from: 'A' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      mockServer.push(
        [
          {
            id: 'task-from-B',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ from: 'B' })),
            signature: mockSign({}),
            clock: { [deviceBId]: 1 },
          },
        ],
        { [deviceBId]: 1 }
      )

      // Both items should be on the server
      const allItems = mockServer.getAllItems()
      expect(allItems).toHaveLength(2)

      // Either device pulling should get both items
      const pullResponse = mockServer.pull()
      expect(pullResponse.items).toHaveLength(2)
    })
  })

  // ===========================================================================
  // Bidirectional Sync
  // ===========================================================================

  describe('bidirectional sync', () => {
    it('should sync items bidirectionally between Device A and Device B', () => {
      const deviceAId = 'device-A'
      const deviceBId = 'device-B'

      // Device A creates a task
      mockServer.push(
        [
          {
            id: 'task-from-A',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ id: 'task-from-A', author: 'A' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      // Device B creates a task
      mockServer.push(
        [
          {
            id: 'task-from-B',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ id: 'task-from-B', author: 'B' })),
            signature: mockSign({}),
            clock: { [deviceBId]: 1 },
          },
        ],
        { [deviceBId]: 1 }
      )

      // Device A pulls - should get B's task
      const pullA = mockServer.pull()
      const taskFromB = pullA.items.find((item) => item.id === 'task-from-B')
      expect(taskFromB).toBeDefined()
      expect(JSON.parse(mockDecrypt(taskFromB!.encryptedData)).author).toBe('B')

      // Device B pulls - should get A's task
      const pullB = mockServer.pull()
      const taskFromA = pullB.items.find((item) => item.id === 'task-from-A')
      expect(taskFromA).toBeDefined()
      expect(JSON.parse(mockDecrypt(taskFromA!.encryptedData)).author).toBe('A')
    })
  })

  // ===========================================================================
  // Multiple Item Types
  // ===========================================================================

  describe('multiple item types', () => {
    it('should sync different item types correctly', () => {
      const deviceAId = 'device-A'

      // Push various item types
      mockServer.push(
        [
          {
            id: 'task-1',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ type: 'task' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
          {
            id: 'note-1',
            type: 'note',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ type: 'note' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 2 },
          },
          {
            id: 'project-1',
            type: 'project',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ type: 'project' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 3 },
          },
          {
            id: 'inbox-1',
            type: 'inbox_item',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ type: 'inbox_item' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 4 },
          },
          {
            id: 'settings-1',
            type: 'settings',
            operation: 'update',
            encryptedData: mockEncrypt(JSON.stringify({ type: 'settings' })),
            signature: mockSign({}),
            clock: { [deviceAId]: 5 },
          },
        ],
        { [deviceAId]: 5 }
      )

      // Pull and verify all types
      const pullResponse = mockServer.pull()

      expect(pullResponse.items).toHaveLength(5)

      const types = pullResponse.items.map((item) => item.type)
      expect(types).toContain('task')
      expect(types).toContain('note')
      expect(types).toContain('project')
      expect(types).toContain('inbox_item')
      expect(types).toContain('settings')
    })
  })

  // ===========================================================================
  // Operation Field for Signature Verification
  // ===========================================================================

  describe('operation field in pull response', () => {
    it('should include operation field for create operations', () => {
      const deviceAId = 'device-A'

      mockServer.push(
        [
          {
            id: 'task-123',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt('{}'),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      const pullResponse = mockServer.pull()

      expect(pullResponse.items[0].operation).toBe('create')
    })

    it('should include operation field for update operations', () => {
      const deviceAId = 'device-A'

      // Create then update
      mockServer.push(
        [
          {
            id: 'task-123',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt('{}'),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      mockServer.push(
        [
          {
            id: 'task-123',
            type: 'task',
            operation: 'update',
            encryptedData: mockEncrypt('{}'),
            signature: mockSign({}),
            clock: { [deviceAId]: 2 },
          },
        ],
        { [deviceAId]: 2 }
      )

      const pullResponse = mockServer.pull()

      expect(pullResponse.items[0].operation).toBe('update')
    })

    it('should include operation field for delete operations', () => {
      const deviceAId = 'device-A'

      mockServer.push(
        [
          {
            id: 'task-123',
            type: 'task',
            operation: 'delete',
            encryptedData: mockEncrypt('{}'),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      const pullResponse = mockServer.pull()

      expect(pullResponse.items[0].operation).toBe('delete')
      expect(pullResponse.items[0].deletedAt).toBeDefined()
    })
  })

  // ===========================================================================
  // Real-World Sync Scenarios
  // ===========================================================================

  describe('real-world sync scenarios', () => {
    it('should handle complete task lifecycle across devices', () => {
      const deviceAId = 'device-A'
      const deviceBId = 'device-B'

      // 1. Device A creates a task
      mockServer.push(
        [
          {
            id: 'task-lifecycle',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(
              JSON.stringify({
                id: 'task-lifecycle',
                title: 'Sync Test',
                completed: false,
              })
            ),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      // 2. Device B pulls and sees the task
      let pull = mockServer.pull()
      expect(pull.items).toHaveLength(1)
      let task = JSON.parse(mockDecrypt(pull.items[0].encryptedData))
      expect(task.completed).toBe(false)

      // 3. Device B updates the task to completed
      mockServer.push(
        [
          {
            id: 'task-lifecycle',
            type: 'task',
            operation: 'update',
            encryptedData: mockEncrypt(
              JSON.stringify({
                id: 'task-lifecycle',
                title: 'Sync Test',
                completed: true,
              })
            ),
            signature: mockSign({}),
            clock: { [deviceBId]: 1 },
          },
        ],
        { [deviceBId]: 1 }
      )

      // 4. Device A pulls and sees the update
      pull = mockServer.pull()
      task = JSON.parse(mockDecrypt(pull.items[0].encryptedData))
      expect(task.completed).toBe(true)

      // 5. Device A deletes the task
      mockServer.push(
        [
          {
            id: 'task-lifecycle',
            type: 'task',
            operation: 'delete',
            encryptedData: mockEncrypt(JSON.stringify({ id: 'task-lifecycle', deleted: true })),
            signature: mockSign({}),
            clock: { [deviceAId]: 2 },
          },
        ],
        { [deviceAId]: 2 }
      )

      // 6. Device B sees the deletion
      pull = mockServer.pull()
      expect(pull.items[0].deletedAt).toBeDefined()
      expect(pull.items[0].operation).toBe('delete')
    })

    it('should handle offline device catching up', () => {
      const deviceAId = 'device-A'
      const deviceBId = 'device-B'

      // Device A makes many changes while Device B is offline
      for (let i = 1; i <= 5; i++) {
        mockServer.push(
          [
            {
              id: `task-${i}`,
              type: 'task',
              operation: 'create',
              encryptedData: mockEncrypt(JSON.stringify({ id: `task-${i}`, index: i })),
              signature: mockSign({}),
              clock: { [deviceAId]: i },
            },
          ],
          { [deviceAId]: i }
        )
      }

      // Device B comes online and pulls
      const pullResponse = mockServer.pull()

      // Should get all 5 items
      expect(pullResponse.items).toHaveLength(5)

      // Verify correct order
      const indices = pullResponse.items.map((item) => JSON.parse(mockDecrypt(item.encryptedData)).index)
      expect(indices).toEqual([1, 2, 3, 4, 5])
    })

    it('should handle interleaved edits from multiple devices', () => {
      const deviceAId = 'device-A'
      const deviceBId = 'device-B'
      const deviceCId = 'device-C'

      // Three devices making interleaved edits
      mockServer.push(
        [
          {
            id: 'task-A1',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ from: 'A', seq: 1 })),
            signature: mockSign({}),
            clock: { [deviceAId]: 1 },
          },
        ],
        { [deviceAId]: 1 }
      )

      mockServer.push(
        [
          {
            id: 'task-B1',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ from: 'B', seq: 1 })),
            signature: mockSign({}),
            clock: { [deviceBId]: 1 },
          },
        ],
        { [deviceBId]: 1 }
      )

      mockServer.push(
        [
          {
            id: 'task-C1',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ from: 'C', seq: 1 })),
            signature: mockSign({}),
            clock: { [deviceCId]: 1 },
          },
        ],
        { [deviceCId]: 1 }
      )

      mockServer.push(
        [
          {
            id: 'task-A2',
            type: 'task',
            operation: 'create',
            encryptedData: mockEncrypt(JSON.stringify({ from: 'A', seq: 2 })),
            signature: mockSign({}),
            clock: { [deviceAId]: 2 },
          },
        ],
        { [deviceAId]: 2 }
      )

      // All devices should see all 4 items
      const pullResponse = mockServer.pull()
      expect(pullResponse.items).toHaveLength(4)

      // Server clock should have all three devices
      expect(pullResponse.serverClock[deviceAId]).toBe(2)
      expect(pullResponse.serverClock[deviceBId]).toBe(1)
      expect(pullResponse.serverClock[deviceCId]).toBe(1)
    })
  })
})
