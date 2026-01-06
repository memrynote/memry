# Vault Architecture

## Overview

The vault system is the foundation of Memry's data layer. A "vault" is a user-selected folder that contains all notes, journals, and app data. This architecture enables:

- **Portability**: Notes are plain markdown files, readable anywhere
- **Sync flexibility**: Users can put vaults in Dropbox, iCloud, Git repos
- **Multi-vault support**: Switch between personal/work vaults
- **Data integrity**: Source of truth is files, database is rebuildable cache

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         RENDERER PROCESS                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌─────────────────┐         ┌──────────────────────┐             │
│   │   useVault()    │────────▶│   vault-service.ts   │             │
│   │   React Hook    │         │   (IPC wrapper)      │             │
│   └─────────────────┘         └──────────┬───────────┘             │
│                                          │                          │
│   ┌─────────────────┐                    │                          │
│   │  useVaultList() │────────────────────┤                          │
│   └─────────────────┘                    │                          │
│                                          ▼                          │
├─────────────────────────────────────────────────────────────────────┤
│                          PRELOAD BRIDGE                             │
│   ┌─────────────────────────────────────────────────────────────┐  │
│   │  window.api.vault.select() / getStatus() / close() / etc.   │  │
│   │  window.api.onVaultStatusChanged(callback)                   │  │
│   └─────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│                          MAIN PROCESS                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌──────────────────┐    ┌─────────────────────────────────────┐  │
│   │  IPC Handlers    │    │         Vault Module                 │  │
│   │  vault-handlers  │───▶│  ┌─────────────┐  ┌──────────────┐  │  │
│   │                  │    │  │  index.ts   │  │   init.ts    │  │  │
│   │  vault:select    │    │  │  (manager)  │  │  (structure) │  │  │
│   │  vault:get-status│    │  └──────┬──────┘  └──────┬───────┘  │  │
│   │  vault:close     │    │         │                │          │  │
│   │  vault:get-all   │    │         ▼                ▼          │  │
│   │  ...             │    │  ┌─────────────────────────────┐    │  │
│   └──────────────────┘    │  │    Vault Folder (.memry/)   │    │  │
│                           │  │  ┌─────────┐ ┌──────────┐   │    │  │
│   ┌──────────────────┐    │  │  │ data.db │ │ index.db │   │    │  │
│   │  electron-store  │◀───│  │  └─────────┘ └──────────┘   │    │  │
│   │  (persistence)   │    │  └─────────────────────────────┘    │  │
│   └──────────────────┘    └─────────────────────────────────────┘  │
│                                                                     │
│   ┌──────────────────┐    ┌─────────────────────────────────────┐  │
│   │  Database Module │    │         Zod Validation              │  │
│   │  - client.ts     │    │         (IPC middleware)            │  │
│   │  - migrate.ts    │    └─────────────────────────────────────┘  │
│   │  - fts.ts        │                                             │
│   └──────────────────┘                                             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Folder Structure

When a user selects a vault folder, Memry creates this structure:

```
MyVault/                          # User-selected folder
├── notes/                        # Default note storage
├── journal/                      # Daily journal entries
├── attachments/
│   ├── images/                   # Image attachments
│   └── files/                    # Other file attachments
└── .memry/                       # Hidden app data folder
    ├── data.db                   # SQLite - source of truth for tasks/projects
    ├── index.db                  # SQLite - rebuildable cache for notes
    └── config.json               # Vault-specific settings
```

### Database Separation

| Database | Purpose | Rebuildable? |
|----------|---------|--------------|
| `data.db` | Tasks, projects, statuses | NO - source of truth |
| `index.db` | Note cache, FTS index, links | YES - rebuilt from files |

## File Locations

### Main Process Files

```
src/main/
├── store.ts                      # electron-store vault persistence
├── index.ts                      # App entry, handler registration
├── vault/
│   ├── index.ts                  # Vault manager (select, open, close)
│   └── init.ts                   # Folder structure creation
├── ipc/
│   ├── index.ts                  # Handler registration pattern
│   ├── vault-handlers.ts         # Vault IPC handlers
│   └── validate.ts               # Zod validation middleware
├── database/
│   ├── client.ts                 # Drizzle ORM client
│   ├── migrate.ts                # Migration runner
│   ├── fts.ts                    # FTS5 setup
│   └── index.ts                  # Exports
└── lib/
    ├── errors.ts                 # Custom error classes
    ├── paths.ts                  # Path utilities
    └── id.ts                     # ID generation
```

### Preload Files

```
src/preload/
├── index.ts                      # API exposure via contextBridge
└── index.d.ts                    # TypeScript declarations
```

### Renderer Files

```
src/renderer/src/
├── services/
│   └── vault-service.ts          # Vault IPC client wrapper
└── hooks/
    └── use-vault.ts              # useVault(), useVaultList() hooks
```

### Shared Files

```
src/shared/
├── contracts/
│   └── vault-api.ts              # Types, schemas, channel definitions
└── db/
    └── schema/                   # Drizzle ORM schemas
```

## IPC Communication Flow

### Request/Response (ipcMain.handle / ipcRenderer.invoke)

```
Renderer                    Preload                     Main
   │                           │                          │
   │  vault.select()           │                          │
   ├──────────────────────────▶│                          │
   │                           │  invoke('vault:select')  │
   │                           ├─────────────────────────▶│
   │                           │                          │ Zod validates
   │                           │                          │ Opens folder picker
   │                           │                          │ Initializes vault
   │                           │   SelectVaultResponse    │
   │                           │◀─────────────────────────┤
   │  { success, vault }       │                          │
   │◀──────────────────────────┤                          │
```

