//! Deleting an attachment (`attachments::delete`, #3531 14f-3a) on a real vault: the cases of
//! Electron's `attachment-reference-scan.test.ts` and `deleteAttachment`, plus the reads that
//! keep a file because the scan could not prove nothing names it.
//!
//! | Test                                                              | Guard                        |
//! | ----------------------------------------------------------------- | ---------------------------- |
//! | a file no other note names goes to the trash                      | the delete                   |
//! | every ref shape in another note or a journal day keeps the file   | the reference scan           |
//! | a ref in another case or percent-escaped keeps the file           | lowercase and decode         |
//! | the asking note's own ref, another file, another owner do not     | the scan's needle, `exclude` |
//! | a note linked out of the vault, or not readable, keeps the file   | incomplete scan              |
//! | a locked note's file stays                                        | `writable_note`              |
//! | a name or folder that is not the note's own file is refused       | name, folder and file checks |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::attachments::{self, AttachmentError, DeletedAttachment};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::session::OpenVault;
use vault_env::{Env, env, indexed};

const FILE: &str = "k3f9x2-report.pdf";

struct Vault {
    e: Env,
    open: OpenVault,
    /// `notes/Owner.md`, whose folder holds [`FILE`].
    owner: String,
    /// `Other.md`.
    other: String,
}

impl Vault {
    /// The owner and `Other.md` (with `other` as its body) indexed, plus `extra` files.
    fn new(other: &str, extra: &[(&str, &str)]) -> Self {
        let mut e = env(|store| Some(NotesIdentity::new(store)));
        e.write("notes/Owner.md", "Owner\n");
        e.write("Other.md", other);
        for (rel, text) in extra {
            e.write(rel, text);
        }
        e.open();
        e.facts_until(indexed);
        let open = e.session.current().expect("open");
        let id = |path: &str| {
            read::get_by_path(&open, path, None)
                .unwrap()
                .expect(path)
                .id
        };
        let (owner, other) = (id("notes/Owner.md"), id("Other.md"));
        let v = Self {
            e,
            open,
            owner,
            other,
        };
        fs::create_dir_all(v.folder()).unwrap();
        fs::write(v.folder().join(FILE), b"pdf bytes").unwrap();
        v
    }

    fn folder(&self) -> PathBuf {
        self.e.vault.join("attachments").join(&self.owner)
    }

    /// Deletes `name` of the owner's folder; the trash is a folder of the test.
    fn delete(&self, name: &str) -> (Result<DeletedAttachment, AttachmentError>, Vec<PathBuf>) {
        let trashed = RefCell::new(Vec::new());
        let bin = self.e.vault.parent().unwrap().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let trash = |path: &Path| {
            let to = bin.join(path.file_name().unwrap());
            fs::rename(path, &to).map_err(|error| error.to_string())?;
            trashed.borrow_mut().push(to);
            Ok(())
        };
        let outcome = attachments::delete(&self.open, &self.owner, name, &trash);
        (outcome, trashed.into_inner())
    }

    fn kept(&self) -> bool {
        self.folder().join(FILE).is_file()
    }
}

fn kept_by(ids: &[&str]) -> DeletedAttachment {
    DeletedAttachment {
        deleted: false,
        referenced_by: ids.iter().map(|id| (*id).to_owned()).collect(),
    }
}

fn gone() -> DeletedAttachment {
    DeletedAttachment {
        deleted: true,
        referenced_by: Vec::new(),
    }
}

#[test]
fn a_file_no_other_note_names_goes_to_the_trash() {
    let v = Vault::new("Other\n", &[]);
    let (outcome, trashed) = v.delete(FILE);
    assert_eq!(outcome.unwrap(), gone());
    assert!(!v.kept());
    assert_eq!(trashed.len(), 1);
    assert_eq!(fs::read(&trashed[0]).unwrap(), b"pdf bytes");
    // Already gone: deleted, nothing more moved.
    let (outcome, trashed) = v.delete(FILE);
    assert_eq!(outcome.unwrap(), gone());
    assert!(trashed.is_empty());
}

