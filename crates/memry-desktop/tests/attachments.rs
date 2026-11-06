//! A note's attachments (`memry_desktop::attachments`) on a real vault: the layout pinned against
//! Electron's `vault/attachments.ts` (`fixtures/gen-attachment-vectors.mjs`, the cases of
//! `attachments.test.ts` and more), the upload through the open vault's `note_files` rows, and
//! the names a renderer could send to climb out of the note's folder.
//!
//! | Test                                                          | Rule                              |
//! | ------------------------------------------------------------- | --------------------------------- |
//! | names, extensions, types, sizes and refs match Electron        | `attachments.ts:150-290`          |
//! | an upload lands in the note's folder, referenced from its file | `saveAttachment`, #1488           |
//! | an oversized or refused file writes nothing                    | 100 MiB cap, allowed set          |
//! | a note id that is not one plain segment writes nothing         | stricter than Electron            |
//! | an attacker's file name stays one name inside the folder       | `generateUniqueFilename`          |
//! | a link out of the vault is refused before a write through it   | `resolve_under_root`              |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;

use memry_desktop::attachments::{
    self, AttachmentError, AttachmentKind, MAX_FILE_SIZE, MAX_STORED_NAME_BYTES, extension,
    format_size, is_allowed_extension, kind_of, mime_type, relative_ref, save, stored_name,
};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::shell::file_open::is_reserved_device_name;
use serde_json::Value;
use vault_env::{env, indexed};

const VECTORS: &str = include_str!("fixtures/electron-vault/attachment-names.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn text<'a>(case: &'a Value, key: &str) -> &'a str {
    case[key].as_str().unwrap()
}

fn vault() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("memry-attachments-")
        .tempdir()
        .unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// The name after the random prefix, which is `<6 of 0-9a-z>-`.
fn after_prefix(stored: &str) -> &str {
    let (prefix, rest) = stored.split_at(7);
    assert!(
        prefix[..6]
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
            && prefix.ends_with('-'),
        "{stored:?}"
    );
    rest
}

#[test]
fn names_extensions_types_sizes_and_refs_are_electrons() {
    let vectors = vectors();
    assert_eq!(vectors["maxFileSize"].as_u64(), Some(MAX_FILE_SIZE as u64));
    for case in vectors["unique"].as_array().unwrap() {
        let name = text(case, "name");
        assert_eq!(
            after_prefix(&stored_name("abc123", name)),
            text(case, "stored"),
            "{name:?}"
        );
    }
    for case in vectors["extensions"].as_array().unwrap() {
        let name = text(case, "name");
        let ext = extension(name);
        assert_eq!(ext.to_ascii_lowercase(), text(case, "ext"), "{name:?}");
        assert_eq!(
            is_allowed_extension(ext),
            case["allowed"].as_bool().unwrap(),
            "{name:?}"
        );
        assert_eq!(mime_type(name), text(case, "mime"), "{name:?}");
        let kind = match text(case, "type") {
            "image" => AttachmentKind::Image,
            _ => AttachmentKind::File,
        };
        assert_eq!(kind_of(name), kind, "{name:?}");
    }
    for case in vectors["sizes"].as_array().unwrap() {
        let bytes = case["bytes"].as_u64().unwrap() as usize;
        assert_eq!(format_size(bytes), text(case, "text"), "{bytes}");
    }
    for case in vectors["refs"].as_array().unwrap() {
        let note_path = text(case, "notePath");
        assert_eq!(
            relative_ref(note_path, "attachments/note123/abc123-x.png"),
            text(case, "ref"),
            "{note_path:?}"
        );
    }
}

#[test]
fn an_upload_lands_in_the_notes_folder_referenced_from_its_file() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("notes/work/Meeting.md", "Agenda\n");
    e.write("Plan.md", "Plan\n");
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    let id_of = |path: &str| {
        read::get_by_path(&open, path, None)
            .unwrap()
            .expect(path)
            .id
    };
    let meeting = id_of("notes/work/Meeting.md");

    let saved = attachments::upload(&open, &meeting, "Q3 plan (final).pdf", b"%PDF-1").unwrap();
    let stored = saved.path.rsplit('/').next().unwrap().to_owned();
    assert_eq!(saved.path, format!("../../attachments/{meeting}/{stored}"));
    assert_eq!(after_prefix(&stored), "Q3-plan-final.pdf");
    assert_eq!(
        saved.disk_path,
        e.vault.join("attachments").join(&meeting).join(&stored)
    );
    assert_eq!(fs::read(&saved.disk_path).unwrap(), b"%PDF-1");
    assert_eq!(saved.name, "Q3 plan (final).pdf");
    assert_eq!(saved.size, 6);
    assert_eq!(saved.mime_type, "application/pdf");
    assert_eq!(saved.kind, AttachmentKind::File);
    // What the renderer reads: `AttachmentResult` without its envelope, no disk path.
    let wire = serde_json::to_value(&saved).unwrap();
    assert_eq!(wire["type"], "file");
    assert_eq!(wire["mimeType"], "application/pdf");
    assert!(wire.get("diskPath").is_none());

    // A note at the root names the folder as is; the same name twice is two files.
    let plan = id_of("Plan.md");
    let first = attachments::upload(&open, &plan, "shot.PNG", b"a").unwrap();
    let second = attachments::upload(&open, &plan, "shot.PNG", b"b").unwrap();
    assert!(first.path.starts_with(&format!("attachments/{plan}/")));
    assert!(first.path.ends_with("-shot.PNG"));
    assert_ne!(first.path, second.path);
    assert_eq!(first.kind, AttachmentKind::Image);
    assert_eq!(names(&e.vault.join("attachments").join(&plan)).len(), 2);

    // A note the vault has no row for is referenced by its absolute URL, as in Electron.
    let unknown = attachments::upload(&open, "not-indexed", "a.txt", b"x").unwrap();
    assert!(
        unknown.path.starts_with("memry-file://local/"),
        "{}",
        unknown.path
    );
    assert!(unknown.disk_path.is_file());
}