### Events (webContents.send / ipcRenderer.on)

```
Main                        Preload                     Renderer
  │                            │                           │
  │  Status changes            │                           │
  │  send('vault:status-changed', status)                  │
  ├───────────────────────────▶│                           │
  │                            │  onVaultStatusChanged()   │
  │                            ├──────────────────────────▶│
  │                            │                           │ Updates React state
```

## IPC Channels

### Invoke Channels (Request/Response)

| Channel | Input | Output | Description |
|---------|-------|--------|-------------|
| `vault:select` | `{ path?: string }` | `SelectVaultResponse` | Open folder picker or use path |
| `vault:get-status` | none | `VaultStatus` | Get current vault state |
| `vault:get-config` | none | `VaultConfig` | Get vault configuration |
| `vault:update-config` | `Partial<VaultConfig>` | `VaultConfig` | Update configuration |
| `vault:close` | none | `void` | Close current vault |
| `vault:get-all` | none | `GetVaultsResponse` | List all known vaults |
| `vault:switch` | `string` | `SelectVaultResponse` | Switch to different vault |
| `vault:remove` | `string` | `void` | Remove from known list |
| `vault:reindex` | none | `void` | Trigger manual reindex |

### Event Channels (Main → Renderer)

| Channel | Payload | Description |
|---------|---------|-------------|
| `vault:status-changed` | `VaultStatus` | Vault state changed |
| `vault:index-progress` | `number` | Indexing progress (0-100) |
| `vault:error` | `string` | Error occurred |

## Key Types

```typescript
interface VaultInfo {
  path: string           // Absolute path to vault folder
  name: string           // Folder name
  noteCount: number      // Number of markdown files
  taskCount: number      // Number of tasks
  lastOpened: string     // ISO timestamp
  isDefault: boolean     // Is this the default vault?
}

interface VaultStatus {
  isOpen: boolean        // Is a vault currently open?
  path: string | null    // Path to open vault
  isIndexing: boolean    // Is indexing in progress?
  indexProgress: number  // 0-100
  error: string | null   // Current error message
}

interface VaultConfig {
  excludePatterns: string[]    // ['.git', 'node_modules', '.trash']
  defaultNoteFolder: string    // 'notes'
  journalFolder: string        // 'journal'
  attachmentsFolder: string    // 'attachments'
}
```

## Lifecycle

### App Startup

```
1. app.whenReady()
2. registerAllHandlers()           # Register IPC handlers
3. autoOpenLastVault()             # Check electron-store for last vault
   └─▶ If vault exists:
       ├── runMigrations()         # Run pending migrations
       ├── initDatabase()          # Initialize Drizzle client
       └── initializeFts()         # Setup FTS5 tables
4. createWindow()                  # Create browser window
```

### Vault Selection

```
1. User clicks "Select Vault"
2. vault:select IPC called
3. showFolderPicker()              # Native dialog
4. validateVaultPath()             # Check permissions
5. initVault()                     # Create .memry/ structure
6. openVault()
   ├── runMigrations()
   ├── initDatabase()
   └── initializeFts()
7. Store in electron-store
8. Return VaultInfo to renderer
9. Emit status-changed event
```

### App Shutdown

```
1. app 'before-quit' event
2. closeVault()
   └── closeAllDatabases()
```

## Usage Examples

### React Component

```tsx
function VaultSelector() {
  const {
    status,
    isLoading,
    error,
    selectVault,
    closeVault
  } = useVault()

  if (isLoading) return <Spinner />
  if (error) return <ErrorMessage error={error} />

  if (!status?.isOpen) {
    return (
      <button onClick={() => selectVault()}>
        Select Vault
      </button>
    )
  }

  return (
    <div>
      <p>Current vault: {status.path}</p>
      <button onClick={closeVault}>Close</button>
    </div>
  )
}
```

### Vault List

```tsx
function VaultSwitcher() {
  const { vaults, currentVault, removeVault } = useVaultList()
  const { switchVault } = useVault()

  return (
    <ul>
      {vaults.map(vault => (
        <li key={vault.path}>
          {vault.name}
          {vault.path === currentVault && ' (current)'}
          <button onClick={() => switchVault(vault.path)}>
            Switch
          </button>
          <button onClick={() => removeVault(vault.path)}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  )
}
```

## Error Handling

Custom error classes in `src/main/lib/errors.ts`:

```typescript
// Vault-specific errors
throw new VaultError('No write permission', VaultErrorCode.PERMISSION_DENIED)
throw new VaultError('Vault not found', VaultErrorCode.NOT_FOUND)

// Type guards
if (isVaultError(error)) {
  console.log(error.code)  // VaultErrorCode enum value
}
```

## Configuration

### electron-store Schema

```typescript
interface StoreSchema {
  currentVault: string | null     // Path to current vault
  vaults: StoredVaultInfo[]       // List of known vaults
}
```

### Vault Config (config.json)

```json
{
  "excludePatterns": [".git", "node_modules", ".trash"],
  "defaultNoteFolder": "notes",
  "journalFolder": "journal",
  "attachmentsFolder": "attachments"
}
```

## Testing Considerations

1. **Mock electron-store** for unit tests
2. **Use temp directories** for vault integration tests
3. **Mock dialog.showOpenDialog** for automated testing
4. **Test IPC handlers** independently of UI
