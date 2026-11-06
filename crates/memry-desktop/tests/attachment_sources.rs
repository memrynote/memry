//! The cover picker's sources besides an upload (#3531 14f-2b), on a real vault: the attachments
//! the vault already stores, one of them embedded by another note, and an image at a URL fetched
//! from `unsplash_server`, a local TLS server the real `reqwest` client resolves `other.example`
//! to.
//!
//! | Test                                                           | Guard                            |
//! | -------------------------------------------------------------- | -------------------------------- |
//! | the vault's attachments are listed newest first, with titles  | `listVaultAttachments`           |
//! | a link, a hidden file or a type no block shows is not listed  | `isFile`, the allowed set        |
//! | an attachments folder linked out of the vault lists nothing   | `inside_vault`                   |
//! | another note's attachment is embedded by its relative path     | `buildExistingAttachmentReference` |
//! | a reference that is not one plain name, or a link, is refused  | `isPlainSegment`, file type      |
//! | an image at a URL is fetched with a name from the URL           | `fetchRemoteImage`               |
//! | a page, an error, a hang-up or a body over the cap is refused  | type, status, 25 MiB cap         |
//! | fetched bytes land only in an indexed, unlocked note            | `save_fetched`                   |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::unsplash_server;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::attachments::{
    self, AttachmentError, AttachmentKind, MAX_REMOTE_BYTES, RemoteFailure, RemoteImages,
};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::session::OpenVault;
use unsplash_server::{Reply, serve};
use vault_env::{Env, env, indexed};

struct Vault {
    e: Env,
    open: OpenVault,
    /// `notes/Plan.md`.
    plan: String,
    /// `Other.md`.
    other: String,
}

impl Vault {
    fn new() -> Self {
        let mut e = env(|store| Some(NotesIdentity::new(store)));
        e.write("notes/Plan.md", "Plan\n");
        e.write("Other.md", "Other\n");
        e.open();
        e.facts_until(indexed);
        let open = e.session.current().expect("open");
        let id = |path: &str| {
            read::get_by_path(&open, path, None)
                .unwrap()
                .expect(path)
                .id
        };
        let (plan, other) = (id("notes/Plan.md"), id("Other.md"));
        Self {
            e,
            open,
            plan,
            other,
        }
    }

    fn folder(&self, note: &str) -> PathBuf {
        self.e.vault.join("attachments").join(note)
    }

    /// Writes `attachments/<note>/<file>`, modified `age` seconds before now.
    fn attach(&self, note: &str, file: &str, bytes: &[u8], age: u64) -> PathBuf {
        fs::create_dir_all(self.folder(note)).unwrap();
        let path = self.folder(note).join(file);
        fs::write(&path, bytes).unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(age))
            .unwrap();
        path
    }
}

fn names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn the_vaults_attachments_are_listed_newest_first_with_titles() {
    let v = Vault::new();
    assert_eq!(attachments::list_vault(&v.open).unwrap(), Vec::new());
    v.attach(&v.plan, "k3f9x2-report.pdf", b"pdf", 300);
    v.attach(&v.other, "aaaaaa-photo.png", b"png!", 10);
    v.attach("gone-note", "legacy.txt", b"t", 100);
    let listed = attachments::list_vault(&v.open).unwrap();
    let rows: Vec<(&str, Option<&str>, &str, &str, i64)> = listed
        .iter()
        .map(|e| {
            (
                e.owner_note_id.as_str(),
                e.owner_note_title.as_deref(),
                e.filename.as_str(),
                e.display_name.as_str(),
                e.size,
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            (
                v.other.as_str(),
                Some("Other"),
                "aaaaaa-photo.png",
                "photo.png",
                4
            ),
            ("gone-note", None, "legacy.txt", "legacy.txt", 1),
            (
                v.plan.as_str(),
                Some("Plan"),
                "k3f9x2-report.pdf",
                "report.pdf",
                3
            ),
        ]
    );
    assert_eq!(listed[0].kind, AttachmentKind::Image);
    assert_eq!(listed[0].mime_type, "image/png");
    // `toISOString`: UTC with milliseconds.
    assert!(
        listed[0].modified_at.ends_with('Z'),
        "{}",
        listed[0].modified_at
    );
    assert_eq!(
        listed[0].modified_at.len(),
        "2026-01-01T00:00:00.000Z".len()
    );
    let wire = serde_json::to_value(&listed[0]).unwrap();
    assert_eq!(wire["ownerNoteTitle"], "Other");
    assert_eq!(wire["type"], "image");
}

#[test]
fn a_link_a_hidden_file_or_a_type_no_block_shows_is_not_listed() {
    let v = Vault::new();
    v.attach(&v.plan, "k3f9x2-kept.pdf", b"x", 1);
    v.attach(&v.plan, ".DS_Store", b"x", 1);
    v.attach(&v.plan, "tool.exe", b"x", 1);
    fs::create_dir_all(v.folder(&v.plan).join("sub.png")).unwrap();
    fs::create_dir_all(v.e.vault.join("attachments/.hidden")).unwrap();
    fs::write(v.e.vault.join("attachments/.hidden/a.png"), b"x").unwrap();
    fs::write(v.e.vault.join("attachments/stray.png"), b"x").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.png"), b"s").unwrap();
        symlink(
            outside.path().join("secret.png"),
            v.folder(&v.plan).join("link.png"),
        )
        .unwrap();
        symlink(outside.path(), v.e.vault.join("attachments/linked")).unwrap();
        let listed = attachments::list_vault(&v.open).unwrap();
        let files: Vec<&str> = listed.iter().map(|e| e.filename.as_str()).collect();
        assert_eq!(files, ["k3f9x2-kept.pdf"]);
    }
    let listed = attachments::list_vault(&v.open).unwrap();
    assert_eq!(listed.len(), 1);
}

