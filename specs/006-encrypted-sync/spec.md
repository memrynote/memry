# Feature Specification: Encrypted Sync Engine

**Feature Branch**: `006-encrypted-sync`
**Created**: 2025-12-18
**Status**: Draft
**Input**: Build the sync engine that synchronizes encrypted data between devices with end-to-end encryption, offline support, and conflict resolution.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cross-Device Data Synchronization (Priority: P1)

As a user, I want my data synced across desktop and mobile devices so I see the same content everywhere without manual intervention.

**Why this priority**: This is the fundamental value proposition of the sync feature. Without reliable cross-device sync, all other features are meaningless.

**Independent Test**: Can be fully tested by making changes on Device A, then verifying they appear on Device B within the specified timeframe.

**Acceptance Scenarios**:

1. **Given** I have two linked devices (desktop and mobile), **When** I create a note on my desktop, **Then** the note appears on my mobile within 5 seconds
2. **Given** I have edited a task on my mobile, **When** I open the desktop app, **Then** I see the updated task content
3. **Given** I delete a journal entry on one device, **When** I check other devices, **Then** the entry is removed everywhere

---

### User Story 2 - End-to-End Encryption (Priority: P1)

As a user, I want my data encrypted before it leaves my device so that even the server operator cannot read my personal information.

**Why this priority**: Privacy and security are core requirements for a personal knowledge management tool. Users must trust that their private thoughts and tasks are protected.

**Independent Test**: Can be verified by inspecting server-stored data and confirming it is unreadable encrypted blobs.

**Acceptance Scenarios**:

1. **Given** I save a note with sensitive content, **When** the data is transmitted to the server, **Then** the content is encrypted and unreadable without my encryption keys
2. **Given** the server database is accessed directly, **When** examining stored data, **Then** only encrypted blobs are visible with no plaintext content
3. **Given** I set up a new account, **When** completing the setup, **Then** I receive a recovery phrase that I must confirm before proceeding

---

### User Story 3 - Offline Support with Automatic Sync (Priority: P1)

As a user, I want sync to work when I come back online after being offline so I never lose my work regardless of network conditions.

**Why this priority**: Users work in various network conditions. The system must reliably capture all changes made offline and sync them when connectivity is restored.

**Independent Test**: Can be tested by making changes while disconnected, then reconnecting and verifying all changes sync properly.

**Acceptance Scenarios**:

1. **Given** I am offline, **When** I create or edit content, **Then** changes are queued locally and persisted across app restarts
2. **Given** I have offline changes queued, **When** network connectivity is restored, **Then** all queued changes sync automatically
3. **Given** I have been offline for an extended period, **When** I come online, **Then** all accumulated changes sync in order without data loss

---

### User Story 4 - Sync Status Visibility (Priority: P1)

As a user, I want to see sync status clearly (syncing, synced, error, offline) so I always know the state of my data.

**Why this priority**: Users need confidence that their data is safe. Clear status indication reduces anxiety and helps troubleshoot issues.

**Independent Test**: Can be tested by triggering various sync states and verifying the UI reflects them accurately.

**Acceptance Scenarios**:

1. **Given** sync is in progress, **When** I look at the sync indicator, **Then** I see "Syncing..." with items remaining count
2. **Given** sync has completed successfully, **When** I look at the sync indicator, **Then** I see "Synced" with last sync timestamp
3. **Given** a sync error occurs, **When** I look at the sync indicator, **Then** I see an error message with retry option
4. **Given** I am offline with queued changes, **When** I look at the sync indicator, **Then** I see "Offline" with queue count

---

### User Story 5 - Secure Device Linking (Priority: P1)

As a user, I want to link new devices securely so I can access my data on multiple devices without compromising security.

**Why this priority**: Multi-device access is essential for the sync feature to be useful. The linking process must be both secure and user-friendly.

**Independent Test**: Can be tested by linking a new device and verifying it gains access to all synced content.

**Acceptance Scenarios**:

1. **Given** I have an existing device set up, **When** I want to link a new device via QR code, **Then** the existing device shows a QR code that the new device can scan to complete linking
2. **Given** I lost access to all devices, **When** I enter my 24-word recovery phrase on a new device, **Then** I regain access to all my synced data
3. **Given** I enter an incorrect recovery phrase, **When** attempting to restore, **Then** I see a clear error message indicating the phrase is invalid
4. **Given** I have linked a new device, **When** I check device management, **Then** the new device appears in my list of linked devices

