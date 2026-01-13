# Feature Specification: Sync Engine & End-to-End Encryption

**Feature Branch**: `001-sync-e2ee`
**Created**: 2026-01-14
**Status**: Draft
**Input**: User description: "Sync Engine and E2E Encryption for cross-device synchronization with CRDT-based conflict-free merging and collaboration support"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - First Device Setup (Priority: P1)

As a new user, I want to set up my account on my first device so that I can start using the app and have my data securely encrypted from the beginning.

**Why this priority**: This is the foundational user journey - without account setup, no other features can work. Users must be able to create their account and establish their encryption keys before any synchronization can occur.

**Independent Test**: Can be fully tested by creating a new account, confirming the recovery phrase, and verifying that local data is encrypted and ready for sync.

**Acceptance Scenarios**:

1. **Given** I am a new user, **When** I sign up with OAuth (Google/Apple/GitHub), **Then** I am prompted with a 24-word recovery phrase that I must confirm
2. **Given** I have confirmed my recovery phrase, **When** setup completes, **Then** my master key is securely stored in the OS keychain and never exposed
3. **Given** setup is complete, **When** I create my first note or task, **Then** the content is encrypted before any network transmission
4. **Given** I am on the recovery phrase screen, **When** I try to proceed without confirming all words, **Then** I cannot continue until confirmation is complete

---

### User Story 2 - Cross-Device Sync (Priority: P1)

As a user with multiple devices, I want my notes, tasks, and attachments to sync automatically so that I see the same content everywhere.

**Why this priority**: Core value proposition - users expect their data to be available across all their devices. This is fundamental to a modern productivity app.

**Independent Test**: Can be fully tested by creating content on Device A and verifying it appears on Device B within expected timeframes.

**Acceptance Scenarios**:

1. **Given** I have two linked devices, **When** I create a note on Device A, **Then** the note appears on Device B within 5 seconds (on good connection)
2. **Given** I am offline on Device A, **When** I edit a task, **Then** the change is queued and syncs when I come back online
3. **Given** I delete a note on Device A, **When** sync completes, **Then** the note is deleted on Device B
4. **Given** I upload a 50MB PDF attachment, **When** sync completes, **Then** the attachment is available on all my devices with progress indication during transfer

---

### User Story 3 - Device Linking via QR Code (Priority: P1)

As an existing user, I want to securely link a new device to my account by scanning a QR code so that I can access my encrypted data on that device.

**Why this priority**: Users need a secure, user-friendly way to add new devices without exposing their encryption keys. QR code linking is the recommended method.

**Independent Test**: Can be fully tested by generating a QR code on existing device, scanning on new device, approving the link, and verifying all data syncs.

**Acceptance Scenarios**:

1. **Given** I am on my existing device, **When** I go to Settings > Devices > Link New Device, **Then** a QR code is displayed with a 5-minute expiration timer
2. **Given** I have the QR code displayed, **When** I scan it with my new device after signing in with OAuth, **Then** I see "Waiting for approval" on the new device
3. **Given** a linking request is pending, **When** I approve on my existing device, **Then** my new device receives the encrypted master key and begins syncing
4. **Given** a QR code has expired, **When** I try to scan it, **Then** I see a clear error message that the QR code is expired

---

### User Story 4 - Device Linking via Recovery Phrase (Priority: P2)

As a user who has lost access to all my devices, I want to restore my account using my recovery phrase so that I can regain access to my encrypted data.

**Why this priority**: Critical safety net for users who lose all their devices. Less common than QR linking but essential for account recovery.

**Independent Test**: Can be fully tested by entering a valid 24-word recovery phrase and verifying data restoration.

**Acceptance Scenarios**:

1. **Given** I am on a new device, **When** I choose "Restore from recovery phrase" and enter my 24 words correctly, **Then** my account is restored and sync begins
2. **Given** I enter an incorrect recovery phrase, **When** I submit, **Then** I see a clear error that the phrase is invalid
3. **Given** my recovery phrase is correct, **When** restoration completes, **Then** all my notes, tasks, and attachments are available

