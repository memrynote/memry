//! A ref that self-heal serves keeps the file (#4122 item 2, #3531 14f-3c). After a rename, a
//! note that still names the old name shows the renamed file through self-heal
//! (`shell::file_service::heal`: the same stored prefix, or the same name past it, in the URL's
//! own folder). Deleting the renamed file from its owner would trash bytes that note still shows,
//! so the delete scan counts such a ref.
//!
//! | Test                                                               | Guard                     |
//! | ------------------------------------------------------------------ | ------------------------- |
//! | a ref to the name before a rename keeps the renamed file           | the healed-ref count      |
//! | a missing name that heals by prefix or by name keeps the file      | the healed-ref count      |
//! | a name that is on disk, or in another note's folder, does not      | presence and folder rules |
//! | a name on disk only in another case still heals                    | exact-case presence       |
//! | an owner folder that cannot be listed keeps the file               | incomplete scan           |

use std::fs;

use memry_desktop::attachments;

use crate::attachment_delete::{FILE, Vault, gone, kept_by};

#[test]
fn a_ref_to_the_name_before_a_rename_keeps_the_renamed_file() {
    let v = Vault::new("Other\n", &[]);
    let old = format!("../attachments/{}/{FILE}", v.owner);
    fs::write(v.e.vault.join("Other.md"), format!("![r]({old})\n")).unwrap();
    // The owner's rename, through the command's service: the file moves, Other.md keeps the
    // old name, and self-heal serves it the renamed file.
    let renamed = attachments::rename(&v.open, &v.owner, &old, "invoice").unwrap();
    assert!(v.folder().join(&renamed.stored_filename).is_file());
    assert!(!v.folder().join(FILE).exists());
    let (outcome, trashed) = v.delete(&renamed.stored_filename);
    assert_eq!(outcome.unwrap(), kept_by(&[&v.other]));
    assert!(trashed.is_empty());
    assert!(v.folder().join(&renamed.stored_filename).is_file());
}

#[test]
fn a_missing_name_that_heals_by_prefix_or_by_name_keeps_the_file() {
    for name in [
        // The same prefix, renamed after it; a query or fragment after it too.
        "k3f9x2-old-name.pdf",
        "k3f9x2-old-name.pdf#page=2",
        // The same name past another prefix (`report.pdf`), or with no prefix at all.
        "zzzzzz-report.pdf",
        "report.pdf",
        // Another case or percent-escaped.
        "K3F9X2-Old.pdf",
        "k3f9x2-old%20name.pdf",
    ] {
        let v = Vault::new("Other\n", &[]);
        let body = format!("![r](../attachments/{}/{name})\n", v.owner);
        fs::write(v.e.vault.join("Other.md"), body).unwrap();
        let (outcome, trashed) = v.delete(FILE);
        assert_eq!(outcome.unwrap(), kept_by(&[&v.other]), "{name}");
        assert!(trashed.is_empty(), "{name}");
        assert!(v.folder().join(FILE).is_file(), "{name}");
    }
}

#[test]
fn a_name_that_is_on_disk_or_in_another_notes_folder_does_not_keep_it() {
    let v = Vault::new("Other\n", &[]);
    // `zzzzzz-report.pdf` is on disk, so self-heal never serves FILE for it.
    fs::write(v.folder().join("zzzzzz-report.pdf"), b"other bytes").unwrap();
    let body = format!(
        "![a](../attachments/{0}/zzzzzz-report.pdf) ![b](../attachments/x{0}/k3f9x2-old.pdf)\n",
        v.owner
    );
    fs::write(v.e.vault.join("Other.md"), body).unwrap();
    let (outcome, trashed) = v.delete(FILE);
    assert_eq!(outcome.unwrap(), gone());
    assert_eq!(trashed.len(), 1);
    assert!(v.folder().join("zzzzzz-report.pdf").is_file());
}

/// On a volume that tells case apart (Linux), a link to `report.pdf` beside `Report.pdf` is
/// missing, and self-heal serves it [`FILE`]. Elsewhere the link opens `Report.pdf`, and the
/// file is kept all the same.
#[test]
fn a_name_on_disk_only_in_another_case_still_heals() {
    let v = Vault::new("Other\n", &[]);
    fs::write(v.folder().join("Report.pdf"), b"other bytes").unwrap();
    let body = format!("![r](../attachments/{}/report.pdf)\n", v.owner);
    fs::write(v.e.vault.join("Other.md"), body).unwrap();
    let (outcome, trashed) = v.delete(FILE);
    assert_eq!(outcome.unwrap(), kept_by(&[&v.other]));
    assert!(trashed.is_empty());
    assert!(v.folder().join(FILE).is_file());
}

/// The scan cannot tell which names of the owner's folder are missing, so it cannot rule out a
/// healed ref: the file stays. Root reads any folder and Windows ignores the mode bits, so
/// neither can make the listing fail this way.
#[cfg(unix)]
#[test]
fn an_owner_folder_that_cannot_be_listed_keeps_the_file() {
    use std::os::unix::fs::PermissionsExt;
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let v = Vault::new("Other\n", &[]);
    fs::set_permissions(v.folder(), fs::Permissions::from_mode(0o300)).unwrap();
    let (outcome, trashed) = v.delete(FILE);
    fs::set_permissions(v.folder(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(outcome.unwrap(), kept_by(&[]));
    assert!(trashed.is_empty());
    assert!(v.folder().join(FILE).is_file());
}