#[cfg(unix)]
#[test]
fn an_attachments_folder_linked_out_of_the_vault_lists_nothing() {
    use std::os::unix::fs::symlink;

    let v = Vault::new();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir_all(outside.path().join("n1")).unwrap();
    fs::write(outside.path().join("n1/a.png"), b"x").unwrap();
    let root = v.e.vault.join("attachments");
    if root.exists() {
        fs::remove_dir_all(&root).unwrap();
    }
    symlink(outside.path(), &root).unwrap();
    assert_eq!(attachments::list_vault(&v.open).unwrap(), Vec::new());
}

#[test]
fn another_notes_attachment_is_embedded_by_its_relative_path() {
    let v = Vault::new();
    v.attach(&v.other, "aaaaaa-photo.png", b"png!", 1);
    let inserted =
        attachments::insert_existing(&v.open, &v.plan, &v.other, "aaaaaa-photo.png").unwrap();
    assert_eq!(
        inserted.url,
        format!("../attachments/{}/aaaaaa-photo.png", v.other)
    );
    assert_eq!(inserted.name, "photo.png");
    assert_eq!(inserted.owner_note_id, v.other);
    assert_eq!(inserted.size, 4);
    assert_eq!(inserted.kind, AttachmentKind::Image);
    let wire = serde_json::to_value(&inserted).unwrap();
    assert_eq!(wire["ownerNoteId"], v.other.as_str());
    assert_eq!(wire["mimeType"], "image/png");

    // The owner itself: an ordinary local ref. Nothing was copied.
    let own =
        attachments::insert_existing(&v.open, &v.other, &v.other, "aaaaaa-photo.png").unwrap();
    assert_eq!(own.url, format!("attachments/{}/aaaaaa-photo.png", v.other));
    assert_eq!(names(&v.folder(&v.other)), ["aaaaaa-photo.png"]);
    assert!(!v.folder(&v.plan).exists());
}

#[test]
fn a_reference_that_is_not_one_plain_name_or_a_link_is_refused() {
    let v = Vault::new();
    v.attach(&v.other, "aaaaaa-photo.png", b"x", 1);
    for (owner, file) in [
        ("..", "x.png"),
        ("a/b", "x.png"),
        ("", "x.png"),
        (v.other.as_str(), ""),
        (v.other.as_str(), ".."),
        (v.other.as_str(), "../../Other.md"),
        (v.other.as_str(), "a\\b.png"),
        (v.other.as_str(), "aaaaaa-photo.png."),
    ] {
        let outcome = attachments::insert_existing(&v.open, &v.plan, owner, file);
        assert!(
            matches!(outcome, Err(AttachmentError::BadReference)),
            "{owner:?} {file:?}: {outcome:?}"
        );
    }
    let missing = attachments::insert_existing(&v.open, &v.plan, &v.other, "zzzzzz-gone.png");
    assert!(
        matches!(missing, Err(AttachmentError::FileNotFound)),
        "{missing:?}"
    );
    let unknown =
        attachments::insert_existing(&v.open, "not-indexed", &v.other, "aaaaaa-photo.png");
    assert!(
        matches!(unknown, Err(AttachmentError::NoteNotFound(_))),
        "{unknown:?}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.png"), b"s").unwrap();
        symlink(
            outside.path().join("secret.png"),
            v.folder(&v.other).join("out.png"),
        )
        .unwrap();
        let out = attachments::insert_existing(&v.open, &v.plan, &v.other, "out.png");
        assert!(matches!(out, Err(AttachmentError::OutsideVault)), "{out:?}");
        symlink(
            v.folder(&v.other).join("aaaaaa-photo.png"),
            v.folder(&v.other).join("in.png"),
        )
        .unwrap();
        let alias = attachments::insert_existing(&v.open, &v.plan, &v.other, "in.png");
        assert!(
            matches!(alias, Err(AttachmentError::FileNotFound)),
            "{alias:?}"
        );
    }
}

