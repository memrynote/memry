// App-wide shutdown latch.
//
// Set once, at the very start of the app's graceful shutdown (before-quit). It
// exists to stop long-running STARTUP work that is still in flight from
// re-arming services the shutdown sequence has already torn down.
//
// Concretely: `autoOpenLastVault()` blocks on the vault's first `fullSync`
// (which can be a slow re-pull) inside `startSyncRuntime()`. If the user clicks
// Restart during that pull, before-quit stops the sync runtime + capture server,
// and then — when the pull finally settles — the startup chain resumes and
// restarts them mid-shutdown (observed: "Sync runtime started" logged after
// "stopping sync runtime"). Gating the re-arm points on this latch prevents it.
//
// One-way for the process lifetime: the app never un-shuts-down. It is NOT tied
// to `stopSyncRuntime()` (which also runs for vault switches / session teardown,
// where sync SHOULD be able to start again) — only the app-quit path sets it.
let shuttingDown = false

export function beginAppShutdown(): void {
  shuttingDown = true
}

export function isAppShuttingDown(): boolean {
  return shuttingDown
}
