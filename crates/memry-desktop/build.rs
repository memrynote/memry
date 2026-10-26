//! Embeds the four namespaces the native process speaks (`errors`, `menu`, `system`,
//! `notes`) from `packages/i18n/src/locales`. Each locale becomes one text blob of
//! `key US value RS` records (`key` is `ns:dotted.path`, sorted); `i18n::catalog` indexes a
//! blob on first use. Renderer-only namespaces are not embedded.

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

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"))
        .join("../../packages/i18n/src/locales");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("out dir"));
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
