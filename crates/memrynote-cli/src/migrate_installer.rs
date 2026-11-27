//! `--cli migrate-installer <path>` (`apps/desktop/src/main/cli/migrate-installer.ts:46-58`).
//!
//! The hand-off from an NSIS install to Velopack runs in the last Electron build (Step 38,
//! #3555). Every Tauri build on Windows is a Velopack install, so after the argument checks
//! there is nothing to migrate.

use std::path::Path;

use crate::CliIo;

const USAGE: &str = "Usage: --cli migrate-installer <path-to-MemryNote-Setup-win-x64.exe>";

pub fn run(args: &[String], io: &mut dyn CliIo) -> i32 {
    let message = if !cfg!(windows) {
        "migrate-installer is only available on Windows."
    } else if args
        .first()
        .is_none_or(|source| source.is_empty() || !Path::new(source).exists())
    {
        USAGE
    } else {
        "This is not an NSIS install of MemryNote; nothing to migrate."
    };
    io.err(message);
    1
}