---

### User Story 5 - Automatic Conflict Resolution for Notes (Priority: P1)

As a user who edits notes on multiple devices, I want my changes to merge automatically without losing any work so that I never have conflicts to resolve manually.

**Why this priority**: Users expect modern apps to handle concurrent edits gracefully. CRDT-based merging eliminates manual conflict resolution entirely for rich text content.

**Independent Test**: Can be fully tested by editing the same note on two offline devices, then bringing both online and verifying all changes are merged.

**Acceptance Scenarios**:

1. **Given** I edit paragraph 1 of a note on Device A offline, **When** I simultaneously edit paragraph 2 on Device B offline, **Then** both edits are preserved when devices sync
2. **Given** I edit the same sentence on two devices, **When** sync occurs, **Then** both versions of the text are merged (character-level merge)
3. **Given** I add tags to a note on Device A, **When** I add different tags on Device B, **Then** all tags are preserved after sync

---

### User Story 6 - Task Sync with Field-Level Merge (Priority: P2)

As a user who manages tasks across devices, I want task changes to sync with intelligent field-level merging so that I don't lose updates.

**Why this priority**: Tasks have structured data (title, status, priority, due date) that benefits from field-level conflict resolution rather than document-level.

**Independent Test**: Can be fully tested by changing different fields of the same task on two devices and verifying all field changes are preserved.

**Acceptance Scenarios**:

1. **Given** I change a task's status on Device A, **When** I change its due date on Device B, **Then** both changes are preserved after sync
2. **Given** I change a task's title on both devices offline, **When** sync occurs, **Then** the most recent change wins for that specific field
3. **Given** I complete a task on Device A, **When** Device B syncs, **Then** the task shows as completed on Device B

---

### User Story 7 - Binary File Attachments (Priority: P2)

As a user, I want to attach PDFs, images, videos, and other files to my notes so that I can keep all related content together.

**Why this priority**: Attachments are essential for a knowledge management app, but core text sync takes precedence.

**Independent Test**: Can be fully tested by attaching a file, verifying upload progress, and downloading on another device.

**Acceptance Scenarios**:

1. **Given** I attach a 50MB PDF to a note, **When** I view the note on another device, **Then** I see a thumbnail preview and can download the full file
2. **Given** I am uploading a large video, **When** the upload is interrupted, **Then** I can resume from where it left off
3. **Given** I attach the same file to multiple notes, **When** sync occurs, **Then** the file is stored only once (deduplication)
4. **Given** I am on a slow connection, **When** I view an attachment, **Then** I see download progress with percentage

---

### User Story 8 - Sync Status Visibility (Priority: P2)

As a user, I want to see clear sync status indicators so that I know when my data is up to date.

**Why this priority**: Users need confidence that their data is being synced. Visual feedback prevents anxiety about data loss.

**Independent Test**: Can be fully tested by observing status indicators during various sync states (idle, syncing, offline, error).

**Acceptance Scenarios**:

1. **Given** all my data is synced, **When** I look at the sync indicator, **Then** I see "Synced" with the time of last sync
2. **Given** sync is in progress, **When** I look at the indicator, **Then** I see "Syncing..." with an item count
3. **Given** I am offline, **When** I look at the indicator, **Then** I see "Offline" with the number of pending changes
4. **Given** sync has failed, **When** I look at the indicator, **Then** I see an error message with a retry option

---

### User Story 9 - Key Rotation (Priority: P3)

As a security-conscious user, I want to rotate my encryption keys periodically so that my data remains protected even if an old key is compromised.

**Why this priority**: Security best practice but not required for basic functionality. Most users will never need this.

**Independent Test**: Can be fully tested by initiating key rotation and verifying new recovery phrase is generated and all data remains accessible.

**Acceptance Scenarios**:

