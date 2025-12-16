# Memry Backend Implementation Workflow

Step-by-step guide to implementing Memry's backend using spec-kit.

---

## Phase 0: Establish Foundation

### Step 1: Create Constitution

Run this once to establish Memry's governing principles:

```bash
/speckit.constitution Create the Memry project constitution with these principles:

1. **Local-First Architecture** - All data stored locally in vault folder, fully offline capable, no cloud required, users own their files directly

2. **End-to-End Encryption** - User-controlled encryption keys, zero-knowledge architecture, keys never leave device, AES-256-GCM + Argon2id

3. **Vault-Based File Structure** - Plain Markdown files, YAML frontmatter, wiki-links [[]], #tags, Obsidian-compatible

4. **AI-Augmented Not Dependent** - Local models + user API keys, transparent suggestions, no external data without consent

5. **Electron Security** - Context isolation, IPC-only system access, CSP headers, sandboxed renderer

Development standards: TypeScript strict, atomic file writes, 100ms UI response, 80% test coverage, WCAG 2.1 AA
```

---

## Phase 1: Vault Foundation (Week 1)

### Step 2: Specify Vault System

```bash
/speckit.specify Implement vault file system foundation - local folder storing all user data as human-readable files. Users select vault location, structure auto-creates (notes/, journal/, inbox/, attachments/, .memry/). Files are plain Markdown readable without Memry. Must detect external file changes, use atomic writes, handle conflicts gracefully.
```

### Step 3: Plan Vault Implementation

```bash
/speckit.plan Vault file system using Electron + Node.js. Use chokidar for file watching, fs/promises with atomic write pattern, gray-matter for frontmatter. IPC APIs: vault:initialize, vault:select, file:read/write/delete/list/watch. Structure in src/main/vault/ and src/main/ipc/vault-handlers.ts
```

### Step 4: Generate and Execute Tasks

```bash
/speckit.tasks
/speckit.implement
```

---

## Phase 2: Note Persistence (Week 2)

### Step 5: Specify Notes

```bash
/speckit.specify Implement note persistence - notes saved as Markdown in vault/notes/ with YAML frontmatter (id, created, modified, tags). Support wiki-links [[note]] for bidirectional linking, #tags for filtering, nested folders. Auto-save with debounce, atomic writes, handle renames updating all backlinks.
```

### Step 6: Plan Notes Implementation

```bash
/speckit.plan Note persistence using better-sqlite3 for metadata index, gray-matter + remark for Markdown parsing. Tables: notes (id, title, path, tags[], created, modified), note_links (source_id, target_id, context). IPC: note:create/read/update/delete/list/rename/search/getBacklinks
```

### Step 7: Execute

```bash
/speckit.tasks
/speckit.implement
```

---

## Phase 3: Journal Persistence (Week 3)

### Step 8: Specify Journal

```bash
/speckit.specify Implement journal persistence - one file per day at vault/journal/YYYY/MM/YYYY-MM-DD.md. Auto-create today's entry on first write. Navigate between dates. Parse [[links]] and task checkboxes. Track word counts for statistics and calendar heatmap.
```

### Step 9: Plan Journal Implementation

```bash
/speckit.plan Journal using same infrastructure as notes. Date-based path generation, auto-create folders. Index by date in SQLite for calendar queries. IPC: journal:getEntry(date), journal:saveEntry, journal:listEntries(range), journal:getStats
```

### Step 10: Execute

```bash
/speckit.tasks
/speckit.implement
```

---

## Phase 4: Task Persistence (Week 4)

### Step 11: Specify Tasks

```bash
/speckit.specify Implement task persistence - CRUD for tasks with projects, priorities (none/low/medium/high/urgent), due dates, recurring tasks, subtasks, linked notes. Filter by today/upcoming/project/completed. Persist manual sort order. Match existing TypeScript Task/Project types in renderer.
```

### Step 12: Plan Tasks Implementation

```bash
/speckit.plan Tasks in SQLite at vault/.memry/memry.db. Tables: tasks, projects, statuses. Match existing data model. IPC: task:create/update/delete/list/reorder/complete, project:CRUD. Handle recurrence on completion. Soft delete with archivedAt.
```

### Step 13: Execute

```bash
/speckit.tasks
/speckit.implement
```

---

## Phase 5: Search & Indexing (Week 5)

### Step 14: Specify Search

```bash
/speckit.specify Implement full-text search - instant search across notes, journals, tasks. Filter by type, tags, date range. Fuzzy matching, highlighted snippets. Incremental index updates on file changes. Results in <100ms.
```

### Step 15: Plan Search Implementation

```bash
/speckit.plan Search using SQLite FTS5 at vault/.memry/search.db. Index: id, type, title, content, tags, path, modified. Tokenize with porter stemmer. IPC: search:query, search:reindex, search:updateFile, search:suggest
```

### Step 16: Execute

```bash
/speckit.tasks
/speckit.implement
```

---

## Phase 6: Encryption (Week 6)

### Step 17: Specify Encryption

```bash
/speckit.specify Implement E2E encryption - user sets master password, derives encryption key with Argon2id, encrypts files with AES-256-GCM. Transparent encrypt-on-write/decrypt-on-read. Key in OS keychain via keytar. Auto-lock after timeout. Recovery key support.
```

### Step 18: Plan Encryption Implementation

```bash
/speckit.plan Encryption using Node crypto + argon2 + keytar. Never store password. Verify via encrypted known value. Individual file encryption with random IV. IPC: encryption:setup/unlock/lock/isSetup/isUnlocked/changePassword
```

### Step 19: Execute

```bash
/speckit.tasks
/speckit.implement
```

---

## Phase 7: Inbox (Week 7)

### Step 20: Specify Inbox

```bash
/speckit.specify Implement inbox/quick capture - fast capture via global hotkey, capture text/links/images. Auto-extract link metadata. Process by filing to notes/trash. Bulk actions for stale items.
```

### Step 21: Plan Inbox Implementation

```bash
/speckit.plan Inbox in vault/.memry/inbox.json or vault/inbox/*.md. Global shortcut via Electron globalShortcut. Link unfurling via node-fetch + metascraper. IPC: inbox:capture, inbox:list, inbox:file, inbox:delete
```

### Step 22: Execute

```bash
/speckit.tasks
/speckit.implement
```

---

## Integration Phase

### Connect Frontend to Backend

After backend features are complete:

1. Update preload API types in `src/preload/index.d.ts`
2. Replace in-memory data with IPC calls in React contexts
3. Update hooks to use new persistence layer
4. Add loading states and error handling
5. Test E2E flows with Playwright

---

## Verification Checklist

After each phase, verify:

- [ ] Feature works offline (no network)
- [ ] Data persists across app restart
- [ ] Files are human-readable in vault folder
- [ ] External file edits sync to app
- [ ] No Node.js APIs called directly from renderer
- [ ] All IPC handlers have error handling
- [ ] TypeScript types match between main and renderer
- [ ] Unit tests pass with 80%+ coverage
