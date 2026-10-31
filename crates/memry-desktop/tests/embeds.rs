//! `![[target]]` image embeds resolve as Electron's `resolveVaultEmbeds` resolves them: over a
//! real vault on disk, its `config.json` and the real `note_files` table, against what
//! Electron's own code returned for the same vault (`fixtures/gen-embed-vectors.mjs`). With a
//! note path the answer is written into the note's body and its file, so it is a file format
//! Electron builds read too.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_desktop::vault::embeds::resolve_embeds;

/// Electron's answers for one vault. Unix only: the vault holds a file name Windows refuses
/// (`?`), and the URLs are the posix form.
#[cfg(unix)]
mod electron_vectors {
    use memry_desktop::vault::config::{VaultConfigPatch, write_vault_config};
    use serde_json::Value;

    use super::*;

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
}

fn image_row(note_id: &str, path: &str) -> NoteFileStat {
    NoteFileStat {
        note_id: note_id.to_owned(),
        path: path.to_owned(),
        file_type: "image".to_owned(),
        mime_type: None,
        file_size: Some(1),
        content_hash: None,
        file_hash: None,
        indexed_at: 1,
    }
}

/// A vault at `parent/vault` with `files` on disk and a core database.
fn vault_with(parent: &Path, files: &[&str]) -> (std::path::PathBuf, Vault) {
    let root = parent.join("vault");
    for file in files {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    let vault = Vault::open("v".to_owned(), core.display().to_string()).unwrap();
    (root, vault)
}

/// `link` points at the folder `target`: a symlink on Unix, a junction on Windows, which needs
/// no elevation.
fn link_dir(link: &Path, target: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J failed");
    }
}

/// A hit is a file whose real location is in the vault. A link or a junction in the vault that
/// leads out of it resolves to nothing, by its path or through the image rows, so an embed
/// never tells what is on disk outside the vault. A link that stays inside resolves, as in
/// Electron.
#[test]
fn an_embed_through_a_link_out_of_the_vault_resolves_to_nothing() {
    let parent = tempfile::tempdir().unwrap();
    let (root, vault) = vault_with(parent.path(), &["img/inside.png", "notes/n.md"]);
    let outside = parent.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("photo.png"), "x").unwrap();
    fs::write(outside.join("out.png"), "x").unwrap();
    link_dir(&root.join("linked"), &outside);
    link_dir(&root.join("inner"), &root.join("img"));
    let files = vault.note_files();
    files
        .upsert_stat(image_row("n1", "linked/out.png"))
        .unwrap();

    let refs = [
        "linked/photo.png",
        "out.png",
        "inner/inside.png",
        "img/inside.png",
    ];
    let refs: Vec<String> = refs.iter().map(|r| (*r).to_owned()).collect();
    let expected = BTreeMap::from([
        ("img/inside.png".to_owned(), "../img/inside.png".to_owned()),
        (
            "inner/inside.png".to_owned(),
            "../inner/inside.png".to_owned(),
        ),
    ]);
    assert_eq!(
        resolve_embeds(&root, &files, &refs, Some("notes/n.md")),
        expected
    );
}

/// Only an image embed resolves, as only an image embed is ever asked for: the converter and
/// the renderer both pick `![[target]]`s by their image extension. A caller of the command
/// cannot use it to ask what else is on disk.
#[test]
fn only_an_image_target_resolves() {
    let parent = tempfile::tempdir().unwrap();
    let (root, vault) = vault_with(parent.path(), &["doc.pdf", "notes/n.md", "a.PNG"]);
    let refs = ["doc.pdf", "notes/n.md", "a.PNG"];
    let refs: Vec<String> = refs.iter().map(|r| (*r).to_owned()).collect();
    let expected = BTreeMap::from([("a.PNG".to_owned(), "../a.PNG".to_owned())]);
    assert_eq!(
        resolve_embeds(&root, &vault.note_files(), &refs, Some("notes/n.md")),
        expected
    );
}