#[test]
fn every_ref_shape_in_another_note_or_a_journal_day_keeps_the_file() {
    // The owner id is not known before the vault exists, so each body is written after.
    for shape in [
        "![r](../attachments/{owner}/{file})",
        "![r](attachments/{owner}/{file})",
        "![r](memry-file://local/Users/me/Vault/attachments/{owner}/{file})",
        "<!-- file:{\"url\":\"../attachments/{owner}/{file}\",\"name\":\"r.pdf\"} -->",
        "[r](C:\\Vault\\attachments\\{owner}\\{file})",
    ] {
        let v = Vault::new("Other\n", &[("journal/2026-01-02.md", "Day\n")]);
        let body = shape.replace("{owner}", &v.owner).replace("{file}", FILE);
        let rows = v.e.rows();
        let (day, _) = rows
            .iter()
            .find(|(_, path)| path == "journal/2026-01-02.md")
            .expect("the day's row");
        for (rel, id) in [
            ("Other.md", v.other.as_str()),
            ("journal/2026-01-02.md", day),
        ] {
            fs::write(v.e.vault.join(rel), format!("{body}\n")).unwrap();
            let (outcome, trashed) = v.delete(FILE);
            assert_eq!(outcome.unwrap(), kept_by(&[id]), "{shape} in {rel}");
            assert!(v.kept() && trashed.is_empty(), "{shape} in {rel}");
            fs::write(v.e.vault.join(rel), "No ref\n").unwrap();
        }
        assert_eq!(v.delete(FILE).0.unwrap(), gone(), "{shape}");
    }
}

#[test]
fn a_ref_in_another_case_or_percent_escaped_keeps_the_file() {
    for spelling in [
        "attachments/{owner}/K3F9X2-Report.PDF",
        "ATTACHMENTS/{OWNER}/k3f9x2-report.pdf",
        "attachments/{owner}/k3f9x2-%72eport.pdf",
        "attachments/{owner}/%4B3f9x2-report.pdf",
    ] {
        let v = Vault::new("Other\n", &[]);
        let target = spelling
            .replace("{owner}", &v.owner)
            .replace("{OWNER}", &v.owner.to_ascii_uppercase());
        let body = format!("![r](../{target})\n");
        fs::write(v.e.vault.join("Other.md"), body).unwrap();
        let (outcome, _) = v.delete(FILE);
        assert_eq!(outcome.unwrap(), kept_by(&[&v.other]), "{spelling}");
        assert!(v.kept(), "{spelling}");
    }
}

#[test]
fn the_asking_notes_own_ref_another_file_and_another_owner_do_not_keep_it() {
    let v = Vault::new("Other\n", &[]);
    let own = format!("![r](../attachments/{}/{FILE})\n", v.owner);
    fs::write(v.e.vault.join("notes/Owner.md"), own).unwrap();
    let elsewhere = format!(
        "![a](../attachments/{0}/k3f9x2-report.pdf.bak) ![b](../attachments/x{0}/{FILE}) \
         ![c](../attachments/{0}/aaaaaa-{FILE})\n",
        v.owner
    );
    fs::write(v.e.vault.join("Other.md"), elsewhere).unwrap();
    let (outcome, trashed) = v.delete(FILE);
    assert_eq!(outcome.unwrap(), gone());
    assert_eq!(trashed.len(), 1);
}

#[cfg(unix)]
fn has_row(v: &Vault, rel: &str) -> bool {
    v.e.rows().iter().any(|(_, path)| path == rel)
}

