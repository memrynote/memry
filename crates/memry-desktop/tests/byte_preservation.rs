//! Vault file bytes survive a no-edit round trip (`byte-preservation.golden.test.ts`):
//! the Electron golden fixtures are copied to `fixtures/golden-vault`.

use std::fs;
use std::path::{Path, PathBuf};

use memry_core::markdown::frontmatter::{Eol, YamlValue};
use memry_desktop::vault::note_file::{NoteFileError, WriteOutcome, read_note, write_note};

fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden-vault")
}

fn fixtures() -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(golden())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".md"))
        .collect();
    names.sort();
    names
}

fn copy_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for name in fixtures() {
        fs::copy(golden().join(&name), dir.path().join(&name)).unwrap();
    }
    dir
}

#[test]
fn the_full_adversarial_fixture_set_is_present() {
    assert!(fixtures().len() >= 14);
}

#[test]
fn every_fixture_survives_read_and_write_without_an_edit_byte_identical() {
    let vault = copy_vault();
    for name in fixtures() {
        let before = fs::read(vault.path().join(&name)).unwrap();
        let note = read_note(vault.path(), &name).unwrap().expect(&name);
        assert_eq!(
            note.raw.as_bytes(),
            before,
            "{name}: read must not change a byte"
        );
        assert_eq!(
            note.split().block.unwrap_or("").to_owned() + note.split().body,
            note.raw
        );
        let parsed = note.parse().unwrap_or_else(|e| panic!("{name}: {e:?}"));

        let mtime = fs::metadata(vault.path().join(&name))
            .unwrap()
            .modified()
            .unwrap();
        let outcome = write_note(vault.path(), &name, &parsed, &parsed.content, false).unwrap();
        assert_eq!(
            outcome,
            WriteOutcome::Unchanged,
            "{name}: a no-op save writes nothing"
        );
        assert_eq!(
            fs::read(vault.path().join(&name)).unwrap(),
            before,
            "{name}"
        );
        assert_eq!(
            fs::metadata(vault.path().join(&name))
                .unwrap()
                .modified()
                .unwrap(),
            mtime,
            "{name}: mtime must not move"
        );
    }
}

#[test]
fn a_body_edit_keeps_the_frontmatter_block_and_the_line_endings() {
    let vault = copy_vault();
    let note = read_note(vault.path(), "crlf.md").unwrap().unwrap();
    let parsed = note.parse().unwrap();
    assert_eq!(parsed.eol, Eol::CrLf);
    assert!(parsed.had_trailing_newline);
    let outcome = write_note(
        vault.path(),
        "crlf.md",
        &parsed,
        "New body line one.\nLine two.",
        false,
    )
    .unwrap();
    assert_eq!(outcome, WriteOutcome::Written);
    let out = fs::read_to_string(vault.path().join("crlf.md")).unwrap();
    assert!(out.starts_with(parsed.raw_frontmatter_block.as_deref().unwrap()));
    assert!(out.ends_with("New body line one.\r\nLine two.\r\n"));

    let note = read_note(vault.path(), "no-trailing-newline.md")
        .unwrap()
        .unwrap();
    let parsed = note.parse().unwrap();
    assert!(!parsed.had_trailing_newline);
    write_note(
        vault.path(),
        "no-trailing-newline.md",
        &parsed,
        "Replaced body.\n",
        false,
    )
    .unwrap();
    let out = fs::read_to_string(vault.path().join("no-trailing-newline.md")).unwrap();
    assert!(out.ends_with("Replaced body.") && !out.ends_with('\n'));
}

#[test]
fn a_property_edit_rewrites_the_frontmatter_and_keeps_the_body() {
    let vault = copy_vault();
    let note = read_note(vault.path(), "yaml-comments.md")
        .unwrap()
        .unwrap();
    let parsed = note.parse().unwrap();
    let mut edited = parsed.clone();
    let YamlValue::Map(map) = &edited.frontmatter else {
        panic!("frontmatter is a map");
    };
    let mut map = (**map).clone();
    map.insert("status".into(), YamlValue::String("done".into()));
    edited.frontmatter = YamlValue::map(map);
    write_note(
        vault.path(),
        "yaml-comments.md",
        &edited,
        &parsed.content,
        true,
    )
    .unwrap();
    let out = fs::read_to_string(vault.path().join("yaml-comments.md")).unwrap();
    assert!(out.contains("status: done"));
    assert!(out.ends_with(&parsed.content));
}

#[test]
fn a_file_that_is_not_utf8_is_refused_and_never_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = b"---\ntitle: x\n---\nbad \xff byte\n";
    fs::write(dir.path().join("bad.md"), bytes).unwrap();
    assert!(matches!(
        read_note(dir.path(), "bad.md"),
        Err(NoteFileError::NotUtf8)
    ));
    assert_eq!(fs::read(dir.path().join("bad.md")).unwrap(), bytes);
}
