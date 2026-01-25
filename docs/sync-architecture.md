# Sync Architecture

This document describes the online/offline synchronization system in Memry.

## Supported Sync Item Types

| Type | Status | Description |
|------|--------|-------------|
| `task` | ✅ Implemented | Tasks in task management |
| `inbox` | ✅ Implemented | Quick capture inbox items |
| `filter` | ✅ Implemented | Saved filters for task views |
| `note` | 🔄 Planned | Notes (uses CRDT with Yjs) |
| `journal` | 🔄 Planned | Journal entries |
| `project` | 🔄 Planned | Project groupings |
| `settings` | 🔄 Planned | User settings (field-level clocks) |
| `attachment` | 🔄 Planned | File attachments |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              RENDERER PROCESS                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │   Task UI   │  │  Inbox UI   │  │ Filter UI   │  │  Sync Status UI │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘ │
│         │                │                │                   │          │
│         └────────────────┴────────────────┴───────────────────┘          │
│                                    │                                      │
│                              IPC Bridge                                   │
└────────────────────────────────────┼─────────────────────────────────────┘
                                     │
┌────────────────────────────────────┼─────────────────────────────────────┐
│                              MAIN PROCESS                                 │
│                                    ▼                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                         IPC HANDLERS                                 │ │
│  │  ┌─────────────────────┐     ┌────────────────────────────────────┐ │ │
│  │  │   auth-handlers.ts  │     │         sync-handlers.ts           │ │ │
│  │  │  - REQUEST_OTP      │     │  - GET_SYNC_STATUS                 │ │ │
│  │  │  - VERIFY_OTP       │     │  - TRIGGER_SYNC                    │ │ │
│  │  │  - START_OAUTH      │     │  - PAUSE_SYNC / RESUME_SYNC        │ │ │
│  │  │  - GET_SESSION      │     │  - SETUP_FIRST_DEVICE              │ │ │
│  │  │  - LOGOUT           │     │  - REGISTER_EXISTING_DEVICE        │ │ │
│  │  └──────────┬──────────┘     └─────────────────┬──────────────────┘ │ │
│  └─────────────┼──────────────────────────────────┼─────────────────────┘ │
│                │                                  │                       │
│                ▼                                  ▼                       │
│  ┌─────────────────────────┐     ┌─────────────────────────────────────┐ │
│  │      auth-bridge.ts     │────▶│          orchestrator.ts            │ │
│  │  - handleSessionChanged │     │  - initSyncSubsystem()              │ │
│  │  - handleSessionExpired │     │  - canSync()                        │ │
│  │  - triggerPostSetupSync │     │  - runSync(reason, forcePull)       │ │
│  └─────────────────────────┘     │  - scheduleAutoSync()               │ │
│                                  └──────────────────┬──────────────────┘ │
│                                                     │                     │
│                ┌────────────────────────────────────┼────────────────┐   │
│                │                                    │                │   │
│                ▼                                    ▼                ▼   │
│  ┌─────────────────────┐  ┌─────────────────────────────┐  ┌───────────┐│
│  │      queue.ts       │  │         engine.ts           │  │network.ts ││
│  │  - add()            │  │  - sync()                   │  │- isOnline ││
│  │  - remove()         │  │  - push()                   │  │- start()  ││
│  │  - peek()           │  │  - pull()                   │  │- stop()   ││
│  │  - getAll()         │  │  - encryptItem()            │  └───────────┘│
│  └──────────┬──────────┘  │  - decryptItem()            │               │
│             │             │  - signItem()               │               │
│             │             └─────────────┬───────────────┘               │
│             │                           │                               │
│             │                           ▼                               │
│             │             ┌─────────────────────────────┐               │
│             │             │       api-client.ts         │               │
│             │             │  - pushItems()              │               │
│             │             │  - pullItems()              │               │
│             │             │  - registerDevice()         │               │
│             │             └─────────────┬───────────────┘               │
│             │                           │                               │
│             ▼                           ▼                               │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                         LOCAL SQLite DATABASE                        ││
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐ ││
│  │  │ sync_queue  │ │ sync_state  │ │sync_history │ │    devices      │ ││
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────┘ ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │      SYNC SERVER        │
                        │  - POST /sync/push      │
                        │  - GET  /sync/pull      │
                        │  - WebSocket /sync/ws   │
                        └─────────────────────────┘
