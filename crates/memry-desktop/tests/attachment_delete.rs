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
//! | a scan before the open walk ended, or after a capped one, keeps it | the walk gate               |
//! | a scan while a new exclude pattern's walk runs keeps the file     | the walk gate, cleared       |
//! | a scan while a found file waits for its retry keeps the file      | a clean walk                 |
//! | a locked note's file stays                                        | `writable_note`              |
//! | a name or folder that is not the note's own file is refused       | name, folder and file checks |
//! | a note folder swapped for a link right before the move is refused | the folder recheck           |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::attachments::{self, AttachmentError, DeletedAttachment};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::session::OpenVault;
use memry_desktop::vault::config::{VaultConfigPatch, config_path};
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::identity::NoteIdentity;
use vault_env::{Env, creates, env, env_named, indexed};

use crate::index_support::until;
use crate::vault_settings::update;

pub(crate) const FILE: &str = "k3f9x2-report.pdf";

pub(crate) struct Vault {
    pub(crate) e: Env,
    pub(crate) open: OpenVault,
    /// `notes/Owner.md`, whose folder holds [`FILE`].
    pub(crate) owner: String,
    /// `Other.md`.
    pub(crate) other: String,
}

impl Vault {
    /// The owner and `Other.md` (with `other` as its body) indexed, plus `extra` files.
    pub(crate) fn new(other: &str, extra: &[(&str, &str)]) -> Self {
        Self::named("vault", other, extra)
    }

