# Settings & Preferences Specification

Application settings, user preferences, and configuration management.

```
/speckit.specify

Build the settings system that manages user preferences, account settings, and application configuration:

## USER STORIES

### P1 - Critical
1. As a user, I want to change the app theme (light/dark/system)
2. As a user, I want to manage my sync account (devices, sign out)
3. As a user, I want to see my recovery key again if I need it
4. As a user, I want to change my vault location
5. As a user, I want to configure keyboard shortcuts

### P2 - Important
6. As a user, I want to adjust text size and font preferences
7. As a user, I want to configure quick capture global shortcut
8. As a user, I want to enable/disable sync features
9. As a user, I want to manage my tags (rename, delete, merge)
10. As a user, I want to set default project for new tasks

### P3 - Nice to Have
11. As a user, I want to export all my data
12. As a user, I want to import data from other apps
13. As a user, I want to configure AI features (enable/disable, API keys)
14. As a user, I want to set up integrations (calendar, etc.)
15. As a user, I want backup settings (automatic local backup)

## DATA MODEL

### Settings
```typescript
interface AppSettings {
  // Appearance
  theme: "light" | "dark" | "system"
  fontSize: "small" | "medium" | "large"
  fontFamily: "system" | "serif" | "sans-serif" | "mono"
  accentColor: string           // Hex color
  reducedMotion: boolean

  // Editor
  editorWidth: "narrow" | "medium" | "wide"
  spellCheck: boolean
  autoSave: boolean
  autoSaveDelay: number         // Milliseconds
  showWordCount: boolean

  // Tasks
  defaultProjectId: string
  showCompletedTasks: boolean
  taskSortDefault: TaskSort
  weekStartsOn: 0 | 1           // 0 = Sunday, 1 = Monday

  // Inbox
  staleThresholdDays: number
  globalCaptureShortcut: string // e.g., "CommandOrControl+Shift+Space"

  // Sync
  syncEnabled: boolean
  syncOnStartup: boolean
  syncInterval: number          // Minutes (0 = real-time)

  // AI
  aiEnabled: boolean
  aiProvider: "openai" | "local" | "none"
  openaiApiKey?: string         // Stored encrypted in keychain

  // Privacy
  analyticsEnabled: boolean
  crashReportsEnabled: boolean

  // Advanced
  devToolsEnabled: boolean
  showHiddenFiles: boolean

  // Timestamps
  modifiedAt: Date
}
```

### Account
```typescript
interface AccountInfo {
  id: string
  email: string
  authProvider: "google" | "apple" | "github"
  createdAt: Date

  // Sync
  syncEnabled: boolean
  storageUsed: number           // Bytes
  storageLimit: number          // Bytes

  // Devices
  devices: Device[]
  currentDeviceId: string
}

interface Device {
  id: string
  name: string                  // e.g., "John's MacBook Pro"
  platform: "macos" | "windows" | "linux" | "ios" | "android"
  lastSyncAt: Date
  isCurrentDevice: boolean
}
```

### Keyboard Shortcuts
```typescript
interface KeyboardShortcuts {
  // Global
  globalCapture: string

  // Navigation
  search: string                // Default: "CommandOrControl+K"
  newNote: string               // Default: "CommandOrControl+N"
  newTask: string               // Default: "CommandOrControl+Shift+N"
  goToToday: string             // Default: "CommandOrControl+T"

  // Editor
  toggleBold: string
  toggleItalic: string
  toggleHeading: string
  insertLink: string

  // Tab management
  newTab: string
  closeTab: string
  nextTab: string
  previousTab: string

  // View
  toggleSidebar: string
  toggleFocusMode: string

