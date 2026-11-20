//! Writes or checks `src/generated/bindings.ts` and `src-tauri/permissions/app-all.json` from
//! `registry::builder()` without starting Tauri. `--out <path>` writes; `--check <path>` exits 1
//! when a committed file differs. `<path>` is the bindings file.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use memry_tauri::registry;
use specta_typescript::Typescript;

const REGENERATE: &str = "pnpm ipc:generate";

const APP_ALL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/permissions/app-all.json");

/// LF newlines and exactly one trailing newline, so the committed file passes `git diff --check`.
fn normalize(bytes: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(bytes).replace("\r\n", "\n");
    format!("{}\n", text.trim_end()).into_bytes()
}

/// The contents of the bindings and of the `app-all` permission.
fn generate() -> Result<(Vec<u8>, Vec<u8>), String> {
    let temp = std::env::temp_dir().join(format!("memry-bindings-{}.ts", std::process::id()));
    registry::builder()
        .export(Typescript::default(), &temp)
        .map_err(|e| format!("export bindings: {e}"))?;
    let written = fs::read(&temp).map_err(|e| format!("read {}: {e}", temp.display()));
    let _ = fs::remove_file(&temp);
    let bindings = normalize(&written?);
    let app_all = registry::app_all_permission(&String::from_utf8_lossy(&bindings))?;
    Ok((bindings, normalize(app_all.as_bytes())))
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Whether `path` holds `fresh`; prints the fix when it does not.
fn is_current(path: &Path, fresh: &[u8]) -> bool {
    let committed = fs::read(path).map(|b| normalize(&b)).unwrap_or_default();
    if committed == fresh {
        return true;
    }
    eprintln!(
        "{} is out of date. Run `{REGENERATE}` and commit the result.",
        path.display()
    );
    false
}

fn run() -> Result<bool, String> {
    let mut args = std::env::args().skip(1);
    let mode = args
        .next()
        .ok_or("usage: export-bindings --out <path> | --check <path>")?;
    let path = PathBuf::from(args.next().ok_or("missing <path>")?);
    let app_all = Path::new(APP_ALL);
    let (bindings, permission) = generate()?;
    match mode.as_str() {
        "--out" => {
            write(&path, &bindings)?;
            write(app_all, &permission)?;
            Ok(true)
        }
        "--check" => {
            let bindings_current = is_current(&path, &bindings);
            Ok(is_current(app_all, &permission) && bindings_current)
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