---

### User Story 6 - Automatic Conflict Resolution (Priority: P2)

As a user, I want conflicts handled automatically with a backup copy preserved so I don't lose work when editing on multiple devices.

**Why this priority**: Conflicts are inevitable with multi-device editing. Automatic resolution with backups prevents data loss while minimizing user friction.

**Independent Test**: Can be tested by editing the same item on two offline devices, bringing them online, and verifying conflict handling.

**Acceptance Scenarios**:

1. **Given** I edited the same note on two devices while offline, **When** both devices come online, **Then** one version is preserved as current and the other as a conflict copy
2. **Given** a conflict has been resolved, **When** I check my data, **Then** I see a notification about the conflict and can review both versions
3. **Given** I am reviewing a conflict, **When** I make a choice, **Then** I can keep the server version, local version, or merge manually
4. **Given** a conflict copy exists, **When** I resolve it, **Then** the duplicate is removed

---

### User Story 7 - Sync Activity History (Priority: P2)

As a user, I want to see sync activity history so I can understand what has been synced and troubleshoot issues.

**Why this priority**: Transparency into sync operations builds trust and aids debugging when issues occur.

**Independent Test**: Can be tested by performing sync operations and verifying they appear in the history.

**Acceptance Scenarios**:

1. **Given** I navigate to sync settings, **When** I view sync history, **Then** I see a chronological log of recent sync operations
2. **Given** a sync operation completed, **When** I view the history, **Then** I see the operation type, timestamp, and items affected
3. **Given** a sync error occurred, **When** I view the history, **Then** I see the error details and affected items

---

### User Story 8 - Manual Sync Trigger (Priority: P2)

As a user, I want to force sync manually if needed so I can ensure my data is up-to-date on demand.

**Why this priority**: While automatic sync handles most cases, users need the ability to manually trigger sync when they want immediate synchronization.

**Independent Test**: Can be tested by triggering manual sync and verifying pending changes are synchronized.

**Acceptance Scenarios**:

1. **Given** I have pending changes, **When** I trigger manual sync, **Then** all pending changes are synchronized immediately
2. **Given** sync is already in progress, **When** I trigger manual sync, **Then** I see feedback that sync is already running

---

### User Story 9 - Local-Only Items (Priority: P2)

As a user, I want to exclude certain items from sync (local-only notes) so I can keep sensitive content on just one device.

**Why this priority**: Some content may be too sensitive for cloud storage or only relevant to one device.

**Independent Test**: Can be tested by marking an item as local-only and verifying it doesn't appear on other devices.

**Acceptance Scenarios**:

1. **Given** I mark a note as local-only, **When** I sync, **Then** the note is not uploaded to the server
2. **Given** I have a local-only note, **When** I check other devices, **Then** the note does not appear
3. **Given** I have a local-only note, **When** I remove the local-only flag, **Then** the note syncs to other devices

---

### User Story 10 - Background Sync (Priority: P2)

As a user, I want sync to work in the background without blocking my work so I can continue using the app while sync happens.

**Why this priority**: Sync operations should be invisible to the user's workflow. UI freezing during sync creates a poor experience.

**Independent Test**: Can be tested by triggering a large sync operation and verifying the UI remains responsive.

**Acceptance Scenarios**:

1. **Given** sync is in progress, **When** I continue working, **Then** the UI remains responsive
2. **Given** I am editing content, **When** background sync is running, **Then** my edits are not interrupted
3. **Given** a large initial sync is occurring, **When** I use the app, **Then** I can work normally while sync progresses

---

### User Story 11 - Selective Sync (Priority: P3)

As a user, I want selective sync on mobile (choose what to sync) so I can manage storage on devices with limited space.

**Why this priority**: Mobile devices often have storage constraints. Selective sync allows users to prioritize what data they need on mobile.

**Independent Test**: Can be tested by configuring selective sync and verifying only selected content appears on the device.

**Acceptance Scenarios**:

1. **Given** I am on a mobile device, **When** I configure selective sync, **Then** I can choose which categories to sync (notes, tasks, journal, etc.)
2. **Given** I have excluded a category from sync, **When** I check my device, **Then** items in that category are not present

---

### User Story 12 - Data Usage Visibility (Priority: P3)