```

---

## Sync Flow Diagrams

### 1. Initialization Flow (App Startup)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        initSyncSubsystem()                          │
│                     orchestrator.ts:initSyncSubsystem()             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐
│  initSyncQueue  │  │ initSyncEngine  │  │ getNetworkMonitor()     │
│  queue.ts       │  │ engine.ts       │  │ .start()                │
│                 │  │                 │  │ network.ts              │
└────────┬────────┘  └────────┬────────┘  └────────────┬────────────┘
         │                    │                        │
         │                    │                        │
         ▼                    ▼                        ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐
│ Load queue from │  │ Load engine     │  │ Poll network every 30s  │
│ sync_queue      │  │ state from      │  │ Emit: sync:online       │
│ table           │  │ sync_state      │  │       sync:offline      │
└─────────────────┘  └─────────────────┘  └─────────────────────────┘
                               │
                               ▼
         ┌─────────────────────────────────────────────┐
         │           Setup Event Listeners             │
         │  - Queue changes → scheduleAutoSync()       │
         │  - Auth bridge → handleSessionChanged()     │
         └──────────────────────┬──────────────────────┘
                                │
                                ▼
         ┌─────────────────────────────────────────────┐
         │         runSync('startup', true)            │
         │         Force pull on startup               │
         └──────────────────────┬──────────────────────┘
                                │
                                ▼
         ┌─────────────────────────────────────────────┐
         │           bootstrapSyncData()               │
         │     (First run only - queues all local      │
         │      items for initial sync)                │
         │           bootstrap.ts                      │
         └─────────────────────────────────────────────┘
```

### 2. Online Sync Flow (Push + Pull)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        engine.ts: sync()                                 │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
            ┌──────────────────────┴──────────────────────┐
            │                                             │
            ▼                                             ▼
┌───────────────────────────────────┐     ┌───────────────────────────────┐
│          PUSH PHASE               │     │          PULL PHASE           │
│         engine.ts:push()          │     │         engine.ts:pull()      │
└───────────────┬───────────────────┘     └───────────────┬───────────────┘
                │                                         │
                ▼                                         ▼
┌───────────────────────────────────┐     ┌───────────────────────────────┐
│ 1. Check sync eligibility:        │     │ 1. Check sync eligibility:    │
│    - Online?                      │     │    - Online?                  │
│    - Not already syncing?         │     │    - Not already syncing?     │
│    - Auth valid?                  │     │                               │
│    - Key material present?        │     │                               │
└───────────────┬───────────────────┘     └───────────────┬───────────────┘
                │                                         │
                ▼                                         ▼
┌───────────────────────────────────┐     ┌───────────────────────────────┐
│ 2. Batch queue items              │     │ 2. Loop until cursor exhausted│
│    MAX_BATCH_SIZE = 100           │     │    GET /sync/pull?cursor=N    │
└───────────────┬───────────────────┘     └───────────────┬───────────────┘
                │                                         │
                ▼                                         ▼
┌───────────────────────────────────┐     ┌───────────────────────────────┐
│ 3. For each item:                 │     │ 3. For each received item:    │
│    ┌─────────────────────────┐    │     │    ┌─────────────────────────┐│
│    │ Parse payload           │    │     │    │ Get signer's public key ││
│    │ Encrypt with vault key  │    │     │    │ Verify Ed25519 signature││
│    │ Sign with device keypair│    │     │    │ Decrypt with vault key  ││
│    │ Include vector clock    │    │     │    │ Emit sync:item-decrypted││
│    └─────────────────────────┘    │     │    │ Upsert to local DB      ││
└───────────────┬───────────────────┘     │    └─────────────────────────┘│
                │                         └───────────────┬───────────────┘
                ▼                                         │
┌───────────────────────────────────┐                     │
│ 4. POST /sync/push                │                     │
│    Handle response:               │                     │
│    - Accepted → remove from queue │                     │
│    - Rejected → update attempts   │                     │
│    - Conflicts → emit event       │                     │
└───────────────┬───────────────────┘                     │
                │                                         │
                ▼                                         ▼
