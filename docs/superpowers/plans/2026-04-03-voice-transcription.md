# Voice Transcription Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit local/OpenAI voice transcription with local Whisper-small download-on-demand, click-time mic gating, and OpenAI BYOK storage.

**Architecture:** Introduce a dedicated voice-transcription settings and runtime path separate from embeddings and inline AI. Main process owns provider readiness, local model lifecycle, BYOK key access, and provider dispatch; renderer only shows settings state and asks readiness before opening the recorder.

**Tech Stack:** Electron IPC, React, TanStack Query, Drizzle settings storage, keytar, OpenAI SDK, `@huggingface/transformers`

---

## File Map

- Modify: `packages/contracts/src/settings-schemas.ts`
- Modify: `packages/contracts/src/ipc-channels.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`
- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts`
- Modify: `apps/desktop/src/main/inbox/capture.ts`
- Modify: `apps/desktop/src/main/inbox/transcription.ts`
- Modify: `apps/desktop/src/renderer/src/pages/settings/ai-section.tsx`
- Modify: `apps/desktop/src/renderer/src/components/capture-input.tsx`
- Modify: `apps/desktop/src/renderer/src/components/quick-capture.tsx`
- Create: `apps/desktop/src/main/inbox/voice-model.ts`
- Create: `apps/desktop/src/main/inbox/voice-settings.ts`
- Create: `apps/desktop/src/main/inbox/voice-keychain.ts`
- Create: `apps/desktop/src/renderer/src/lib/voice-recording-readiness.ts`
- Test: `apps/desktop/src/main/ipc/settings-handlers.test.ts`
- Test: `apps/desktop/src/main/inbox/transcription.test.ts`
- Test: renderer/component tests for mic gating and Settings redirect

## Chunk 1: Contracts And Settings Surface

### Task 1: Add contract types for voice transcription settings

**Files:**
- Modify: `packages/contracts/src/settings-schemas.ts`
- Modify: `packages/contracts/src/ipc-channels.ts`

- [ ] Step 1: Write failing contract tests or type assertions around new voice settings shape.
- [ ] Step 2: Run targeted contract/type checks and verify failure.
- [ ] Step 3: Add `VoiceTranscriptionSettings` schema/defaults and new IPC channels.
- [ ] Step 4: Run targeted type checks and verify pass.

### Task 2: Expose new settings methods through preload

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`

- [ ] Step 1: Add failing preload typings or IPC map expectations.
- [ ] Step 2: Run `pnpm ipc:check` and confirm failure if signatures are missing.
- [ ] Step 3: Add preload methods for settings, model status, download, readiness, and API-key save.
- [ ] Step 4: Run `pnpm ipc:check` and verify pass.

## Chunk 2: Main-Process Voice Settings And Model Runtime

### Task 3: Add voice settings persistence and BYOK access helpers

**Files:**
- Create: `apps/desktop/src/main/inbox/voice-settings.ts`
- Create: `apps/desktop/src/main/inbox/voice-keychain.ts`
- Test: `apps/desktop/src/main/ipc/settings-handlers.test.ts`

- [ ] Step 1: Write failing tests for default provider, provider updates, and masked/present API-key behavior.
- [ ] Step 2: Run `pnpm test -- --project main settings-handlers` or the exact Vitest target and confirm failure.
- [ ] Step 3: Implement SQLite-backed non-secret settings plus keychain-backed OpenAI key helpers.
- [ ] Step 4: Re-run the targeted tests and verify pass.

### Task 4: Add local Whisper-small model lifecycle manager