#[tokio::test]
async fn an_image_at_a_url_is_fetched_with_a_name_from_the_url() {
    let server = serve(|seen| {
        assert_eq!(seen.host, "other.example");
        Reply::image("image/png; charset=binary", b"\x89PNG-bytes")
    })
    .await;
    let remote = RemoteImages::new(server.builder()).unwrap();
    let fetched = remote
        .fetch("https://other.example/photos/Sunset%20Beach.webp?w=1")
        .await
        .unwrap();
    assert_eq!(fetched.bytes, b"\x89PNG-bytes");
    assert_eq!(fetched.filename, "Sunset-Beach.png");
    assert_eq!(server.seen()[0].target, "/photos/Sunset%20Beach.webp?w=1");
}

#[tokio::test]
async fn a_page_an_error_a_hang_up_or_a_body_over_the_cap_is_refused() {
    const OVER: usize = MAX_REMOTE_BYTES + 1;
    let server = serve(|seen| match seen.target.as_str() {
        "/page" => Reply::image("text/html", b"<html>"),
        "/untyped" => Reply::status(200),
        "/missing" => Reply::status(404),
        "/hangup" => Reply::Hangup,
        "/declared" => Reply::image("image/jpeg", &vec![b'x'; OVER]),
        "/undeclared" => Reply::Undeclared {
            head: "",
            bytes: OVER,
            tail: "",
        },
        "/at-cap" => Reply::image("image/jpeg", &vec![b'x'; MAX_REMOTE_BYTES]),
        other => panic!("unexpected {other}"),
    })
    .await;
    let remote = RemoteImages::new(server.builder()).unwrap();
    for (path, expected) in [
        ("page", RemoteFailure::NotAnImage),
        ("untyped", RemoteFailure::NotAnImage),
        ("missing", RemoteFailure::Failed),
        ("hangup", RemoteFailure::Offline),
        ("declared", RemoteFailure::TooLarge),
        ("undeclared", RemoteFailure::TooLarge),
    ] {
        let outcome = remote.fetch(&format!("https://other.example/{path}")).await;
        assert_eq!(outcome, Err(expected), "{path}");
    }
    let at_cap = remote.fetch("https://other.example/at-cap").await.unwrap();
    assert_eq!(at_cap.bytes.len(), MAX_REMOTE_BYTES);

    // Not an http(s) URL, or longer than the contract takes: refused before any request.
    let before = server.seen().len();
    let long = format!("https://other.example/{}", "a".repeat(2048));
    for url in [
        "file:///etc/hosts",
        "ftp://other.example/a.png",
        "not a url",
        long.as_str(),
    ] {
        assert_eq!(remote.fetch(url).await, Err(RemoteFailure::Failed), "{url}");
    }
    assert_eq!(server.seen().len(), before);
}

#[test]
fn fetched_bytes_land_only_in_an_indexed_unlocked_note() {
    let v = Vault::new();
    let saved = attachments::save_fetched(&v.open, &v.plan, "unsplash-abc.jpg", b"jpg").unwrap();
    let stored = saved
        .disk_path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(saved.path, format!("../attachments/{}/{stored}", v.plan));
    assert!(stored.ends_with("-unsplash-abc.jpg"));

    // No row: an absolute ref would only work on this device, so nothing is written.
    let unknown = attachments::save_fetched(&v.open, "not-indexed", "a.jpg", b"x");
    assert!(
        matches!(unknown, Err(AttachmentError::NoteNotFound(_))),
        "{unknown:?}"
    );
    assert!(!v.folder("not-indexed").exists());

    v.open
        .vault
        .locks()
        .set(TargetKind::Note, &v.other, true)
        .unwrap();
    let locked = attachments::save_fetched(&v.open, &v.other, "a.jpg", b"x");
    assert!(matches!(locked, Err(AttachmentError::Locked)), "{locked:?}");
    assert_eq!(names(&v.folder(&v.other)), Vec::<String>::new());

    // `avif` maps from the type, as in Electron, and the upload refuses it.
    let avif = attachments::save_fetched(&v.open, &v.plan, "a.avif", b"x");
    assert!(
        matches!(avif, Err(AttachmentError::UnsupportedType(_))),
        "{avif:?}"
    );
}
