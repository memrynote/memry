//! Embeds the four namespaces the native process speaks (`errors`, `menu`, `system`,
//! `notes`) from `packages/i18n/src/locales`. Each locale becomes one text blob of
//! `key US value RS` records (`key` is `ns:dotted.path`, sorted); `i18n::catalog` indexes a
//! blob on first use. Renderer-only namespaces are not embedded.
//!
//! It also counts the `vault_desktop_write` operations of the agent MCP vectors into
//! `MEMRY_DESKTOP_WRITE_OPERATIONS`, so the write gate fails the build until it classifies a new
//! one (`agent::runtime::gate`).
//!
//! It bundles the user guide the agent's help tools read (`agent::tools::read_help`): Electron's
//! `help-docs.ts` glob of `apps/docs/src/guide/*.md` and `apps/docs/src/user-guide/**/*.md`,
//! without the CLI and agent API reference pages, as `help_pages.json` (`[[page, markdown]]`,
//! sorted by page).

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs};

use serde_json::Value;

const NAMESPACES: [&str; 4] = ["errors", "menu", "system", "notes"];
const UNIT: char = '\u{1f}';
const RECORD: char = '\u{1e}';

fn flatten(prefix: &str, value: &Value, out: &mut BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten(&path, child, out);
            }
        }
        Value::String(text) => {
            out.insert(prefix.to_owned(), text.clone());
        }
        // Arrays and numbers are not messages.
        _ => {}
    }
}

fn count_desktop_writes(manifest: &Path) {
    let path = manifest.join("../../packages/contracts/test-vectors/agent-mcp/desktop-ops.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let file: Value = serde_json::from_str(&read(&path))
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let count = file["operations"]
        .as_array()
        .expect("desktop-ops.json lists operations")
        .iter()
        .filter(|op| op["tool"] == "vault_desktop_write")
        .count();
    println!("cargo:rustc-env=MEMRY_DESKTOP_WRITE_OPERATIONS={count}");
}

/// The guide pages `help-docs.ts` leaves out: they answer in code, not in steps a user follows.
const HELP_EXCLUDED: [&str; 5] = [
    "user-guide/cli",
    "user-guide/cli-reference",
    "user-guide/ai/agent-api-reference",
    "user-guide/ai/agent-backends",
    "user-guide/ai/agent-mcp",
];

fn markdown_files(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir).unwrap_or_else(|error| panic!("{}: {error}", dir.display()));
    for entry in entries {
        let path = entry.expect("docs entry").path();
        if path.is_dir() {
            if recursive {
                markdown_files(&path, true, out);
            }
        } else if path.extension().is_some_and(|ext| ext == "md") {
            out.push(path);
        }
    }
}

fn bundle_help(manifest: &Path, out_dir: &Path) {
    let docs = manifest.join("../../apps/docs/src");
    let mut files = Vec::new();
    for (dir, recursive) in [("guide", false), ("user-guide", true)] {
        let dir = docs.join(dir);
        println!("cargo:rerun-if-changed={}", dir.display());
        markdown_files(&dir, recursive, &mut files);
    }
    let mut pages: Vec<(String, String)> = files
        .iter()
        .map(|file| {
            let page = file
                .strip_prefix(&docs)
                .expect("under docs")
                .with_extension("")
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            (page, read(file))
        })
        .filter(|(page, _)| !HELP_EXCLUDED.contains(&page.as_str()))
        .collect();
    pages.sort();
    let json = serde_json::to_string(&pages).expect("help pages json");
    fs::write(out_dir.join("help_pages.json"), json).expect("write help pages");
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    count_desktop_writes(&manifest);
    let root = manifest.join("../../packages/i18n/src/locales");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("out dir"));
    bundle_help(&manifest, &out_dir);
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", root.display());

    let mut locales: Vec<String> = fs::read_dir(&root)
        .unwrap_or_else(|error| panic!("{}: {error}", root.display()))
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join("errors.json").is_file())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    locales.sort();

    let mut table = String::from("pub static LOCALES: &[(&str, &str)] = &[\n");
    for locale in &locales {
        let mut messages = BTreeMap::new();
        for ns in NAMESPACES {
            let file: PathBuf = root.join(locale).join(format!("{ns}.json"));
            println!("cargo:rerun-if-changed={}", file.display());
            let json: Value = serde_json::from_str(&read(&file))
                .unwrap_or_else(|error| panic!("{}: {error}", file.display()));
            let mut flat = BTreeMap::new();
            flatten("", &json, &mut flat);
            for (path, text) in flat {
                messages.insert(format!("{ns}:{path}"), text);
            }
        }
        let mut blob = String::new();
        for (key, text) in &messages {
            assert!(
                !key.contains([UNIT, RECORD]) && !text.contains([UNIT, RECORD]),
                "{locale}: {key}"
            );
            write!(blob, "{key}{UNIT}{text}{RECORD}").expect("string write");
        }
        let blob_path = out_dir.join(format!("catalog_{locale}.txt"));
        fs::write(&blob_path, blob).expect("write blob");
        writeln!(
            table,
            "    ({locale:?}, include_str!({:?})),",
            blob_path.display().to_string()
        )
        .expect("string write");
    }
    table.push_str("];\n");
    fs::write(out_dir.join("catalog_data.rs"), table).expect("write table");
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}
