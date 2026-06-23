# Ollama Context Window Fix (#591) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop local Ollama models returning one-word replies in Agent Chat by having Memry set the context window itself, with no user-side Ollama config.

**Architecture:** When the local provider preset is `ollama`, route the chat turn through Ollama's **native `/api/chat`** (via the `ollama-ai-provider-v2` AI-SDK provider) and pass `options.num_ctx: 8192`. All other presets (lm_studio, llama_cpp, custom) keep the existing `@ai-sdk/openai` `/v1` path unchanged. Everything downstream (`streamText`, `mapAiSdkEvents`, tools) is provider-agnostic and stays as-is.

**Tech Stack:** Electron main process, Vercel AI SDK (`ai@^6`), `@ai-sdk/openai`, new `ollama-ai-provider-v2@^3.6.0`, Vitest.

## Context (why)

Issue #591: `gemma4` via Ollama answers fully in `ollama run` but returns one word in Memry. Root cause is Ollama's context window, confirmed in-thread by the reporter (the env-var workaround `OLLAMA_NUM_PARALLEL=1 OLLAMA_CONTEXT_LENGTH=8192 ollama serve` fixed it):

- Ollama's default context is **4096** tokens and `OLLAMA_NUM_PARALLEL` (auto, often 4) **divides** that across slots → ~1024 effective tokens/request.
- The window is a single shared budget (input + output). Memry's large agent system prompt + tool JSON schemas nearly fill ~1024 tokens, leaving room for ~1 output token → one word, every response.
- `ollama run`'s tiny prompt fits, so it never overflows — which is why it was irreproducible on better-provisioned/lower-parallel machines.

Memry currently talks to Ollama through the **OpenAI-compat `/v1/chat/completions`** endpoint (`createOpenAI().chat()`), which **cannot carry `num_ctx`** — confirmed from Ollama source: the `/v1` `ChatCompletionRequest` struct omits `num_ctx`/`keep_alive`/`extra_body` ("therefore not supported"). The only way to set the window per request is Ollama's native `/api/chat` `options` object. Outcome: full local replies on every machine, zero user config.

## Global Constraints

- Pre-production: no backward-compat constraints.
- Code style: single quotes, no semicolons, 100 char width, no trailing commas.
- Only the `ollama` preset changes transport; non-Ollama OpenAI-compat servers (LM Studio, llama.cpp, proxies) MUST keep using `/v1` (they manage context server-side and reject `num_ctx`).
- `num_ctx` fixed at `8192` (deliberate — see Task 2 ponytail note). Do not add a user setting in this plan.
- Desktop change → docs gate applies (`pnpm docs:impact --base <base> --strict`).

---

### Task 1: Add the Ollama AI-SDK provider dependency

**Files:**

- Modify: `apps/desktop/package.json` (dependencies)

**Interfaces:**

- Produces: `ollama-ai-provider-v2` import `createOllama` available to the backend.

- [ ] **Step 1: Add the dependency**

Run (plain npm/pnpm per repo rule — do not use rtk for installs):

```bash
pnpm --filter @memry/desktop add ollama-ai-provider-v2@^3.6.0
```

It declares `peerDependencies: { ai: '^5.0.0 || ^6.0.0', zod: '^4.0.16' }` — matches the repo's `ai@^6` + Zod v4. Pure JS, no native rebuild needed.

- [ ] **Step 2: Verify it resolves**

Run: `pnpm --filter @memry/desktop exec node -e "require('ollama-ai-provider-v2')"`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "build(desktop): add ollama-ai-provider-v2 for native num_ctx"
```

---

### Task 2: Route the Ollama preset through native /api with num_ctx

**Files:**

- Modify: `apps/desktop/src/main/agent/backends/local-openai-compatible-backend.ts` (imports; `run()` at lines 61-88; add two module-scope helpers)
- Test: `apps/desktop/src/main/agent/backends/__tests__/local-openai-compatible-backend.test.ts`

**Interfaces:**

- Consumes: `AgentLocalProviderSettings.preset` (already on the settings object, `packages/contracts/src/ipc-agent.ts:159`), `settings.baseUrl`, `streamText`, `stepCountIs`, `createAiSdkToolSet` (all already imported/used).
- Produces: no new exported symbols. Behavior change only: `preset === 'ollama'` builds the model with `createOllama(...)(modelName)` and passes `providerOptions.ollama.options.num_ctx`.

- [ ] **Step 1: Update the test mocks to cover the Ollama provider**

In the test file, extend the `vi.hoisted` block and add the provider mock so the existing `preset: 'ollama'` test keeps passing through the new branch:

```ts
const mocks = vi.hoisted(() => ({
  createOpenAI: vi.fn(() => ({
    chat: vi.fn((model: string) => ({ provider: 'openai-compatible', model }))
  })),
  createOllama: vi.fn(() => vi.fn((model: string) => ({ provider: 'ollama', model }))),
  streamText: vi.fn(),
  stepCountIs: vi.fn((count: number) => ({ type: 'step-count', count }))
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI
}))

vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: mocks.createOllama
}))

vi.mock('ai', () => ({
  streamText: mocks.streamText,
  stepCountIs: mocks.stepCountIs,
  tool: (definition: unknown) => definition
}))
```

- [ ] **Step 2: Write the failing tests**

Add these two cases inside the `describe('LocalOpenAICompatibleBackend', ...)` block. They reuse the existing `createProbeFetch()` helper already in the file.

```ts
it('ollama preset uses the native /api endpoint with num_ctx 8192', async () => {
  mocks.streamText.mockReturnValueOnce({
    fullStream: (async function* () {
      yield { type: 'text-delta', text: 'ok' }
    })()
  })

  const backend = new LocalOpenAICompatibleBackend({
    getSettings: async () => ({
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4',
      apiKeyConfigured: false,
      allowNonLoopback: false
    }),
    getApiKey: async () => null,
    toolBridge: { execute: vi.fn() } as never,
    fetch: createProbeFetch()
  })

  await backend.runTurn({
    prompt: 'hi',
    conversationId: 'c1',
    windowId: 1,
    options: { backend: 'local_openai_compatible' }
  } as never)

  expect(mocks.createOllama).toHaveBeenCalledWith(
    expect.objectContaining({ baseURL: 'http://localhost:11434/api' })
  )
  expect(mocks.createOpenAI).not.toHaveBeenCalled()
  const streamArgs = mocks.streamText.mock.calls[0][0]
  expect(streamArgs.providerOptions).toEqual({ ollama: { options: { num_ctx: 8192 } } })
})

it('non-ollama preset stays on the /v1 openai-compat path without num_ctx', async () => {
  mocks.streamText.mockReturnValueOnce({
    fullStream: (async function* () {
      yield { type: 'text-delta', text: 'ok' }
    })()
  })

  const backend = new LocalOpenAICompatibleBackend({
    getSettings: async () => ({
      preset: 'lm_studio',
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen2.5',
      apiKeyConfigured: false,
      allowNonLoopback: false
    }),
    getApiKey: async () => null,
    toolBridge: { execute: vi.fn() } as never,
    fetch: createProbeFetch()
  })

  await backend.runTurn({
    prompt: 'hi',
    conversationId: 'c1',
    windowId: 1,
    options: { backend: 'local_openai_compatible' }
  } as never)

  expect(mocks.createOpenAI).toHaveBeenCalled()
  expect(mocks.createOllama).not.toHaveBeenCalled()
  expect(mocks.streamText.mock.calls[0][0].providerOptions).toBeUndefined()
})
```

> If `runTurn`'s exact input shape differs from the `as never` stub above, copy the field names from the existing passing test in the same file (it constructs the same `getSettings`/`toolBridge`/`fetch` deps).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- local-openai-compatible-backend`
Expected: the two new tests FAIL (`createOllama` not called; `providerOptions` undefined for ollama).

- [ ] **Step 4: Implement the branch**

In `local-openai-compatible-backend.ts`, add the import at the top:

```ts
import { createOllama } from 'ollama-ai-provider-v2'
```

Add these module-scope helpers (near `let nextLocalRunPid = -1`):

```ts
// ponytail: fixed 8192-token window fixes #591. Ollama's default context is 4096
// and OLLAMA_NUM_PARALLEL divides it across slots, so Memry's system prompt + tool
// schemas overflow and the reply is cut to one token. Promote to a user setting only
// if someone needs to tune it.
const OLLAMA_NUM_CTX = 8192

// Ollama's native API (the only endpoint that accepts num_ctx) lives at /api, while
// the stored ollama preset baseUrl points at the /v1 OpenAI-compat path.
function toOllamaApiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '') + '/api'
}
```

Replace the model construction + `streamText` call in `run()` (current lines 65-88):