  // Custom
  custom: Record<string, string>
}
```

## FUNCTIONAL REQUIREMENTS

### Settings UI Layout
```
┌─────────────────────────────────────────────────────────────┐
│  Settings                                            [×]    │
├──────────────────┬──────────────────────────────────────────┤
│                  │                                          │
│  General      ● │  Appearance                              │
│  Account        │  ─────────────                           │
│  Sync           │                                          │
│  Editor         │  Theme                                   │
│  Tasks          │  ○ Light  ○ Dark  ● System              │
│  Keyboard       │                                          │
│  AI             │  Accent Color                            │
│  Data           │  [■■■■■■■■■■] Blue                       │
│  Advanced       │                                          │
│                  │  Font Size                               │
│                  │  [──●──────] Medium                      │
│                  │                                          │
│                  │  Reduce Motion                           │
│                  │  [ ] Enable reduced motion               │
│                  │                                          │
└──────────────────┴──────────────────────────────────────────┘
```

### General Settings
- Theme selector (Light/Dark/System)
- Accent color picker
- Font size slider
- Language selector (future)
- Reduced motion toggle

### Account Settings
- Display email and auth provider
- Profile picture (from OAuth provider)
- Account creation date
- Storage usage bar
- Sign out button (with confirmation)

### Sync Settings
- Enable/disable sync toggle
- Sync status display
- Manual sync trigger
- Device list with last sync time
- Remove device (for other devices)
- Regenerate device keys (troubleshooting)
- View/copy recovery key (requires re-authentication)

### Editor Settings
- Editor width (narrow/medium/wide)
- Spell check toggle
- Auto-save toggle and delay
- Word count toggle
- Default font (system/serif/sans/mono)

### Task Settings
- Default project selector
- Show completed tasks by default
- Default sort order
- Week start day (Sunday/Monday)
- Stale inbox threshold

### Keyboard Settings
- List all shortcuts with current keys
- Click to rebind (detect next key press)
- Reset to defaults button
- Conflict detection (warn if already used)
- Global shortcuts section (require special permissions)

### AI Settings
- Enable/disable AI features
- Provider selection (OpenAI/Local/None)
- API key input (stored in keychain)
- Test connection button
- Usage statistics (if OpenAI)

### Data Settings
- Vault location display
- Change vault button
- Export all data (as JSON or folder)
- Import data (from Notion, Obsidian, etc.)
- Clear cache button
- Rebuild search index button

### Advanced Settings
- Developer tools toggle
- Show hidden files toggle
- Verbose logging toggle
- Reset all settings button

## NON-FUNCTIONAL REQUIREMENTS

### Persistence
- Settings stored in data.db (synced)
- Device-specific overrides in localStorage
- Instant apply (no save button needed)
- Graceful defaults for missing values

### Security
- API keys stored in OS keychain, not plain DB
- Recovery key requires re-auth to view
- Device removal requires confirmation

### UX
- Settings modal over current view
- Instant feedback on changes
- Tooltips for complex options
- Grouped logically by category

## ACCEPTANCE CRITERIA

### Appearance
- [ ] Theme change applies immediately
- [ ] System theme follows OS setting
- [ ] Accent color updates UI elements
- [ ] Font size change affects all text

### Account
- [ ] Shows correct email and provider
- [ ] Sign out clears all local data
- [ ] Storage usage bar is accurate
- [ ] Link to upgrade plan (future)

### Sync
- [ ] Toggle sync on/off works
- [ ] Device list shows all linked devices
- [ ] Can remove other devices
- [ ] Recovery key viewable after re-auth
- [ ] Manual sync button triggers sync

### Editor
- [ ] Width setting affects note editor
- [ ] Spell check toggle works
- [ ] Auto-save delay configurable
- [ ] Word count toggle works

### Keyboard Shortcuts
- [ ] All shortcuts listed
- [ ] Click shortcut to rebind
- [ ] Conflict shows warning
- [ ] Reset restores defaults
- [ ] Global shortcut requires permission

### AI
- [ ] Can enable/disable AI features
- [ ] API key input is masked
- [ ] Test connection provides feedback
- [ ] Invalid API key shows error

### Data
- [ ] Export creates downloadable file
- [ ] Import parses common formats
- [ ] Change vault moves data correctly
- [ ] Clear cache frees space

### Advanced
- [ ] Dev tools toggle works
- [ ] Reset settings shows confirmation
- [ ] All settings persist across restart
- [ ] Corrupted settings auto-repair
```