    /// [`Self::new`] with the vault in a folder called `name`.
    pub(crate) fn named(name: &str, other: &str, extra: &[(&str, &str)]) -> Self {
        let mut e = env_named(name, |store| Some(NotesIdentity::new(store)));
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

    pub(crate) fn folder(&self) -> PathBuf {
        self.e.vault.join("attachments").join(&self.owner)
    }

    /// Deletes `name` of the owner's folder; the trash is a folder of the test.
    pub(crate) fn delete(
        &self,
        name: &str,
    ) -> (Result<DeletedAttachment, AttachmentError>, Vec<PathBuf>) {
        delete_in(&self.e, &self.open, &self.owner, name, &mut |_| {})
    }

    fn kept(&self) -> bool {
        self.folder().join(FILE).is_file()
    }

    /// The id of the row at `rel`.
    fn row_id(&self, rel: &str) -> String {
        let rows = self.e.rows();
        let (id, _) = rows.iter().find(|(_, path)| path == rel).expect(rel);
        id.clone()
    }
}

/// Deletes `name` of `owner`'s folder, `before_recheck` run right before the last folder check;
/// the trash is a folder of the test.
fn delete_in(
    e: &Env,
    open: &OpenVault,
    owner: &str,
    name: &str,
    before_recheck: &mut dyn FnMut(&Path),
) -> (Result<DeletedAttachment, AttachmentError>, Vec<PathBuf>) {
    let trashed = RefCell::new(Vec::new());
    let bin = e.vault.parent().unwrap().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let trash = |path: &Path| {
        let to = bin.join(path.file_name().unwrap());
        fs::rename(path, &to).map_err(|error| error.to_string())?;
        trashed.borrow_mut().push(to);
        Ok(())
    };
    let rows = e.tier.rows();
    let outcome = attachments::delete_checked(open, &rows, owner, name, before_recheck, &trash);
    (outcome, trashed.into_inner())
}

pub(crate) fn kept_by(ids: &[&str]) -> DeletedAttachment {
    DeletedAttachment {
        deleted: false,
        referenced_by: ids.iter().map(|id| (*id).to_owned()).collect(),
    }
}

pub(crate) fn gone() -> DeletedAttachment {
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
    // The owner id is not known before the vault exists, so each body is written after. Each
    // shape holds the `attachments/<owner>/<file>` run, which Electron finds as a substring.
    const CV: &str = "k3f9x2-kaan's-cv.pdf";
    let marker = |file: &str| {
        format!("<!-- file:{{\"url\":\"../attachments/{{owner}}/{file}\",\"name\":\"r.pdf\"}} -->")
    };
    let shapes = [
        ("![r](../attachments/{owner}/{file})".to_owned(), FILE),
        ("![r](attachments/{owner}/{file})".to_owned(), FILE),
        (
            "![r](memry-file://local/Users/me/Vault/attachments/{owner}/{file})".to_owned(),
            FILE,
        ),
        (marker("{file}"), FILE),
        (
            "[r](C:\\Vault\\attachments\\{owner}\\{file})".to_owned(),
            FILE,
        ),
        ("![[attachments/{owner}/{file}]]".to_owned(), FILE),
        ("![[attachments/{owner}/{file}|300]]".to_owned(), FILE),
        (
            "---\ncover: \"[[attachments/{owner}/{file}]]\"\n---\nDay".to_owned(),
            FILE,
        ),
        ("![r](../attachments/{owner}/{file}?v=2)".to_owned(), FILE),
        ("[r](../attachments/{owner}/{file}#page=3)".to_owned(), FILE),
        ("see attachments/{owner}/{file}.".to_owned(), FILE),
        ("**attachments/{owner}/{file}**".to_owned(), FILE),
        // Names the app made: an apostrophe, a literal `%XX`, a space inside a file marker.
        ("[r](../attachments/{owner}/{file})".to_owned(), CV),
        (marker("{file}"), CV),
        (
            "[r](../attachments/{owner}/{file})".to_owned(),
            "k3f9x2-q3%20plan.pdf",
        ),
        (
            "[r](../attachments/{owner}/{file})".to_owned(),
            "k3f9x2-a%41.pdf",
        ),
        (marker("{file}"), "k3f9x2-q3 plan.pdf"),
    ];
    let v = Vault::new("Other\n", &[("journal/2026-01-02.md", "Day\n")]);
    let day = v.row_id("journal/2026-01-02.md");
    for (shape, file) in &shapes {
        fs::write(v.folder().join(file), b"pdf bytes").unwrap();
        let body = shape.replace("{owner}", &v.owner).replace("{file}", file);
        for (rel, id) in [
            ("Other.md", v.other.as_str()),
            ("journal/2026-01-02.md", &day),
        ] {
            fs::write(v.e.vault.join(rel), format!("{body}\n")).unwrap();
            let (outcome, trashed) = v.delete(file);
            assert_eq!(outcome.unwrap(), kept_by(&[id]), "{body} in {rel}");
            assert!(v.folder().join(file).is_file(), "{body} in {rel}");
            assert!(trashed.is_empty(), "{body} in {rel}");
            fs::write(v.e.vault.join(rel), "No ref\n").unwrap();
        }
        assert_eq!(v.delete(file).0.unwrap(), gone(), "{body}");
    }
    // A body that spells a `%XX` name decoded, here with its space, names the file too.
    let file = "k3f9x2-q3%20plan.pdf";
    fs::write(v.folder().join(file), b"pdf bytes").unwrap();
    let body = marker("k3f9x2-q3 plan.pdf").replace("{owner}", &v.owner);
    fs::write(v.e.vault.join("Other.md"), format!("{body}\n")).unwrap();
    assert_eq!(v.delete(file).0.unwrap(), kept_by(&[&v.other]), "{body}");
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
        "![b](../attachments/x{0}/{FILE}) ![c](../attachments/{0}/aaaaaa-{FILE})\n",
        v.owner
    );
    fs::write(v.e.vault.join("Other.md"), elsewhere).unwrap();
    let (outcome, trashed) = v.delete(FILE);
    assert_eq!(outcome.unwrap(), gone());
    assert_eq!(trashed.len(), 1);
    // A longer name that begins with the file's keeps it, as Electron's substring search does:
    // the safe direction.
    fs::write(v.folder().join(FILE), b"pdf bytes").unwrap();
    let longer = format!("![a](../attachments/{}/{FILE}.bak)\n", v.owner);
    fs::write(v.e.vault.join("Other.md"), longer).unwrap();
    let (outcome, trashed) = v.delete(FILE);
    assert_eq!(outcome.unwrap(), kept_by(&[&v.other]));
    assert!(v.kept() && trashed.is_empty());
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
        v.open
            .vault
            .locks()
            .set(kind, target, true, "device-a")
            .unwrap();
        let (outcome, trashed) = v.delete(FILE);
        assert!(
            matches!(outcome, Err(AttachmentError::Locked)),
            "{outcome:?}"
        );
        assert!(v.kept() && trashed.is_empty(), "{target}");
        v.open
            .vault
            .locks()
            .set(kind, target, false, "device-a")
            .unwrap();
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
    let rows = v.e.tier.rows();
    let outcome = attachments::delete(&v.open, &rows, "../notes", FILE, &|_| Ok(()));
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

/// A note on disk with no row yet goes unread, so the scan is not complete until the open walk
/// gave every file a row.
#[test]
fn a_scan_before_the_open_walk_ended_or_after_a_capped_one_keeps_the_file() {
    const OWNER: &str = "0123456789abcdef0123456789abcdef";
    let late = format!("![r](../attachments/{OWNER}/{FILE})\n");
    let put_file = |e: &Env| {
        fs::create_dir_all(e.vault.join("attachments").join(OWNER)).unwrap();
        fs::write(e.vault.join("attachments").join(OWNER).join(FILE), b"pdf").unwrap();
    };
    let kept = |e: &Env| e.vault.join("attachments").join(OWNER).join(FILE).is_file();

    // The walk is held inside its offer of `Late.md`, which has no row yet.
    let mut made = None;
    let mut e = env(|store| {
        let identity = creates(store);
        identity.hold();
        made = Some(identity.clone());
        Some(identity as Arc<dyn NoteIdentity>)
    });
    let made = made.unwrap();
    e.write("Late.md", &late);
    put_file(&e);
    e.open();
    until("the walk to offer Late.md", || {
        made.offered
            .lock()
            .unwrap()
            .iter()
            .any(|path| path == "Late.md")
    });
    let open = e.session.current().expect("open");
    assert!(e.rows().is_empty());
    let (outcome, trashed) = delete_in(&e, &open, OWNER, FILE, &mut |_| {});
    assert_eq!(outcome.unwrap(), kept_by(&[]));
    assert!(kept(&e) && trashed.is_empty());
    made.release();
    let facts = e.facts_until(indexed);
    assert!(matches!(
        facts.last(),
        Some(Applied::Indexed { complete: true })
    ));
    let late_id = e.rows()[0].0.clone();
    let (outcome, _) = delete_in(&e, &open, OWNER, FILE, &mut |_| {});
    assert_eq!(outcome.unwrap(), kept_by(&[&late_id]));

    // A walk that leaves files without a row (here an identity that adopts nothing, as a capped
    // walk leaves the rest) never completes the scan.
    let mut e = env(|_| None);
    e.write("Late.md", &late);
    put_file(&e);
    e.open();
    let facts = e.facts_until(indexed);
    assert!(matches!(
        facts.last(),
        Some(Applied::Indexed { complete: false })
    ));
    let open = e.session.current().expect("open");
    assert!(e.rows().is_empty());
    let (outcome, trashed) = delete_in(&e, &open, OWNER, FILE, &mut |_| {});
    assert_eq!(outcome.unwrap(), kept_by(&[]));
    assert!(kept(&e) && trashed.is_empty());
}

/// An env of `Late.md`, whose body names `OWNER`'s [`FILE`], and that file, with the identity
/// [`creates`] makes (and hands back).
fn late_vault(config: Option<&str>, late_at: &str) -> (Env, Arc<vault_env::Creates>) {
    let mut made = None;
    let e = env(|store| {
        let identity = creates(store);
        made = Some(identity.clone());
        Some(identity as Arc<dyn NoteIdentity>)
    });
    if let Some(config) = config {
        fs::create_dir_all(e.vault.join(".memry")).unwrap();
        fs::write(config_path(&e.vault), config).unwrap();
    }
    e.write(late_at, &format!("![r](../attachments/{OWNER}/{FILE})\n"));
    fs::create_dir_all(e.vault.join("attachments").join(OWNER)).unwrap();
    fs::write(e.vault.join("attachments").join(OWNER).join(FILE), b"pdf").unwrap();
    (e, made.unwrap())
}

const OWNER: &str = "0123456789abcdef0123456789abcdef";

fn late_kept(e: &Env) -> bool {
    e.vault.join("attachments").join(OWNER).join(FILE).is_file()
}

/// An exclude pattern dropped walks the vault again: the folder it no longer drops has no rows
/// until that walk gives them, so the earlier walk's end no longer completes the scan.
#[test]
fn a_scan_while_a_new_exclude_patterns_walk_runs_keeps_the_file() {
    let (mut e, made) = late_vault(Some(r#"{"excludePatterns":["archive"]}"#), "archive/ref.md");
    e.open();
    let facts = e.facts_until(indexed);
    assert!(matches!(
        facts.last(),
        Some(Applied::Indexed { complete: true })
    ));
    assert!(e.rows().is_empty());
    made.hold();
    let patch = VaultConfigPatch {
        exclude_patterns: Some(Vec::new()),
        ..VaultConfigPatch::default()
    };
    update(&e, patch, |_| {}).unwrap();
    until("the new walk to offer archive/ref.md", || {
        made.offered
            .lock()
            .unwrap()
            .iter()
            .any(|path| path == "archive/ref.md")
    });
    let open = e.session.current().expect("open");
    assert!(e.rows().is_empty());
    let (outcome, trashed) = delete_in(&e, &open, OWNER, FILE, &mut |_| {});
    assert_eq!(outcome.unwrap(), kept_by(&[]));
    assert!(late_kept(&e) && trashed.is_empty());
    made.release();
    e.facts_until(indexed);
    let ref_id = e.rows()[0].0.clone();
    let (outcome, _) = delete_in(&e, &open, OWNER, FILE, &mut |_| {});
    assert_eq!(outcome.unwrap(), kept_by(&[&ref_id]));
}

/// A walk ends complete while a file it found failed to get its note: that file has no row
/// until its retry lands, and only then does the scan read it.
#[test]
fn a_scan_while_a_found_file_waits_for_its_retry_keeps_the_file() {
    let (mut e, made) = late_vault(None, "Late.md");
    *made.failures.lock().unwrap() = 1;
    // The retry waits; the walk's own offer fails at once.
    made.hold();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(matches!(
        facts.last(),
        Some(Applied::Indexed { complete: true })
    ));
    let open = e.session.current().expect("open");
    assert!(e.rows().is_empty());
    let (outcome, trashed) = delete_in(&e, &open, OWNER, FILE, &mut |_| {});
    assert_eq!(outcome.unwrap(), kept_by(&[]));
    assert!(late_kept(&e) && trashed.is_empty());
    made.release();
    until("the retry to give Late.md its row", || !e.rows().is_empty());
    let late_id = e.rows()[0].0.clone();
    until("the scan to read Late.md", || {
        delete_in(&e, &open, OWNER, FILE, &mut |_| {}).0.unwrap() == kept_by(&[&late_id])
    });
}

#[cfg(unix)]
#[test]
fn a_note_folder_swapped_for_a_link_right_before_the_move_is_refused() {
    let v = Vault::new("Other\n", &[]);
    let real = v.e.vault.join("elsewhere");
    let (outcome, trashed) = delete_in(&v.e, &v.open, &v.owner, FILE, &mut |_| {
        fs::rename(v.folder(), &real).unwrap();
        std::os::unix::fs::symlink(&real, v.folder()).unwrap();
    });
    assert!(
        matches!(outcome, Err(AttachmentError::NotAFolder)),
        "{outcome:?}"
    );
    assert!(real.join(FILE).is_file() && trashed.is_empty());
}