As a user, I want to see how much data is being used for sync so I can manage storage and bandwidth.

**Why this priority**: Users on limited data plans or storage need visibility into sync resource consumption.

**Independent Test**: Can be tested by viewing data usage statistics in sync settings.

**Acceptance Scenarios**:

1. **Given** I navigate to sync settings, **When** I view data usage, **Then** I see total synced data size and breakdown by category

---

### User Story 13 - Sync Pause for Metered Connections (Priority: P3)

As a user, I want a sync pause option for metered connections so I don't consume mobile data unexpectedly.

**Why this priority**: Users on metered connections need control over when sync uses their data allowance.

**Independent Test**: Can be tested by enabling pause on metered and verifying sync stops on metered connections.

**Acceptance Scenarios**:

1. **Given** I enable "pause sync on metered connections", **When** I am on mobile data, **Then** sync pauses until I return to Wi-Fi or manually override

---

### User Story 14 - Device Removal (Priority: P3)

As a user, I want to remove a device from my account so I can revoke access if a device is lost or sold.

**Why this priority**: Security requires the ability to revoke device access when devices change ownership or are compromised.

**Independent Test**: Can be tested by removing a device and verifying it loses sync access.

**Acceptance Scenarios**:

1. **Given** I have multiple linked devices, **When** I remove a device from my account, **Then** that device can no longer sync
2. **Given** I am removing a device, **When** I confirm removal, **Then** I see a confirmation that the device has been unlinked

---

### Edge Cases