#[test]
fn an_oversized_or_refused_file_writes_nothing() {
    let dir = vault();
    let too_big = vec![0_u8; MAX_FILE_SIZE + 1];
    assert!(matches!(
        save(dir.path(), "n1", None, "large.png", &too_big),
        Err(AttachmentError::TooLarge { size }) if size == MAX_FILE_SIZE + 1
    ));
    for name in [
        "script.exe",
        "clip.mkv",
        "noext",
        ".png",
        "a.",
        "report.xhtml",
    ] {
        assert!(
            matches!(
                save(dir.path(), "n1", None, name, b"x"),
                Err(AttachmentError::UnsupportedType(_))
            ),
            "{name:?}"
        );
    }
    assert!(!dir.path().join("attachments").exists());

    // At the cap, a 100 MiB file is kept: far past every sync plan, it stays on this device.
    let at_cap = vec![7_u8; MAX_FILE_SIZE];
    let saved = save(dir.path(), "n1", Some("Thesis.md"), "thesis.pdf", &at_cap).unwrap();
    assert_eq!(
        fs::metadata(&saved.disk_path).unwrap().len(),
        MAX_FILE_SIZE as u64
    );
}

#[test]
fn a_note_id_that_is_not_one_plain_segment_writes_nothing() {
    let dir = vault();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    for note_id in [
        "",
        ".",
        "..",
        "../x",
        "a/b",
        "a\\b",
        "C:x",
        "x:y",
        "/abs",
        "\\\\srv\\share",
        "x.",
        "x ",
        "a\0b",
        "CON",
        "con",
        "NUL.txt",
        "Com1",
        "LPT9.md",
    ] {
        assert!(
            matches!(
                save(&root, note_id, None, "a.png", b"x"),
                Err(AttachmentError::InvalidNote)
            ),
            "{note_id:?}"
        );
    }
    assert_eq!(names(dir.path()), ["vault"]);
    assert_eq!(names(&root), Vec::<String>::new());
}

#[test]
fn an_attackers_file_name_stays_one_name_inside_the_notes_folder() {
    let dir = vault();
    let folder = dir.path().join("attachments").join("n1");
    // Electron's own cases are in the vectors; these are where it differs. A `\\` splits the
    // name on every platform, as Electron's Windows build did; a control character is a `-`.
    for (name, expected) in [
        ("../../escape.png", "escape.png"),
        ("..\\..\\evil.png", "evil.png"),
        ("C:\\Windows\\win.txt", "win.txt"),
        ("CON.png", "CON.png"),
        ("nul.txt", "nul.txt"),
        ("a\0b.png", "a-b.png"),
        ("a\u{1}\u{7f}b.png", "a-b.png"),
        ("..png", "untitled.png"),
    ] {
        let saved = save(dir.path(), "n1", Some("Note.md"), name, b"x").unwrap();
        let stored = saved.disk_path.file_name().unwrap().to_str().unwrap();
        assert_eq!(after_prefix(stored), expected, "{name:?}");
        assert_eq!(saved.disk_path.parent().unwrap(), folder, "{name:?}");
        assert!(!is_reserved_device_name(stored), "{name:?}");
        assert_eq!(saved.path, format!("attachments/n1/{stored}"));
    }
    // Only the note's folder was written.
    assert_eq!(names(dir.path()), ["attachments"]);
    assert_eq!(names(&dir.path().join("attachments")), ["n1"]);

    // A long name is cut between characters and keeps its extension.
    let long = format!("{}.png", "é".repeat(300));
    let stored = stored_name("abc123", &long);
    assert!(stored.len() <= MAX_STORED_NAME_BYTES, "{}", stored.len());
    assert!(stored.ends_with("é.png"));
    let saved = save(dir.path(), "n1", None, &long, b"x").unwrap();
    assert!(saved.disk_path.is_file());
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_vault_is_refused_before_a_write_through_it() {
    use std::os::unix::fs::symlink;

    let dir = vault();
    let root = dir.path().join("vault");
    let outside = dir.path().join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();

    // The attachments folder itself links out: no note folder is made out there.
    symlink(&outside, root.join("attachments")).unwrap();
    assert!(matches!(
        save(&root, "n1", None, "a.png", b"x"),
        Err(AttachmentError::NotAFolder)
    ));
    assert_eq!(names(&outside), Vec::<String>::new());

    // The note's folder links out: nothing is written through it.
    fs::remove_file(root.join("attachments")).unwrap();
    fs::create_dir(root.join("attachments")).unwrap();
    symlink(&outside, root.join("attachments/n1")).unwrap();
    assert!(matches!(
        save(&root, "n1", None, "a.png", b"x"),
        Err(AttachmentError::NotAFolder)
    ));
    assert_eq!(names(&outside), Vec::<String>::new());

    // A file where the folder belongs is not a folder.
    fs::write(root.join("attachments/n2"), b"file").unwrap();
    assert!(matches!(
        save(&root, "n2", None, "a.png", b"x"),
        Err(AttachmentError::NotAFolder)
    ));

    // A link that stays inside the vault is the user's own layout and is followed.
    fs::create_dir(root.join("kept")).unwrap();
    symlink(root.join("kept"), root.join("attachments/n3")).unwrap();
    let saved = save(&root, "n3", None, "a.png", b"x").unwrap();
    assert_eq!(names(&root.join("kept")).len(), 1);
    assert!(saved.disk_path.is_file());
}