1. **Given** I want to rotate my keys, **When** I initiate key rotation, **Then** I receive a new 24-word recovery phrase
2. **Given** key rotation is complete, **When** I access my data, **Then** all notes, tasks, and attachments remain accessible
3. **Given** key rotation has started, **When** I view progress, **Then** I see how many items have been re-encrypted

---

### User Story 10 - Note Sharing (Priority: P3)

As a user, I want to share specific notes with collaborators so that we can work together while maintaining end-to-end encryption.

**Why this priority**: Future feature that builds on the CRDT foundation. Lower priority than core sync functionality.

**Independent Test**: Can be fully tested by sharing a note, having the recipient accept, and verifying both users can edit with real-time sync.

**Acceptance Scenarios**:

1. **Given** I want to share a note, **When** I invite another user, **Then** they receive an invitation to access the note
2. **Given** I am invited to a shared note, **When** I accept, **Then** I can view and edit the note (based on my permission level)
3. **Given** I shared a note with write access, **When** the collaborator edits, **Then** I see their changes in real-time
4. **Given** I want to revoke access, **When** I remove a collaborator, **Then** they can no longer access the note

---

### Edge Cases

- What happens when a user tries to sync with an outdated app version?
- How does the system handle corrupt data or failed decryption?
- What happens when a device is removed from the account while it has unsynced changes?
- How does the system handle attachments that exceed storage quotas?
- What happens if two devices try to link at the exact same time?
- How does the system behave when the server is unavailable for extended periods?
- What happens when network disconnects mid-upload of a large attachment?
- How does the system handle time zone differences across devices?

## Requirements *(mandatory)*

### Functional Requirements

**First Device Setup**
- **FR-001**: System MUST support OAuth signup via Google, Apple, and GitHub
- **FR-002**: System MUST generate a 24-word BIP39 recovery phrase during first device setup
- **FR-003**: System MUST require user confirmation of recovery phrase before proceeding
- **FR-004**: System MUST derive the master encryption key from the recovery phrase (not generate separately)
- **FR-005**: System MUST store the master key in the OS keychain, never in plain storage
- **FR-006**: System MUST never store the recovery phrase after initial setup confirmation

**Device Linking**
- **FR-007**: System MUST support device linking via QR code with ephemeral key exchange
- **FR-008**: System MUST expire QR codes after 5 minutes
- **FR-009**: System MUST require approval from existing device before completing QR-based linking
- **FR-010**: System MUST support device linking via recovery phrase as backup method
- **FR-011**: System MUST display linked devices in settings with option to remove

**Data Encryption**
- **FR-012**: System MUST encrypt all user content before transmission or storage
- **FR-013**: System MUST use per-item file keys encrypted with the vault key
- **FR-014**: System MUST sign all encrypted items for authenticity verification
- **FR-015**: System MUST reject items with invalid signatures
- **FR-016**: Server MUST only store encrypted blobs with no ability to decrypt

**Sync Protocol**
- **FR-017**: System MUST sync changes automatically when online
- **FR-018**: System MUST queue changes when offline and sync when connection restored
- **FR-019**: System MUST persist sync queue across app restarts
- **FR-020**: System MUST retry failed syncs with exponential backoff (max 60 seconds)
- **FR-021**: System MUST support real-time sync via persistent connection

**Conflict Resolution**
- **FR-022**: System MUST use CRDT-based merging for notes (no manual conflict resolution)
- **FR-023**: System MUST use vector clocks with field-level last-writer-wins for tasks and projects
- **FR-024**: System MUST preserve all edits during concurrent offline editing

**Binary Attachments**
- **FR-025**: System MUST support attachments up to 500MB
- **FR-026**: System MUST split large files into chunks for upload/download
- **FR-027**: System MUST support resumable uploads for interrupted transfers
- **FR-028**: System MUST deduplicate identical file chunks across the user's vault
- **FR-029**: System MUST generate thumbnails for images, PDFs, and videos
- **FR-030**: System MUST support streaming playback for video attachments

