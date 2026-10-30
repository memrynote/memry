//! `![[target]]` image embeds resolve as Electron's `resolveVaultEmbeds` resolves them: over a
//! real vault on disk, its `config.json` and the real `note_files` table, against what
//! Electron's own code returned for the same vault (`fixtures/gen-embed-vectors.mjs`). With a
//! note path the answer is written into the note's body and its file, so it is a file format
//! Electron builds read too.
//!
//! Unix only: the vault holds a file name Windows refuses (`?`), and the URLs are the posix form.
#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;

use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_desktop::vault::config::{VaultConfigPatch, write_vault_config};
use memry_desktop::vault::embeds::resolve_embeds;
use serde_json::Value;

const VECTORS: &str = include_str!("fixtures/electron-vault/resolve-embeds.json");

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn embeds_resolve_as_electron_resolves_them_in_the_same_vault() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    let parent = tempfile::tempdir().unwrap();
    let name = "vault";
    let root = parent.path().join(name);
    let named = |text: &str| text.replace("<vault-name>", name);
    for file in strings(&vectors["files"]) {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }
    for dir in strings(&vectors["dirs"]) {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    let outside = parent.path().join(format!("{name}-outside"));
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("escape.png"), "x").unwrap();

    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    let vault = Vault::open("v".to_owned(), core.display().to_string()).unwrap();
    let files = vault.note_files();
    for (n, row) in vectors["index"].as_array().unwrap().iter().enumerate() {
        files
            .upsert_stat(NoteFileStat {
                note_id: format!("n{n}"),
                path: named(row["path"].as_str().unwrap()),
                file_type: row["fileType"].as_str().unwrap().to_owned(),
                mime_type: None,
                file_size: Some(1),
                content_hash: None,
                file_hash: None,
                indexed_at: 1,
            })
            .unwrap();
    }

    let refs: Vec<String> = strings(&vectors["refs"]).iter().map(|r| named(r)).collect();
    let url_root = root.to_string_lossy();
    let url_root = url_root.strip_prefix('/').unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let notes_folder = case["notesFolder"].as_str().unwrap();
        let patch = VaultConfigPatch {
            default_note_folder: Some(notes_folder.to_owned()),
            ..VaultConfigPatch::default()
        };
        write_vault_config(&root, &patch).unwrap();
        let note_path = case["notePath"].as_str();
        let expected: BTreeMap<String, String> = case["resolved"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(reference, target)| {
                let target = target.as_str().unwrap().replace("<vault>", url_root);
                (named(reference), target)
            })
            .collect();
        assert_eq!(
            resolve_embeds(&root, &files, &refs, note_path),
            expected,
            "note {note_path:?}, notes folder {notes_folder:?}"
        );
    }
}