┌───────────────────────────────────┐     ┌───────────────────────────────┐
│ 5. Update server cursor           │     │ 4. Update server cursor       │
│    Log sync history               │     │    Log sync history           │
└───────────────────────────────────┘     └───────────────────────────────┘
```

### 3. Offline Sync Flow (Queue-Based)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OFFLINE STATE                                    │
│                    (Network unavailable)                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      LOCAL CHANGE OCCURS                                 │
│              (User creates/updates/deletes item)                         │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         queue.ts:add()                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Queue Item Schema:                                                  ││
│  │  {                                                                   ││
│  │    id: UUID,                                                         ││
│  │    type: 'task' | 'inbox' | 'filter',                               ││
│  │    itemId: string,                                                   ││
│  │    operation: 'create' | 'update' | 'delete',                       ││
│  │    payload: JSON (includes vector clock),                            ││
│  │    priority: number (higher = first),                                ││
│  │    attempts: 0,                                                      ││
│  │    createdAt: ISO timestamp                                          ││
│  │  }                                                                   ││
│  └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Persisted to sync_queue table                         │
│                    (Survives app restart)                                │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               │ ... time passes (offline) ...
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    NETWORK COMES ONLINE                                  │
│                    network.ts detects change                             │
│                    Emits: sync:online                                    │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    orchestrator.ts:scheduleAutoSync()                    │
│                    Debounce: 1500ms                                      │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    runSync('network-restored')                           │
│                    Processes entire queue                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4. Authentication Flow → Sync Trigger

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER LOGIN                                       │
│                   (OTP or OAuth Flow)                                    │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
         ┌─────────────────────┴─────────────────────┐
         │                                           │
         ▼                                           ▼
┌─────────────────────────┐             ┌─────────────────────────────────┐
│    OTP FLOW             │             │         OAUTH FLOW              │
│ auth-handlers.ts        │             │      auth-handlers.ts           │
│                         │             │                                 │
│ 1. REQUEST_OTP          │             │ 1. START_OAUTH                  │
│    → Send email         │             │    → Open browser               │
│                         │             │                                 │
│ 2. VERIFY_OTP           │             │ 2. Callback received            │
│    → Validate code      │             │    → Exchange code              │
└───────────┬─────────────┘             └───────────────┬─────────────────┘
            │                                           │
            └─────────────────┬─────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Store Auth Tokens & Device ID                         │
│                    Emit: SESSION_CHANGED                                 │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              auth-bridge.ts:handleSessionChanged()                       │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ 1. Check for user change (detect account switch)                    ││
│  │ 2. If different user → clearForUserChange() (clear queue)           ││
│  │ 3. Call queueLocalChangesSinceLastSync()                            ││
│  │ 4. Trigger sync                                                      ││
│  └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              local-changes.ts:queueLocalChangesSinceLastSync()           │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ 1. Check device keypair exists                                       ││
│  │ 2. Get lastSyncAt timestamp                                          ││
│  │ 3. Scan for items:                                                   ││
│  │    - Missing vector clocks (never synced)                            ││
│  │    - Modified after last sync                                        ││
│  │ 4. For each item:                                                    ││
│  │    - Generate vector clock with device ID                            ││
│  │    - Queue as 'create' or 'update'                                   ││
│  └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         runSync('post-auth')                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5. WebSocket Real-Time Notifications

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       websocket.ts:WebSocketManager                      │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CONNECT                                          │
│  URL: wss://[sync-server]/sync/ws                                        │
│  Headers: { Authorization: Bearer <token> }                              │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
         ┌─────────────────────┴─────────────────────┐
         │                                           │
         ▼                                           ▼
┌─────────────────────────┐             ┌─────────────────────────────────┐
│   KEEP-ALIVE LOOP       │             │      MESSAGE HANDLERS           │
│   ─────────────────     │             │      ─────────────────          │
│   Ping every 30s        │             │                                 │
│   Timeout: 10s          │             │  'sync' message → trigger pull  │
│   No pong = disconnect  │             │  'ping'/'pong' → keep alive     │
└─────────────────────────┘             │  'notification' → emit event    │
                                        │  'error' → handle error         │
                                        └─────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      RECONNECTION STRATEGY                               │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Exponential backoff with jitter                                     ││
│  │  Max retries: 5                                                      ││
│  │  Base delay: 1s                                                      ││
│  │  Max delay: 30s                                                      ││
│  │                                                                      ││
│  │  States: 'disconnected' → 'connecting' → 'connected'                 ││
│  │          'connected' → 'reconnecting' → 'connecting'                 ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Vector Clocks & Conflict Resolution

### Vector Clock Structure

```
{
  "device_abc123": 5,    // Device A has made 5 updates
  "device_def456": 3     // Device B has made 3 updates
}
```

### Clock Operations

| Function | Location | Purpose |
|----------|----------|---------|
| `incrementClock(clock, deviceId)` | crypto.ts | Add 1 to device's counter |
| `compareClock(a, b)` | crypto.ts | Determine causality relationship |
| `clockDominates(a, b)` | crypto.ts | Check if clock A supersedes B |
| `mergeClock(a, b)` | crypto.ts | Combine for LWW resolution |

### Conflict Detection

```
┌───────────────────┐         ┌───────────────────┐
│     Device A      │         │     Device B      │
│  Clock: {A:5}     │         │  Clock: {B:3}     │
└─────────┬─────────┘         └─────────┬─────────┘
          │                             │
          │    Both edit same item      │
          │         offline             │
          ▼                             ▼
┌───────────────────┐         ┌───────────────────┐
│  Clock: {A:6}     │         │  Clock: {B:4}     │
│  Queued for push  │         │  Queued for push  │
└─────────┬─────────┘         └─────────┬─────────┘
          │                             │
          │     Both come online        │
          │                             │
          ▼                             ▼