**Sync Status**
- **FR-031**: System MUST display current sync status (idle, syncing, offline, error)
- **FR-032**: System MUST show item count during active sync
- **FR-033**: System MUST show pending change count when offline
- **FR-034**: System MUST provide manual retry option for failed syncs

**Key Management**
- **FR-035**: System MUST support key rotation with new recovery phrase generation
- **FR-036**: System MUST re-encrypt file keys (not content) during key rotation

**Collaboration (Future)**
- **FR-037**: System MUST support sharing individual notes with other users
- **FR-038**: System MUST support read and write permission levels for shared notes
- **FR-039**: System MUST encrypt shared file keys for recipient's public key
- **FR-040**: System MUST support real-time presence (cursors) for collaborators

### Key Entities

- **User Account**: Represents a user identity linked to OAuth provider, owns a vault and recovery capability
- **Device**: A client device linked to a user account, has unique device ID and authentication keys
- **Vault**: Container for all user's encrypted content, protected by vault key derived from master key
- **Note**: Rich text document with metadata, tags, and properties - synced as CRDT
- **Task**: Structured item with title, status, priority, dates, and project association - synced with vector clocks
- **Project**: Organizational container for tasks with its own properties
- **Attachment**: Binary file associated with notes/tasks, stored as encrypted chunks with manifest
- **Recovery Phrase**: 24-word BIP39 mnemonic that can regenerate the master key
- **File Key**: Per-item encryption key, encrypted with vault key for storage

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can complete first device setup including recovery phrase confirmation in under 3 minutes
- **SC-002**: Single item sync completes in under 2 seconds on standard broadband connection
- **SC-003**: Batch sync of 100 items completes in under 30 seconds
- **SC-004**: Initial sync of 1000 items for new device completes in under 5 minutes
- **SC-005**: Note editing feels instantaneous with changes synced within 500ms
- **SC-006**: System supports 10,000+ items per user without performance degradation
- **SC-007**: Device linking via QR code completes in under 30 seconds after scan
- **SC-008**: Recovery phrase restoration completes in under 2 minutes
- **SC-009**: Users never lose data due to conflicts - all concurrent edits merge successfully
- **SC-010**: Attachment upload of 50MB file completes in under 30 seconds on good connection
- **SC-011**: Video playback starts within 5 seconds of user request (streaming)
- **SC-012**: Sync status is always accurate and updates within 1 second of state changes
- **SC-013**: 95% of users successfully link a second device on first attempt
- **SC-014**: Zero plain-text user content visible in server logs or storage
- **SC-015**: App remains responsive during background sync operations

### Assumptions

- Users have consistent internet access (mobile data or WiFi) for initial sync
- Users can securely store their 24-word recovery phrase offline
- OAuth providers (Google, Apple, GitHub) remain available and stable
- Modern devices have secure keychain/keystore capabilities
- Users understand the importance of the recovery phrase and consequences of losing it
- Average user has fewer than 5 linked devices
- Typical attachment size is under 25MB with occasional larger files
- Rich text notes are typically under 100KB of content
- Users prefer automatic conflict resolution over manual merge choices

## Scope Boundaries

### In Scope

- Desktop (macOS, Windows, Linux) and mobile (iOS, Android) sync
- Notes, tasks, projects, inbox items, and attachments
- Account-level settings that should roam across devices
- Real-time and offline sync capabilities
- End-to-end encryption with zero-knowledge server

### Out of Scope

- Device-specific settings (theme, window position, panel widths)
- Full-text search index (rebuilt locally from synced data)
- Web browser-based access (desktop/mobile apps only for now)
- Multi-user real-time editing (future collaboration feature)
- Server-side processing or AI features on encrypted content
- Automatic backup to external services

## Dependencies

- OAuth providers for authentication
- Platform keychain APIs for secure key storage
- Sync server infrastructure for storing encrypted blobs
- WebSocket support for real-time sync connections
