# Memry Constitution Prompt

Use this prompt with `/speckit.constitution` to establish Memry's governing principles.

---

## Prompt

```
Create the Memry project constitution with the following core principles:

**Project Identity**:
Memry is a local-first, end-to-end encrypted (E2EE) personal knowledge management (PKM) desktop application built with Electron. It combines task management, journaling, and note-taking with AI augmentation.

**Core Principles (5 required)**:

1. **Local-First Architecture** (NON-NEGOTIABLE)
   - All user data stored locally in a human-readable vault folder (like Obsidian)
   - Application functions fully offline - no internet required for core features
   - Cloud/sync features are opt-in only, never required
   - Users own their data files directly - no proprietary formats
   - Vault location is user-configurable

2. **End-to-End Encryption** (NON-NEGOTIABLE)
   - All sensitive data at rest encrypted with user-controlled keys
   - Zero-knowledge architecture: app cannot read content without user action
   - Encryption keys never leave the user's device
   - No plaintext secrets in application state, logs, or temp files
   - Support for hardware key integration (YubiKey, etc.) as optional enhancement

3. **Vault-Based File Structure**
   - Notes stored as plain Markdown files with YAML frontmatter
   - Journal entries stored as dated Markdown files (YYYY-MM-DD.md)
   - Wiki-links [[note-name]] for bidirectional linking
   - Tags stored inline (#tag) and indexed for search
   - Attachments stored in vault with relative path references
   - Metadata in frontmatter or companion .json sidecar files

4. **AI-Augmented, Not AI-Dependent**
   - AI features enhance workflows, never replace user agency
   - Support local models (Ollama, llama.cpp) AND cloud APIs (user's own keys)
   - All AI suggestions are transparent, explainable, and reversible
   - No data sent to external AI without explicit per-request consent
   - Graceful degradation: app fully functional without AI

5. **Electron Security Model**
   - Context isolation enforced - renderer has zero direct Node.js access
   - All system operations through explicit IPC preload API
   - No remote code execution or dynamic script loading
   - Content Security Policy restricts external resources
   - Sandboxed renderer process

**Additional Sections**:

**Data Sovereignty**:
- Export all data anytime (Markdown, JSON, standard formats)
- Import/export compatibility with Obsidian, Logseq, Bear
- No telemetry or phone-home without explicit consent
- GDPR/privacy-first design

**Development Standards**:
- TypeScript strict mode required
- Atomic file operations (write-temp-then-rename pattern)
- All user operations must be undoable
- UI responses within 100ms
- WCAG 2.1 AA accessibility compliance
- Test coverage minimum 80% for core modules

**Governance**:
- Constitution amendments require documented rationale
- Breaking changes need migration plans
- Privacy-impacting changes require user notification
```

---

## Expected Output

After running this prompt, you should have a complete constitution at `.specify/memory/constitution.md` that:

1. Defines Memry's 5 core non-negotiable principles
2. Establishes data sovereignty requirements
3. Sets development standards
4. Defines governance rules for amendments

## Next Steps

After constitution is established:
1. Run `/speckit.specify` with a feature description
2. Run `/speckit.plan` with tech stack details
