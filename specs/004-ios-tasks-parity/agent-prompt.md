# Agent prompt: iOS tasks parity

Implement `specs/004-ios-tasks-parity/tasks.md` end to end in this session. Every checkbox gets ticked, on real evidence.

## Authority and scope

- This plan is committed on `main`. At TP001 you open your own worktree from `main` (§0.3), and you work only there. From then on, the worktree's `specs/004-ios-tasks-parity/tasks.md` is the plan and the only source of state. Never edit the main checkout: other sessions work in it.
- `tasks.md` is the plan and the only source of state. Read §0 (operating rules) and §1 (decisions D1–D7) in full before anything else, and follow them exactly.
- Kaan approved everything in §0.2 ahead of time:
  - pstack subagent delegation
  - one commit at the end of each phase on `feat/ios-tasks-parity` (explicit paths only, no push, no PR)
  - superseding FR-057 and FR-060

  Treat these as the explicit confirmation the root `AGENTS.md` "User Override" rule asks for.

- Do not ask Kaan questions. If something is ambiguous, pick the desktop behavior, record it in §6 Decisions log, and keep going. If something outside the repo blocks you, record it in §7 Blockers with evidence, move on to the next unblocked task, and retry once per phase.
- Desktop is the reference implementation. D1: date parsing is English only, exactly as desktop has it today, and quick-add needs the `@` prefix.

## Execution model (pstack)

- Call `subagents_enable` first. You are the orchestrator.
- Serial tasks and phase gates: you run them yourself.
- Every `[P]` block: fan out to subagents in parallel. Use the pstack role table:
  - feature and refactoring work: `anthropic/claude-opus-5-5:medium`
  - mechanical or swarm-style work (vector cases, copy files, test scaffolding): `anthropic/claude-sonnet-5`
  - reviews and judgment (TP092, and any disputed design call): `anthropic/claude-fable-5-1`
- Hand each subagent:
  - its task ids
  - the exact files it owns
  - the relevant §0/§1 rules
  - the verification command it must run

  Tell it plainly that it must not touch files outside its ownership.

- Only the orchestrator does these:
  - drives the simulator (`xcodebuildmcp`)
  - runs `crates/memry-core/build-xcframework.sh`
  - edits `crates/memry-core/src/api/*` and the generated Swift
  - commits
  - ticks checkboxes
- After each subagent returns, re-run its verification yourself, review the diff, integrate it, then tick the box and add the Evidence line.
- Never let two subagents own the same file. When overlap can't be avoided, run those tasks one after the other.

## Checkbox protocol

- Tick `[x]` only after the task's own verification passes. Under the ticked task, add one indented line: `Evidence: <command/result, test name, or screenshot path>`.
- Partial work stays unticked. Split it with a suffix id (for example `TP021a`) and describe what remains.
- Do not start a phase behind a gate (G1, G2) until that gate's commands are green. Record the gate result in the file.

## Running and testing the app

- Use the `xcodebuildmcp-cli` skill on the booted iPhone 17 simulator named in §0.3. Never erase or reset it.
- If the app lands on the sign-in or unlock screen, follow §0.4:
  - fetch the OTP with gmail-bridge (the latest mail from `noreply@memrynote.com` that arrived after your request)
  - respect the limit of 3 code requests per 10 minutes
- For every Phase 4 block, save screenshots to `apps/ios/SpikeEvidence/tasks-parity/`.
- Cross-device checks: run the desktop peer with `pnpm --filter @memry/desktop dev:staging`, signed in to the same account.
- Every piece of test data you create uses the §0.5 markers, and TP094 cleans it all up.

## Continuity

- Context compaction will happen. After each compaction or restart, re-read this file, then §0, §1, §6 and §7 of `tasks.md`, then continue from the first unticked task. Never redo a ticked task.
- Before any long step, make sure everything completed so far is ticked in the file.

## Finish

- Done means every task through TP094 is ticked, §0.6 is fully green, and §8 Final report is written: what shipped, an evidence index, and anything still open in §7.
- Only then call `goal_complete` (if Goal mode is active).
- Your last message: a short summary, the commit list, and every unresolved blocker.

Start with TP001.
