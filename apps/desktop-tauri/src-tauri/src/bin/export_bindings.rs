//! Writes or checks `src/generated/bindings.ts` from `registry::builder()` without starting
//! Tauri. `--out <path>` writes; `--check <path>` exits 1 when the committed file differs.

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use memry_tauri::registry;
use specta_typescript::Typescript;

const REGENERATE: &str = "pnpm ipc:generate";

/// LF newlines and exactly one trailing newline, so the committed file passes `git diff --check`.
fn normalize(bytes: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(bytes).replace("\r\n", "\n");
    format!("{}\n", text.trim_end()).into_bytes()
}

fn export_to(path: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    registry::builder()
        .export(Typescript::default(), path)
        .map_err(|e| format!("export bindings: {e}"))?;
    let written = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    fs::write(path, normalize(&written)).map_err(|e| format!("write {}: {e}", path.display()))
}

fn run() -> Result<bool, String> {
    let mut args = std::env::args().skip(1);
    let mode = args
        .next()
        .ok_or("usage: export-bindings --out <path> | --check <path>")?;
    let path = PathBuf::from(args.next().ok_or("missing <path>")?);
    match mode.as_str() {
        "--out" => export_to(&path).map(|()| true),
        "--check" => {
            let temp =
                std::env::temp_dir().join(format!("memry-bindings-{}.ts", std::process::id()));
            export_to(&temp)?;
            let fresh = fs::read(&temp).map_err(|e| format!("read {}: {e}", temp.display()))?;
            let _ = fs::remove_file(&temp);
            let committed = fs::read(&path).map(|b| normalize(&b)).unwrap_or_default();
            if fresh == committed {
                return Ok(true);
            }
            eprintln!(
                "{} is out of date. Run `{REGENERATE}` and commit the result.",
                path.display()
            );
            Ok(false)
        }
        other => Err(format!("unknown argument {other}")),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(message) => {
            eprintln!("export-bindings: {message}");
            ExitCode::from(2)
        }
    }
}