- What happens when the recovery phrase is lost and no devices are accessible? (Account cannot be recovered - this must be clearly communicated during setup)
- How does the system handle sync during app updates or when encryption version changes? (Graceful migration with backwards compatibility)
- What happens if the server is unreachable for an extended period? (Local-only mode with unlimited queue growth until sync resumes)
- How does conflict resolution work for deleted items? (Deletion wins unless there's a newer edit)
- What happens when storage quota is exceeded? (Clear notification with guidance to free space or upgrade)
- How does the system handle corrupted encrypted data? (Skip item, log error, notify user, preserve local version if available)
- What happens when linking a device to an account that already has conflicting data? (Treat as merge with conflict resolution)

## Requirements *(mandatory)*

### Functional Requirements

#### Account & Device Management

- **FR-001**: System MUST allow users to create accounts using OAuth providers (Google, Apple, GitHub)
- **FR-002**: System MUST generate a 24-word recovery phrase during first device setup
- **FR-003**: System MUST require users to confirm their recovery phrase before completing setup
- **FR-004**: System MUST securely store encryption keys in the operating system's secure keychain
- **FR-005**: System MUST support linking additional devices via QR code scanning
- **FR-006**: System MUST support account restoration via recovery phrase entry
- **FR-007**: System MUST display all linked devices with device name, type, and last active date
- **FR-008**: System MUST allow users to remove (unlink) devices from their account
- **FR-009**: System MUST require confirmation before removing a device

#### Data Encryption

- **FR-010**: System MUST encrypt all user content before transmission or storage on the server
- **FR-011**: System MUST use a hierarchical key structure (recovery key to master key to vault key to file keys)
- **FR-012**: System MUST generate unique per-file encryption keys
- **FR-013**: System MUST ensure the server only stores encrypted blobs that are unreadable without user keys
- **FR-014**: System MUST never transmit unencrypted keys over the network
- **FR-015**: System MUST never log encryption keys or include them in error reports

#### Synchronization

- **FR-016**: System MUST detect local changes and queue them for sync
- **FR-017**: System MUST persist the sync queue across app restarts
- **FR-018**: System MUST automatically push queued changes when online
- **FR-019**: System MUST receive and apply changes from other devices automatically
- **FR-020**: System MUST support bidirectional sync (push local changes, pull remote changes)
- **FR-021**: System MUST track version numbers for conflict detection
- **FR-022**: System MUST retry failed sync operations with exponential backoff
- **FR-023**: System MUST allow users to manually trigger sync
- **FR-024**: System MUST perform sync operations in the background without blocking the UI

#### Conflict Resolution

- **FR-025**: System MUST detect when the same item is modified on multiple devices
- **FR-026**: System MUST automatically resolve conflicts by preserving both versions
- **FR-027**: System MUST create a conflict copy of the losing version (e.g., "note.conflict-YYYY-MM-DD.md")
- **FR-028**: System MUST notify users when conflicts are resolved
- **FR-029**: System MUST allow users to review conflicts and choose which version to keep
- **FR-030**: System MUST support merging conflicted versions manually
- **FR-031**: System MUST remove conflict copies after user resolution

#### Sync Scope

- **FR-032**: System MUST sync the following content types: Notes, Journal entries, Tasks, Projects, Inbox items, Attachments, User settings
- **FR-033**: System MUST NOT sync: Local cache/index files, Search indexes, UI state, Temporary files
- **FR-034**: System MUST allow users to mark items as local-only (excluded from sync)
- **FR-035**: System MUST support selective sync to choose categories on storage-limited devices

#### Status & History

- **FR-036**: System MUST display current sync status (idle, syncing, error, offline)
- **FR-037**: System MUST show last successful sync timestamp
- **FR-038**: System MUST display pending queue count when offline
- **FR-039**: System MUST maintain a sync activity history log
- **FR-040**: System MUST display data usage statistics
- **FR-041**: System MUST provide clear error messages with retry options

#### Network & Battery

- **FR-042**: System MUST detect network connectivity changes and respond appropriately
- **FR-043**: System MUST support pausing sync on metered connections
- **FR-044**: System MUST resume sync operations after network recovery
- **FR-045**: System MUST handle network interruptions without data corruption

### Key Entities

- **User Account**: Represents a user's identity, linked to OAuth provider credentials, owns all synced data
- **Device**: A linked client (desktop or mobile) that can sync data, has unique device identifier and keys
- **Encrypted Item**: A single piece of synced content (note, task, etc.) with encrypted payload, version number, and metadata
- **Sync Queue**: Ordered list of pending changes waiting to be pushed to the server
- **Conflict**: Record of a version conflict including both versions and resolution status
- **Recovery Phrase**: User's 24-word backup that can regenerate encryption keys
- **Sync History Entry**: Log record of a sync operation including timestamp, type, and result

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can complete initial device setup and recovery phrase backup in under 5 minutes
- **SC-002**: Single item changes sync between devices in under 2 seconds on standard broadband connection
- **SC-003**: Batch sync of 100 items completes in under 30 seconds
- **SC-004**: Initial full sync of 1000 items completes in under 5 minutes
- **SC-005**: UI remains responsive during sync operations (no freezing or blocking)
- **SC-006**: 99.9% of sync operations complete successfully without user intervention
- **SC-007**: Users can link a new device in under 2 minutes using QR code method
- **SC-008**: Users can restore account access on a new device using recovery phrase in under 3 minutes
- **SC-009**: Conflicts are detected and resolved automatically with 100% data preservation (no data loss)
- **SC-010**: Offline changes queue reliably and sync within 10 seconds of network restoration
- **SC-011**: Zero plaintext user content visible in server storage or logs
- **SC-012**: Users report understanding sync status at least 90% of the time (status is clear)
- **SC-013**: Support tickets related to sync issues remain below 5% of total support volume
- **SC-014**: 95% of users successfully complete device linking on first attempt

## Assumptions

1. **OAuth Provider Availability**: Google, Apple, and GitHub OAuth services are available and reliable
2. **Device Keychain Support**: All target platforms (macOS, Windows, iOS, Android) support secure keychain storage
3. **Server Infrastructure**: A backend server exists or will be built to receive and store encrypted data
4. **Network Conditions**: Users typically have broadband or LTE connectivity; extreme low-bandwidth scenarios are edge cases
5. **Storage Capacity**: Users have sufficient local storage for sync queue and conflict copies
6. **Single User per Account**: Each account is used by one person (no shared accounts with concurrent editing expected)
7. **Platform Capabilities**: Target platforms support background processing and network change detection
8. **Encryption Library Availability**: Cryptographic primitives (AES-256-GCM, Argon2id, HKDF) are available on all platforms

## Out of Scope

1. **Real-time Collaboration**: Simultaneous multi-user editing of the same document is not supported
2. **Version History**: Full version history with rollback capabilities (beyond conflict copies)
3. **Server-Side Search**: Searching encrypted content on the server (search is local-only)
4. **Third-Party Integrations**: Sync with external services like Dropbox, Google Drive, etc.
5. **Account Migration**: Moving data between different user accounts
6. **Team/Organization Features**: Shared vaults or team workspaces