┌─────────────────────────────────────────────────┐
│                   SERVER                         │
│  Detects: Neither clock dominates the other     │
│  Returns: conflict in PushSyncResponse          │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│           sync:conflict-detected event           │
│  Resolution strategies:                          │
│  - 'local': Keep local version                  │
│  - 'remote': Accept server version              │
│  - 'newest': Use timestamp comparison           │
└─────────────────────────────────────────────────┘
```

---

## File Reference

| Component | File | Key Functions |
|-----------|------|---------------|
| **Orchestrator** | `src/main/sync/orchestrator.ts` | `initSyncSubsystem()`, `canSync()`, `runSync()`, `scheduleAutoSync()` |
| **Queue** | `src/main/sync/queue.ts` | `add()`, `remove()`, `peek()`, `getAll()`, `clear()` |
| **Engine** | `src/main/sync/engine.ts` | `sync()`, `push()`, `pull()`, `encryptItem()`, `decryptItem()` |
| **Auth Bridge** | `src/main/sync/auth-bridge.ts` | `handleSessionChanged()`, `handleSessionExpired()`, `triggerPostSetupSync()` |
| **Local Changes** | `src/main/sync/local-changes.ts` | `queueLocalChangesSinceLastSync()` |
| **Network** | `src/main/sync/network.ts` | `start()`, `stop()`, `isOnline()` |
| **WebSocket** | `src/main/sync/websocket.ts` | `connect()`, `disconnect()`, message handlers |
| **Retry** | `src/main/sync/retry.ts` | `withRetry()`, `isRetryableError()` |
| **Bootstrap** | `src/main/sync/bootstrap.ts` | `bootstrapSyncData()` |
| **API Client** | `src/main/sync/api-client.ts` | `pushItems()`, `pullItems()`, `registerDevice()` |
| **Sync Handlers** | `src/main/ipc/sync-handlers.ts` | IPC handlers for renderer communication |
| **Auth Handlers** | `src/main/ipc/auth-handlers.ts` | OTP, OAuth, session management |
| **Schema** | `src/shared/db/schema/sync-schema.ts` | Database tables: `sync_queue`, `sync_state`, `sync_history`, `devices` |
| **Contracts** | `src/shared/contracts/sync-api.ts` | Type definitions for sync items and operations |

---

## Sync Status States

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│   idle   │◄────│ syncing  │────►│  error   │
└────┬─────┘     └──────────┘     └────┬─────┘
     │                                  │
     │         ┌──────────┐            │
     └────────►│  paused  │◄───────────┘
               └──────────┘
                    │
               ┌────┴────┐
               ▼         ▼
          ┌──────────┐   User
          │ offline  │   resumes
          └──────────┘
```

| State | Description |
|-------|-------------|
| `idle` | Not syncing, ready for operations |
| `syncing` | Push/pull in progress |
| `offline` | No network connection |
| `error` | Sync failed (will retry) |
| `paused` | User paused sync |

---

## Security & Encryption

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ENCRYPTION FLOW                                  │
└─────────────────────────────────────────────────────────────────────────┘

   Local Item                                           Encrypted Item
┌─────────────┐                                      ┌─────────────────┐
│ {           │                                      │ {               │
│   id: "...",│     ┌─────────────────────────┐      │   ciphertext:   │
│   title:... │────►│ Encrypt with Vault Key  │─────►│   "encrypted",  │
│   data: ... │     │ (AES-256-GCM)           │      │   signature:    │
│ }           │     └─────────────────────────┘      │   "ed25519...", │
└─────────────┘               │                      │   deviceId:     │
                              │                      │   "abc123"      │
                              ▼                      │ }               │
                    ┌─────────────────────────┐      └─────────────────┘
                    │ Sign with Device Key    │
                    │ (Ed25519)               │
                    └─────────────────────────┘

Key Material (stored in system keychain):
  - Master Key: Derived from recovery phrase (BIP39)
  - Vault Key: For item encryption
  - Device Signing Keypair: For authentication
```

---

## Constants & Configuration

| Constant | Value | Location |
|----------|-------|----------|
| `AUTO_SYNC_DEBOUNCE_MS` | 1500 | orchestrator.ts |
| `MAX_BATCH_SIZE` | 100 | engine.ts |
| `PING_INTERVAL` | 30000 | websocket.ts |
| `PING_TIMEOUT` | 10000 | websocket.ts |
| `MAX_RETRIES` | 5 | retry.ts |
| `BASE_DELAY` | 1000 | retry.ts |
| `MAX_DELAY` | 30000 | retry.ts |
| `NETWORK_CHECK_INTERVAL` | 30000 | network.ts |
