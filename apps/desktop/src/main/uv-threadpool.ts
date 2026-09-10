// Must be the FIRST module the main process executes. libuv reads
// UV_THREADPOOL_SIZE once, when the pool is lazily created on its first use, so
// setting it after any async fs / zlib / crypto / dns / keytar work has started
// is a no-op.
//
// Why: keytar runs on that pool, and on a machine whose Secret Service is
// registered on D-Bus but never answers (a ChromeOS Crostini container with a
// locked gnome-keyring collection and no prompter), a keychain read never
// returns and its thread is gone for the rest of the process. With the default
// of 4, a handful of startup keychain reads was enough to starve the pool, and
// from then on every fs/promises call in the main process — journal entries,
// file pages, project folders, the shutdown snapshot flush — never resolved.
// sqlite is synchronous and kept working, so the app looked healthy.
//
// The real guard is the single-flight queue plus the unavailability latch in
// secrets/secret-storage.ts, which caps a wedged keychain at one burned thread
// per run. This only widens the margin for everything else that shares the
// pool.
//
// Verified under Electron 43 on macOS, measured on the real production main
// bundle (every vendor require ahead of this statement already executed): 12
// concurrent ~1 s pbkdf2 calls run ~2.9-3.5 threads wide without it and
// ~5.7-7.6 threads wide with it.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16'
}

export {}
