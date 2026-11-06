//! Renaming an attachment from its block menu (`attachments::rename`, #3531 14f-2b) on a real
//! vault: the cases of Electron's `attachment-rename.test.ts`, the url shapes of
//! `resolveAttachment`, and the paths a renderer or a synced note body could use to rename
//! something outside the note's own folder.
//!
//! | Test                                                          | Guard                            |
//! | ------------------------------------------------------------- | -------------------------------- |
//! | the file moves and the block gets its new url and name        | `renameAttachment`               |
//! | every url shape names the file, a stale one through self-heal | `resolveAttachment`, #1713       |
//! | a taken name gets a suffix, the same name changes nothing     | `resolveCollision`               |
//! | a refused rename leaves the disk alone                        | owner, name, url checks          |
//! | a link out of the vault is never renamed through              | `resolve_under_root`, file type  |
//! | a link swapped in before the rename is refused                | the recheck before the rename    |
//! | the rename never replaces a file that appears at its target   | `rename_no_replace`              |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::{Path, PathBuf};

use memry_desktop::attachments::{self, AttachmentError, RenamedAttachment};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::session::OpenVault;
use vault_env::{Env, env, indexed};

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

struct Vault {
    e: Env,
    open: OpenVault,
    /// `notes/My Note.md`.
    note: String,
    /// `Other.md`.
    other: String,
}

impl Vault {
    fn new() -> Self {
        let mut e = env(|store| Some(NotesIdentity::new(store)));
        e.write("notes/My Note.md", "Body\n");
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
        let (note, other) = (id("notes/My Note.md"), id("Other.md"));
        Self {
            e,
            open,
            note,
            other,
        }
    }

    fn folder(&self, note: &str) -> PathBuf {
        self.e.vault.join("attachments").join(note)
    }