```ts
const modelName = options?.model || settings.model
const isOllama = settings.preset === 'ollama'
const model = isOllama
  ? createOllama({
      baseURL: toOllamaApiBaseUrl(settings.baseUrl),
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {})
    })(modelName)
  : createOpenAI({
      baseURL: settings.baseUrl,
      apiKey: apiKey || 'local'
    }).chat(modelName)
const controller = new AbortController()
const toolsEnabled =
  allowTools &&
  (options?.toolsEnabled ?? true) &&
  (await probeLocalProvider(settings, this.deps.fetch ?? fetch, apiKey)).toolsEnabled
const result = streamText({
  model,
  prompt: input.prompt,
  abortSignal: controller.signal,
  stopWhen: stepCountIs(8),
  ...(isOllama ? { providerOptions: { ollama: { options: { num_ctx: OLLAMA_NUM_CTX } } } } : {}),
  ...(toolsEnabled
    ? {
        tools: createAiSdkToolSet(this.deps.toolBridge, {
          conversationId: input.conversationId,
          windowId: input.windowId
        })
      }
    : {})
})
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main -- local-openai-compatible-backend`
Expected: all tests in the file PASS (the two new ones plus the pre-existing event-mapping test).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/agent/backends/local-openai-compatible-backend.ts \
        apps/desktop/src/main/agent/backends/__tests__/local-openai-compatible-backend.test.ts
git commit -m "fix(agent): send num_ctx to Ollama via native /api to stop one-word replies (#591)"
```

---

### Task 3: Verify end-to-end and clear the docs gate

**Files:**

- Possibly modify: `apps/docs/src/**` (only if docs:impact reports `missing-docs`)

- [ ] **Step 1: Reproduce the bug before the fix (sanity)**

On a dev machine, force the OP's effective window and confirm the one-word symptom on the pre-fix build:

```bash
OLLAMA_NUM_PARALLEL=4 OLLAMA_CONTEXT_LENGTH=2048 ollama serve
```

Set Agent Chat local provider to the `ollama` preset + a chat model (e.g. `gemma3`/`gemma4`), tools on, send a message → expect one word (pre-fix).

- [ ] **Step 2: Verify the fix in the running app**

With the same constrained `ollama serve` still running, launch the patched app:

```bash
pnpm --filter @memry/desktop dev
```

Send the same message → expect a full multi-sentence reply. The fix works because the explicit `num_ctx: 8192` overrides the divided default regardless of `OLLAMA_NUM_PARALLEL`.

- [ ] **Step 3: Run lint + full main test suite**

```bash
pnpm --filter @memry/desktop lint
pnpm --filter @memry/desktop test:main
```

Expected: no new failures (note any pre-existing failures on `main` per CLAUDE.md).

- [ ] **Step 4: Docs gate**

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:impact --base "$base_commit" --strict
```

If it reports `missing-docs`, update the Agent Chat / local-provider page under `apps/docs/src/**` (note that Ollama context is handled automatically; no env vars needed) or run `pnpm docs:ai-update --base "$base_commit"`, then re-run `--strict` and `pnpm docs:build`.

- [ ] **Step 5: Commit any docs changes**

```bash
git add apps/docs/src
git commit -m "docs(agent): note automatic Ollama context window handling (#591)"
```

---

## Edge cases (handled, no extra code)

- **OOM:** if `num_ctx × num_parallel` exceeds memory, Ollama errors → `streamText` throws → `mapAiSdkEvents` `onError` sets `exitCode=1`/`stderr` (existing path) → surfaced to the user instead of a silent one-word reply. 8192 is conservative.
- **Model reload:** changing `num_ctx` between calls triggers an Ollama reload; we send a constant 8192, so steady-state turns reuse the loaded model.
- **Remote Ollama:** `allowNonLoopback` + apiKey is forwarded as a `Bearer` header to the native endpoint for parity with the `/v1` path.

## Self-review

- Spec coverage: in-app fix (Task 2), no user config (fixed num_ctx), non-Ollama untouched (preset branch), verification + docs (Task 3). ✓
- Placeholder scan: all steps carry concrete code/commands. The one `>` note in Task 2 Step 2 points the implementer at the existing test for the exact `runTurn` input shape — copy, don't invent. ✓
- Type/name consistency: `toOllamaApiBaseUrl`, `OLLAMA_NUM_CTX`, `isOllama`, `createOllama` used identically across the implementation and tests. ✓