#[cfg(unix)]
#[test]
fn a_note_linked_out_of_the_vault_keeps_the_file() {
    let v = Vault::new("Other\n", &[]);
    // The scan does not read through the link, so it cannot say nothing names the file.
    let outside = v.e.vault.parent().unwrap().join("outside.md");
    fs::write(&outside, "No ref\n").unwrap();
    fs::remove_file(v.e.vault.join("Other.md")).unwrap();
    std::os::unix::fs::symlink(&outside, v.e.vault.join("Other.md")).unwrap();
    let (outcome, trashed) = v.delete(FILE);
    assert_eq!(outcome.unwrap(), kept_by(&[]));
    assert!(v.kept() && trashed.is_empty());
    assert!(has_row(&v, "Other.md"));
    // A row whose file is gone holds no reference.
    fs::remove_file(v.e.vault.join("Other.md")).unwrap();
    assert_eq!(v.delete(FILE).0.unwrap(), gone());
}

#[cfg(unix)]
#[test]
fn a_note_the_app_may_not_read_keeps_the_file() {
    use std::os::unix::fs::PermissionsExt;
    let v = Vault::new("Other\n", &[]);
    let other = v.e.vault.join("Other.md");
    // Electron skipped such a note as naming nothing.
    fs::set_permissions(&other, fs::Permissions::from_mode(0o000)).unwrap();
    let (outcome, trashed) = v.delete(FILE);
    fs::set_permissions(&other, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(outcome.unwrap(), kept_by(&[]));
    assert!(v.kept() && trashed.is_empty());
    assert!(has_row(&v, "Other.md"));
}

#[test]
fn a_locked_notes_file_stays() {
    let v = Vault::new("Other\n", &[]);
    for (kind, target) in [
        (TargetKind::Note, v.owner.as_str()),
        (TargetKind::Folder, "notes"),
    ] {
        v.open.vault.locks().set(kind, target, true).unwrap();
        let (outcome, trashed) = v.delete(FILE);
        assert!(
            matches!(outcome, Err(AttachmentError::Locked)),
            "{outcome:?}"
        );
        assert!(v.kept() && trashed.is_empty(), "{target}");
        v.open.vault.locks().set(kind, target, false).unwrap();
    }
    assert_eq!(v.delete(FILE).0.unwrap(), gone());
}

#[test]
fn a_name_or_folder_that_is_not_the_notes_own_file_is_refused() {
    let v = Vault::new("Other\n", &[]);
    fs::write(v.e.vault.join("Other.md.keep"), b"x").unwrap();
    for name in [
        "",
        ".",
        "..",
        "../../Other.md",
        "a/b.pdf",
        "a\\b.pdf",
        "x.pdf.",
    ] {
        let (outcome, trashed) = v.delete(name);
        assert!(
            matches!(outcome, Err(AttachmentError::BadReference)),
            "{name:?}: {outcome:?}"
        );
        assert!(trashed.is_empty(), "{name:?}");
    }
    let outcome = attachments::delete(&v.open, "../notes", FILE, &|_| Ok(()));
    assert!(
        matches!(outcome, Err(AttachmentError::InvalidNote)),
        "{outcome:?}"
    );
    #[cfg(unix)]
    {
        // A link in the folder, even to a file of the vault, is not the note's file.
        std::os::unix::fs::symlink(v.e.vault.join("Other.md"), v.folder().join("aaaaaa-l.md"))
            .unwrap();
        let (outcome, _) = v.delete("aaaaaa-l.md");
        assert!(
            matches!(outcome, Err(AttachmentError::FileNotFound)),
            "{outcome:?}"
        );
        assert!(v.e.vault.join("Other.md").is_file());
        // A note folder that is a link, even inside the vault, is refused.
        let real = v.e.vault.join("elsewhere");
        fs::rename(v.folder(), &real).unwrap();
        std::os::unix::fs::symlink(&real, v.folder()).unwrap();
        let (outcome, trashed) = v.delete(FILE);
        assert!(
            matches!(outcome, Err(AttachmentError::NotAFolder)),
            "{outcome:?}"
        );
        assert!(real.join(FILE).is_file() && trashed.is_empty());
    }
    assert!(v.e.vault.join("Other.md.keep").is_file());
}
