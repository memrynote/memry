use super::*;

#[test]
fn only_the_volume_roots_deleted_area_is_a_file_being_replaced() {
    for (path, deleted) in [
        (r"\\?\C:\$Extend\$Deleted\000500000000B31853FE9168", true),
        (r"\\?\C:\$extend\$deleted\1", true),
        (r"\\?\Volume{0a1b}\$Extend\$Deleted\1", true),
        (r"\\?\UNC\srv\share\$Extend\$Deleted\1", true),
        (r"C:\$Extend\$Deleted\1", true),
        (r"\\?\C:\vault\$Extend\$Deleted\1", false),
        (r"\\?\C:\$Extend\other\1", false),
        (r"\\?\C:\Users\agent\vault\notes\a.md", false),
        (r"$Extend\$Deleted\1", false),
    ] {
        assert_eq!(in_deleted_area(Path::new(path)), deleted, "{path}");
    }
}

/// A denial (os 5) or a pending delete (os 303) is asked again once, after the first
/// wait, and is the answer if it comes again. The old file's deleted-files name is asked
/// again through every wait. Any other answer is kept at once.
#[test]
fn a_denial_is_asked_again_once_and_a_deleted_name_through_every_wait() {
    let inside = || Ok(PathBuf::from(r"\\?\C:\vault\notes\a.md"));
    let deleted = || Ok(PathBuf::from(r"\\?\C:\$Extend\$Deleted\1"));
    let os = |code| move || Err(io::Error::from_raw_os_error(code));
    type Answer = Box<dyn Fn() -> io::Result<PathBuf>>;
    /// The path holds this part, or the error has this OS code.
    type Want = Result<&'static str, Option<i32>>;
    let cases: Vec<(&str, Vec<Answer>, Want, usize)> = vec![
        (
            "denied, then the file",
            vec![Box::new(os(5)), Box::new(inside)],
            Ok("notes"),
            2,
        ),
        (
            "denied twice",
            vec![Box::new(os(5)), Box::new(os(5))],
            Err(Some(5)),
            2,
        ),
        (
            "delete pending, then denied",
            vec![Box::new(os(303)), Box::new(os(5))],
            Err(Some(5)),
            2,
        ),
        (
            "deleted, then denied",
            vec![Box::new(deleted), Box::new(os(5))],
            Err(Some(5)),
            2,
        ),
        (
            "deleted, then the file",
            vec![Box::new(deleted), Box::new(inside)],
            Ok("notes"),
            2,
        ),
        (
            "deleted on every ask",
            vec![Box::new(deleted)],
            Err(None),
            RESOLVE_AGAIN_MS.len() + 1,
        ),
        (
            "outside",
            vec![Box::new(|| Ok(PathBuf::from(r"C:\other\a.md")))],
            Ok("other"),
            1,
        ),
        (
            "missing",
            vec![Box::new(os(2)), Box::new(inside)],
            Err(Some(2)),
            1,
        ),
    ];
    for (case, answers, want, asks) in cases {
        let mut asked = 0;
        let got = settle(|| {
            asked += 1;
            answers[(asked - 1).min(answers.len() - 1)]()
        });
        match (got, want) {
            (Ok(path), Ok(part)) => assert!(path.to_string_lossy().contains(part), "{case}"),
            (Err(error), Err(code)) => assert_eq!(error.raw_os_error(), code, "{case}"),
            (got, want) => panic!("{case}: {got:?}, want {want:?}"),
        }
        assert_eq!(asked, asks, "{case}");
    }
}

/// The note opened as `fs::canonicalize` opens it (no access, `FILE_FLAG_BACKUP_SEMANTICS`, every
/// share mode), so a save can rename over it while the handle is held.
fn open_as_canonicalize_does(path: &Path) -> File {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
    OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
        .unwrap()
}

/// What `fs::canonicalize` reads from the handle it opened: `GetFinalPathNameByHandleW`.
fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GETFINALPATHNAMEBYHANDLE_FLAGS, GetFinalPathNameByHandleW,
    };
    let mut buf = vec![0u16; 1024];
    // SAFETY: the handle is open for the duration of the call and `buf` is a valid out buffer.
    let len = unsafe {
        GetFinalPathNameByHandleW(
            HANDLE(file.as_raw_handle()),
            &mut buf,
            GETFINALPATHNAMEBYHANDLE_FLAGS(0),
        )
    } as usize;
    match len {
        0 => Err(io::Error::last_os_error()),
        len if len < buf.len() => Ok(PathBuf::from(OsString::from_wide(&buf[..len]))),
        len => panic!("a final path of {len} characters"),
    }
}

/// A save renames a new file over the note in the middle of a lookup (#3732). The first ask is
/// `fs::canonicalize` cut open at that moment: the note is opened as `canonicalize` opens it,
/// the save lands, then the name is read from the handle. That answer is the old file's, every
/// run: its name in the volume's deleted-files area (or an error, while it is deleted). The
/// lookup must ask again and find the new file inside the vault, never outside it and never an
/// error.
#[test]
fn a_note_renamed_over_in_the_middle_of_a_lookup_resolves_to_the_new_file() {
    let dir = tempfile::tempdir().unwrap();
    let note = dir.path().join("a.md");
    let side = dir.path().join("a.md.save");
    fs::write(&note, "old").unwrap();
    let mut asks = 0;
    let got = settle(|| {
        asks += 1;
        if asks > 1 {
            return fs::canonicalize(&note);
        }
        let opened = open_as_canonicalize_does(&note);
        fs::write(&side, "new").unwrap();
        fs::rename(&side, &note).unwrap();
        let raw = final_path(&opened);
        assert!(
            match &raw {
                Ok(real) => in_deleted_area(real),
                Err(err) => is_being_deleted(err),
            },
            "the save did not land in the middle of the ask: {raw:?}"
        );
        raw
    });
    assert_eq!(got.unwrap(), fs::canonicalize(&note).unwrap());
    assert_eq!(fs::read_to_string(&note).unwrap(), "new");
    assert_eq!(asks, 2);
}

/// The old file can also be in the middle of its deletion when the note is asked for: the name
/// still holds it, and opening it is denied. The first ask is `fs::canonicalize` while the old
/// file is marked for deletion and still open; the save then finishes. The lookup must ask again
/// once and find the new file.
#[test]
fn a_note_being_deleted_in_the_middle_of_a_lookup_resolves_to_the_new_file() {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        DELETE, FILE_DISPOSITION_INFO, FileDispositionInfo, SetFileInformationByHandle,
    };
    let dir = tempfile::tempdir().unwrap();
    let note = dir.path().join("a.md");
    fs::write(&note, "old").unwrap();
    let mut asks = 0;
    let got = settle(|| {
        asks += 1;
        if asks > 1 {
            return fs::canonicalize(&note);
        }
        let doomed = OpenOptions::new()
            .access_mode(DELETE.0)
            .open(&note)
            .unwrap();
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: the handle is open with DELETE access and `info` is the size passed.
        unsafe {
            SetFileInformationByHandle(
                HANDLE(doomed.as_raw_handle()),
                FileDispositionInfo,
                std::ptr::from_ref(&info).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        }
        .unwrap();
        let raw = fs::canonicalize(&note);
        drop(doomed);
        fs::write(&note, "new").unwrap();
        assert!(
            raw.as_ref().is_err_and(is_being_deleted),
            "the note was not being deleted in the middle of the ask: {raw:?}"
        );
        raw
    });
    assert_eq!(got.unwrap(), fs::canonicalize(&note).unwrap());
    assert_eq!(fs::read_to_string(&note).unwrap(), "new");
    assert_eq!(asks, 2);
}
