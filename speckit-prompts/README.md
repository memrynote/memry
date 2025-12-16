# Memry Spec-Kit Prompts

This folder contains customized prompts for using [spec-kit](https://github.com/github/spec-kit) with Memry.

## What is Spec-Kit?

Spec-Kit enables **Specification-Driven Development (SDD)** where specifications generate implementation, not the other way around. It inverts the traditional power structure: code serves specifications.

## Workflow Overview

```
┌─────────────────┐
│  /constitution  │  Define project principles (run once)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    /specify     │  Define WHAT to build (user stories, requirements)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    /clarify     │  Resolve ambiguities (optional)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     /plan       │  Define HOW to build (tech stack, architecture)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     /tasks      │  Break into dependency-ordered tasks
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   /implement    │  Execute the tasks
└─────────────────┘
```

## Files in This Folder

| File | Purpose |
|------|---------|
| `constitution.md` | Memry's governing principles (local-first, E2EE, vault-based) |
| `specify.md` | Feature specification prompts for backend infrastructure |
| `plan.md` | Technical implementation prompts with Memry's tech stack |
| `README.md` | This file |

## Quick Start

### 1. Establish Constitution (One-time)

```bash
# Copy the prompt from constitution.md and run:
/speckit.constitution <paste prompt>
```

This creates `.specify/memory/constitution.md` with Memry's core principles.

### 2. Specify a Feature

```bash
# Example: Vault file system
/speckit.specify Implement the vault file system foundation for Memry...
```

This creates a feature branch and `specs/###-feature-name/spec.md`.

### 3. Create Implementation Plan

```bash
# Copy relevant prompt from plan.md and run:
/speckit.plan <paste tech stack details>
```

This generates:
- `plan.md` - Architecture and tech decisions
- `research.md` - Best practices research
- `data-model.md` - Entity definitions
- `contracts/` - API specifications
- `quickstart.md` - Usage examples

### 4. Generate Tasks

```bash
/speckit.tasks
```

This creates `tasks.md` with dependency-ordered implementation tasks.

### 5. Implement

```bash
/speckit.implement
```

Executes all tasks according to the plan.

## Memry-Specific Principles

1. **Local-First**: All data stored locally in user's vault folder
2. **E2EE**: End-to-end encryption with user-controlled keys
3. **Vault-Based**: Plain Markdown files, Obsidian-compatible
4. **AI-Augmented**: AI enhances, never replaces user agency
5. **Electron Security**: Context isolation, IPC-only system access

## Tech Stack Summary

| Component | Technology |
|-----------|------------|
| Desktop | Electron 33+ |
| Frontend | React 19 + TypeScript + shadcn/ui |
| Build | electron-vite |
| Database | better-sqlite3 |
| Search | SQLite FTS5 |
| Encryption | AES-256-GCM + Argon2id |
| File Watch | chokidar |
| Key Storage | keytar (OS keychain) |

## Backend Features to Build

1. **Vault File System** - Foundation for all file operations
2. **Note Persistence** - Markdown files with wiki-links
3. **Journal Persistence** - Date-based daily entries
4. **Task Persistence** - SQLite-backed task management
5. **E2E Encryption** - Optional vault encryption
6. **Inbox/Quick Capture** - Fast capture with global hotkey
7. **Search & Indexing** - Full-text search with FTS5

## Directory Structure

After running spec-kit commands:

```
memry/
├── .specify/
│   ├── memory/
│   │   └── constitution.md    # Project principles
│   ├── templates/             # Command templates
│   └── scripts/               # Helper scripts
├── specs/
│   ├── 001-vault-filesystem/
│   │   ├── spec.md            # Feature specification
│   │   ├── plan.md            # Implementation plan
│   │   ├── research.md        # Technical research
│   │   ├── data-model.md      # Entity definitions
│   │   ├── contracts/         # API specs
│   │   └── tasks.md           # Implementation tasks
│   └── 002-note-persistence/
│       └── ...
├── speckit-prompts/           # This folder
└── src/                       # Implementation
```