    /// Writes `attachments/<note>/<file>` with `bytes`.
    fn attach(&self, note: &str, file: &str, bytes: &[u8]) -> PathBuf {
        fs::create_dir_all(self.folder(note)).unwrap();
        let path = self.folder(note).join(file);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn rename(&self, url: &str, name: &str) -> Result<RenamedAttachment, AttachmentError> {
        attachments::rename(&self.open, &self.note, url, name)
    }
}

#[test]
fn the_file_moves_and_the_block_gets_its_new_url_and_name() {
    let v = Vault::new();
    v.attach(&v.note, "k3f9x2-scan_0031.pdf", b"pdf-bytes");
    let renamed = v
        .rename(
            &format!("../attachments/{}/k3f9x2-scan_0031.pdf", v.note),
            "Invoice March",
        )
        .unwrap();
    assert_eq!(
        renamed,
        RenamedAttachment {
            stored_filename: "k3f9x2-Invoice-March.pdf".into(),
            url: format!("../attachments/{}/k3f9x2-Invoice-March.pdf", v.note),
            name: "Invoice March.pdf".into(),
        }
    );
    assert_eq!(names(&v.folder(&v.note)), ["k3f9x2-Invoice-March.pdf"]);
    assert_eq!(
        fs::read(v.folder(&v.note).join("k3f9x2-Invoice-March.pdf")).unwrap(),
        b"pdf-bytes"
    );
    // The wire shape of `AttachmentRenameResult`.
    let wire = serde_json::to_value(&renamed).unwrap();
    assert_eq!(wire["storedFilename"], "k3f9x2-Invoice-March.pdf");
}

#[test]
fn every_url_shape_names_the_file_a_stale_one_through_self_heal() {
    let v = Vault::new();
    let disk = v.attach(&v.note, "k3f9x2-a.pdf", b"x");
    let folder = v.folder(&v.note);
    let vault_url = |file: &Path| {
        let path = file.to_string_lossy().replace('\\', "/");
        format!("memry-file://local/{}", path.trim_start_matches('/'))
    };
    let shapes = [
        // Mobile's root-relative ref, a percent-encoded one, the legacy absolute URL of this
        // vault, and the one another device wrote for its own vault.
        format!("attachments/{}/k3f9x2-a.pdf", v.note),
        format!("..%2Fattachments/{}/k3f9x2-%61.pdf", v.note),
        vault_url(&disk),
        format!(
            "memry-file://local/Users/else/Vault/attachments/{}/k3f9x2-a.pdf",
            v.note
        ),
    ];
    for (n, url) in shapes.iter().enumerate() {
        let name = format!("v{n}");
        let renamed = v.rename(url, &name).unwrap();
        assert_eq!(
            renamed.stored_filename,
            format!("k3f9x2-{name}.pdf"),
            "{url}"
        );
        assert_eq!(
            names(&folder),
            std::slice::from_ref(&renamed.stored_filename),
            "{url}"
        );
        // Back, for the next shape.
        fs::rename(folder.join(&renamed.stored_filename), &disk).unwrap();
    }

    // Renamed by hand: the block still names the old file, self-heal finds it by its prefix.
    fs::rename(&disk, folder.join("k3f9x2-renamed-by-hand.pdf")).unwrap();
    let renamed = v
        .rename(
            &format!("../attachments/{}/k3f9x2-a.pdf", v.note),
            "invoice",
        )
        .unwrap();
    assert_eq!(renamed.stored_filename, "k3f9x2-invoice.pdf");
    assert_eq!(names(&folder), ["k3f9x2-invoice.pdf"]);
}

#[test]
fn a_taken_name_gets_a_suffix_and_the_same_name_changes_nothing() {
    let v = Vault::new();
    let folder = v.folder(&v.note);
    let url = |file: &str| format!("../attachments/{}/{file}", v.note);
    v.attach(&v.note, "one.pdf", b"one");
    v.attach(&v.note, "invoice.pdf", b"kept");
    v.attach(&v.note, "invoice-2.pdf", b"kept too");
    assert_eq!(
        v.rename(&url("one.pdf"), "invoice")
            .unwrap()
            .stored_filename,
        "invoice-3.pdf"
    );
    assert_eq!(fs::read(folder.join("invoice.pdf")).unwrap(), b"kept");
    assert_eq!(fs::read(folder.join("invoice-2.pdf")).unwrap(), b"kept too");
    assert_eq!(fs::read(folder.join("invoice-3.pdf")).unwrap(), b"one");

    // The name it has: no `-2`, nothing moves.
    v.attach(&v.note, "k3f9x2-same.pdf", b"s");
    let renamed = v.rename(&url("k3f9x2-same.pdf"), "same.pdf").unwrap();
    assert_eq!(renamed.stored_filename, "k3f9x2-same.pdf");
    assert_eq!(renamed.name, "same.pdf");
    assert_eq!(
        names(&folder),
        [
            "invoice-2.pdf",
            "invoice-3.pdf",
            "invoice.pdf",
            "k3f9x2-same.pdf"
        ]
    );
}

/// What a refused rename must answer.
type Expected = fn(&AttachmentError) -> bool;

#[test]
fn a_refused_rename_leaves_the_disk_alone() {
    let v = Vault::new();
    v.attach(&v.note, "k3f9x2-scan.pdf", b"x");
    v.attach(&v.other, "k3f9x2-report.pdf", b"y");
    let own = format!("../attachments/{}/k3f9x2-scan.pdf", v.note);
    let long = "n".repeat(201);
    let refused: Vec<(String, &str, Expected)> = vec![
        // Another note's file, through this note's block.
        (
            format!("../attachments/{}/k3f9x2-report.pdf", v.other),
            "x",
            |e| matches!(e, AttachmentError::NotOwned),
        ),
        // A file of the vault outside any attachments folder.
        ("../Other.md".into(), "x", |e| {
            matches!(e, AttachmentError::NotOwned)
        }),
        (
            format!("../attachments/{}/zzzzzz-gone.pdf", v.note),
            "x",
            |e| matches!(e, AttachmentError::FileNotFound),
        ),
        (own.clone(), "   ", |e| {
            matches!(e, AttachmentError::BadName)
        }),
        (own.clone(), &long, |e| {
            matches!(e, AttachmentError::BadName)
        }),
        ("https://example.test/a.pdf".into(), "x", |e| {
            matches!(e, AttachmentError::NotVaultRelative)
        }),
        ("/etc/hosts".into(), "x", |e| {
            matches!(e, AttachmentError::NotVaultRelative)
        }),
        ("\\\\server\\share\\a.pdf".into(), "x", |e| {
            matches!(e, AttachmentError::NotVaultRelative)
        }),
        ("C:/Windows/a.pdf".into(), "x", |e| {
            matches!(e, AttachmentError::NotVaultRelative)
        }),
        ("../../../outside.pdf".into(), "x", |e| {
            matches!(e, AttachmentError::OutsideVault)
        }),
        ("..%2F..%2F..%2Foutside.pdf".into(), "x", |e| {
            matches!(e, AttachmentError::OutsideVault)
        }),
        ("memry-file://local/etc/hosts".into(), "x", |e| {
            matches!(e, AttachmentError::OutsideVault)
        }),
    ];
    for (url, name, expected) in refused {
        let outcome = v.rename(&url, name);
        assert!(
            outcome.as_ref().is_err_and(expected),
            "{url:?} {name:?}: {outcome:?}"
        );
    }
    let unknown = attachments::rename(&v.open, "not-indexed", &own, "x");
    assert!(
        matches!(unknown, Err(AttachmentError::NoteNotFound(_))),
        "{unknown:?}"
    );
    assert_eq!(names(&v.folder(&v.note)), ["k3f9x2-scan.pdf"]);
    assert_eq!(names(&v.folder(&v.other)), ["k3f9x2-report.pdf"]);
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_vault_is_never_renamed_through() {
    use std::os::unix::fs::symlink;

    let v = Vault::new();
    let outside = tempfile::Builder::new()
        .prefix("memry-outside-")
        .tempdir()
        .unwrap();
    let secret = outside.path().join("k3f9x2-secret.pdf");
    fs::write(&secret, b"secret").unwrap();

    // The file is a link out of the vault.
    fs::create_dir_all(v.folder(&v.note)).unwrap();
    symlink(&secret, v.folder(&v.note).join("k3f9x2-evil.pdf")).unwrap();
    let url = format!("../attachments/{}/k3f9x2-evil.pdf", v.note);
    let outcome = v.rename(&url, "x");
    assert!(
        matches!(outcome, Err(AttachmentError::OutsideVault)),
        "{outcome:?}"
    );

    // A link that stays in the vault is not one of the note's files either.
    let inside = v.attach(&v.other, "k3f9x2-inside.pdf", b"in");
    symlink(&inside, v.folder(&v.note).join("k3f9x2-alias.pdf")).unwrap();
    let url = format!("../attachments/{}/k3f9x2-alias.pdf", v.note);
    let outcome = v.rename(&url, "x");
    assert!(
        matches!(outcome, Err(AttachmentError::FileNotFound)),
        "{outcome:?}"
    );

    // The note's folder is a link out of the vault.
    fs::remove_dir_all(v.folder(&v.note)).unwrap();
    symlink(outside.path(), v.folder(&v.note)).unwrap();
    let url = format!("../attachments/{}/k3f9x2-secret.pdf", v.note);
    let outcome = v.rename(&url, "x");
    assert!(
        matches!(outcome, Err(AttachmentError::OutsideVault)),
        "{outcome:?}"
    );

    assert_eq!(names(outside.path()), ["k3f9x2-secret.pdf"]);
    assert_eq!(names(&v.folder(&v.other)), ["k3f9x2-inside.pdf"]);
}

/// The checks pass, then the note's folder moves out of the vault and a link to it takes its
/// place right before the rename: the recheck refuses it, and the file out there keeps its name
/// (without the recheck the rename goes through the link).
#[cfg(unix)]
#[test]
fn a_link_swapped_in_before_the_rename_is_refused() {
    use std::os::unix::fs::symlink;

    let v = Vault::new();
    let outside = tempfile::Builder::new()
        .prefix("memry-outside-")
        .tempdir()
        .unwrap();
    let moved = outside.path().join("folder");
    v.attach(&v.note, "k3f9x2-scan.pdf", b"x");
    let url = format!("../attachments/{}/k3f9x2-scan.pdf", v.note);
    let folder = v.folder(&v.note);
    let mut swapped = false;
    let outcome = attachments::rename_checked(&v.open, &v.note, &url, "invoice", &mut |_| {
        if !swapped {
            fs::rename(&folder, &moved).unwrap();
            symlink(&moved, &folder).unwrap();
            swapped = true;
        }
    });
    assert!(swapped);
    assert!(outcome.is_err(), "{outcome:?}");
    assert_eq!(names(&moved), ["k3f9x2-scan.pdf"]);
}

#[test]
fn the_rename_never_replaces_a_file_that_appears_at_its_target() {
    let v = Vault::new();
    v.attach(&v.note, "k3f9x2-scan.pdf", b"mine");
    let url = format!("../attachments/{}/k3f9x2-scan.pdf", v.note);
    let mut planted = None;
    let renamed = attachments::rename_checked(&v.open, &v.note, &url, "invoice", &mut |target| {
        if planted.is_none() {
            fs::write(target, b"theirs").unwrap();
            planted = Some(target.to_path_buf());
        }
    })
    .unwrap();
    let planted = planted.unwrap();
    assert_eq!(planted.file_name().unwrap(), "k3f9x2-invoice.pdf");
    assert_eq!(fs::read(&planted).unwrap(), b"theirs");
    assert_eq!(renamed.stored_filename, "k3f9x2-invoice-2.pdf");
    assert_eq!(
        fs::read(v.folder(&v.note).join("k3f9x2-invoice-2.pdf")).unwrap(),
        b"mine"
    );
}