**Files:**
- Create: `apps/desktop/src/main/inbox/voice-model.ts`
- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts`
- Test: `apps/desktop/src/main/ipc/settings-handlers.test.ts`

- [ ] Step 1: Write failing tests for model status, download initiation, and readiness outcomes.
- [ ] Step 2: Run targeted main tests and confirm failure.
- [ ] Step 3: Implement model cache path resolution, status reporting, download/load orchestration, and progress events.
- [ ] Step 4: Re-run the targeted tests and verify pass.

## Chunk 3: Provider Dispatch In Inbox Transcription

### Task 5: Refactor transcription to route through selected provider

**Files:**
- Modify: `apps/desktop/src/main/inbox/transcription.ts`
- Modify: `apps/desktop/src/main/inbox/capture.ts`
- Test: `apps/desktop/src/main/inbox/transcription.test.ts`

- [ ] Step 1: Write failing tests for local dispatch, OpenAI dispatch, missing-key block, missing-model block, and no-fallback behavior.
- [ ] Step 2: Run the targeted transcription tests and confirm failure.
- [ ] Step 3: Replace env-only OpenAI logic with provider resolution from voice settings plus readiness-aware transcription dispatch.
- [ ] Step 4: Re-run the targeted transcription tests and verify pass.

### Task 6: Wire settings IPC to the new voice settings/runtime helpers

**Files:**
- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts`
- Test: `apps/desktop/src/main/ipc/settings-handlers.test.ts`

- [ ] Step 1: Extend failing tests for new IPC handlers and returned payload shapes.
- [ ] Step 2: Run targeted main tests and confirm failure.
- [ ] Step 3: Register handlers for voice settings, model status, download, readiness, and BYOK save.
- [ ] Step 4: Re-run targeted tests and verify pass.

## Chunk 4: Settings UI

### Task 7: Add the Voice Transcription settings group

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/settings/ai-section.tsx`

- [ ] Step 1: Write failing renderer tests for provider selector, local model status card, and OpenAI key field visibility.
- [ ] Step 2: Run the targeted renderer test and confirm failure.
- [ ] Step 3: Implement the new `Voice Transcription` settings group in the existing AI Settings page.
- [ ] Step 4: Re-run the targeted renderer test and verify pass.

## Chunk 5: Mic Gating In Renderer

### Task 8: Add shared readiness guard before opening any recorder

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/voice-recording-readiness.ts`
- Modify: `apps/desktop/src/renderer/src/components/capture-input.tsx`
- Modify: `apps/desktop/src/renderer/src/components/quick-capture.tsx`

- [ ] Step 1: Write failing renderer tests asserting mic click opens Settings instead of recorder when the provider is not ready.
- [ ] Step 2: Run the targeted renderer tests and confirm failure.
- [ ] Step 3: Implement a shared readiness helper and use it from each mic-click entry point.
- [ ] Step 4: Re-run the targeted renderer tests and verify pass.

### Task 9: Keep recorder behavior unchanged once readiness succeeds

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/voice-recorder.tsx` only if needed
- Test: existing or new renderer/component tests

- [ ] Step 1: Write or extend a failing test showing recorder still opens and records when readiness is `ready`.
- [ ] Step 2: Run the targeted renderer test and confirm failure.
- [ ] Step 3: Make the minimal code change needed, preferably outside the recorder component.
- [ ] Step 4: Re-run the targeted renderer test and verify pass.

## Chunk 6: Verification

### Task 10: Regenerate IPC artifacts and run focused checks

**Files:**
- Modify: generated artifacts as needed

- [ ] Step 1: Run `pnpm ipc:generate`.
- [ ] Step 2: Run targeted tests for main and renderer files touched by this feature.
- [ ] Step 3: Fix any failures with the smallest possible change.
- [ ] Step 4: Re-run the same targeted tests until green.

### Task 11: Run repository verification for the touched surfaces

- [ ] Step 1: Run `pnpm lint`.
- [ ] Step 2: Run `pnpm typecheck`.
- [ ] Step 3: Run `pnpm test`.
- [ ] Step 4: If any command fails because of known unrelated issues, document the exact failure and confirm whether the touched tests still passed.

Plan complete and saved to `docs/superpowers/plans/2026-04-03-voice-transcription.md`. Ready to execute?
