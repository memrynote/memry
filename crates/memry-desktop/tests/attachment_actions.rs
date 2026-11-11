//! The read-only attachment actions on a real vault (#3531 14f-3c): `attachments::list`
//! (`listNoteAttachments`) and `attachments::locate` / `existing` (`resolveAttachment`), which
//! the block menu, the attachments dialog, the PDF link and the missing-file card call.

use std::fs;

use memry_desktop::attachments::{self, AttachmentError, AttachmentKind};

use crate::attachment_delete::{FILE, Vault};

#[test]
fn lists_the_notes_files_without_dot_files_or_folders() {
    let v = Vault::new("Other\n", &[]);
    fs::write(v.folder().join("ab12cd-photo.png"), b"png").unwrap();
    fs::write(v.folder().join(".DS_Store"), b"x").unwrap();
    fs::create_dir(v.folder().join("sub")).unwrap();
    let mut files = attachments::list(&v.open, &v.owner).unwrap();
    files.sort_by(|a, b| a.filename.cmp(&b.filename));
    let names: Vec<_> = files.iter().map(|f| f.filename.as_str()).collect();
    assert_eq!(names, ["ab12cd-photo.png", FILE]);
    assert_eq!(files[0].kind, AttachmentKind::Image);
    assert_eq!(files[1].kind, AttachmentKind::File);
    assert_eq!(files[1].mime_type, "application/pdf");
    assert_eq!(files[1].size, 9);
    assert_eq!(files[1].path, format!("attachments/{}/{FILE}", v.owner));
    // The listed `path` is a url the other actions take.
    let at = attachments::existing(&v.open, &v.owner, &files[1].path).unwrap();
    assert_eq!(fs::read(at).unwrap(), b"pdf bytes");
}

/// A vault folder with `#` and a name with `%` or `#`: an absolute `memry-file:` URL of either
/// would parse as a fragment or a bad escape, and the dialog could not reveal or open the file.
#[test]
fn a_listed_file_resolves_under_a_folder_or_name_a_url_would_misread() {
    let v = Vault::named("C# notes", "Other\n", &[]);
    for name in ["k3f9x2-50%off.pdf", "ab12cd-a#b c.pdf", "zz99zz-100%25.pdf"] {
        fs::write(v.folder().join(name), name.as_bytes()).unwrap();
    }
    let files = attachments::list(&v.open, &v.owner).unwrap();
    assert_eq!(files.len(), 4);
    for file in files {
        let at = attachments::existing(&v.open, &v.owner, &file.path)
            .unwrap_or_else(|error| panic!("{}: {error:?}", file.path));
        assert_eq!(
            at.file_name().unwrap().to_str(),
            Some(file.filename.as_str())
        );
        assert_eq!(
            fs::read(&at).unwrap(),
            fs::read(v.folder().join(&file.filename)).unwrap()
        );
    }
}

#[test]
fn a_note_without_a_folder_has_none_and_a_bad_id_is_refused() {
    let v = Vault::new("Other\n", &[]);
    assert!(attachments::list(&v.open, &v.other).unwrap().is_empty());
    for id in ["", "..", "a/b", "a\\b"] {
        assert!(
            matches!(
                attachments::list(&v.open, id),
                Err(AttachmentError::InvalidNote)
            ),
            "{id:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_folder_linked_out_of_the_vault_is_refused() {
    let v = Vault::new("Other\n", &[]);
    let outside = v.e.vault.parent().unwrap().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("ab12cd-secret.pdf"), b"x").unwrap();
    let link = v.e.vault.join("attachments").join(&v.other);
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(matches!(
        attachments::list(&v.open, &v.other),
        Err(AttachmentError::OutsideVault)
    ));
}

#[test]
fn locates_a_ref_heals_a_renamed_one_and_reports_a_missing_one() {
    let v = Vault::new("Other\n", &[]);
    let url = |file: &str| format!("../attachments/{}/{file}", v.owner);
    let found = attachments::locate(&v.open, &v.owner, &url(FILE)).unwrap();
    assert!(found.exists);
    assert_eq!(found.stored_filename, FILE);
    // Renamed past its prefix on disk: self-heal finds it, the url keeps the old name.
    let healed = attachments::locate(&v.open, &v.owner, &url("k3f9x2-old.pdf")).unwrap();
    assert!(healed.exists);
    assert_eq!(healed.stored_filename, FILE);
    // Root-relative, as mobile writes it.
    let root = format!("attachments/{}/{FILE}", v.owner);
    assert!(
        attachments::locate(&v.open, &v.owner, &root)
            .unwrap()
            .exists
    );
    let missing = attachments::locate(&v.open, &v.owner, &url("zz99zz-gone.pdf")).unwrap();
    assert!(!missing.exists);
    assert_eq!(missing.stored_filename, "zz99zz-gone.pdf");
    assert!(missing.absolute_path.ends_with("zz99zz-gone.pdf"));
    assert!(matches!(
        attachments::existing(&v.open, &v.owner, &url("zz99zz-gone.pdf")),
        Err(AttachmentError::FileNotFound)
    ));
}

#[test]
fn a_url_out_of_the_vault_or_an_unknown_note_is_refused() {
    let v = Vault::new("Other\n", &[]);
    for (url, outside) in [
        ("../../../etc/passwd", true),
        ("https://x.test/a.png", false),
        ("/etc/passwd", false),
    ] {
        let error = attachments::locate(&v.open, &v.owner, url).unwrap_err();
        let expected = if outside {
            matches!(error, AttachmentError::OutsideVault)
        } else {
            matches!(error, AttachmentError::NotVaultRelative)
        };
        assert!(expected, "{url}: {error:?}");
    }
    assert!(matches!(
        attachments::locate(&v.open, "nope", &format!("attachments/nope/{FILE}")),
        Err(AttachmentError::NoteNotFound(_))
    ));
}
