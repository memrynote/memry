//! The open-under-root rule (`shell::file_open`): what may be read through a vault-relative
//! name, on real directories with real links.

use std::cell::Cell;
use std::fs;
use std::io::Read;
use std::path::Path;

use memry_desktop::shell::file_open::{
    OpenError, Resolution, open_checked, open_under_root, resolve_under_root,
};

struct Dirs {
    _tmp: tempfile::TempDir,
    vault: std::path::PathBuf,
    outside: std::path::PathBuf,
}

fn dirs() -> Dirs {
    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path().join("vault");
    let outside = tmp.path().join("outside");
    fs::create_dir_all(vault.join("notes")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.md"), "secret").unwrap();
    fs::write(vault.join("notes/a.md"), "inside").unwrap();
    Dirs {
        _tmp: tmp,
        vault,
        outside,
    }
}

fn text(file: Option<fs::File>) -> String {
    let mut out = String::new();
    file.expect("a file").read_to_string(&mut out).unwrap();
    out
}

#[test]
fn a_file_inside_the_vault_opens_and_a_missing_one_is_none() {
    let d = dirs();
    assert_eq!(
        text(open_under_root(&d.vault, "notes/a.md").unwrap()),
        "inside"
    );
    assert!(
        open_under_root(&d.vault, "notes/missing.md")
            .unwrap()
            .is_none()
    );
    assert!(
        open_under_root(&d.vault, "nothing/at/all.md")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        resolve_under_root(&d.vault, "notes/missing.md").unwrap(),
        Resolution::Missing
    );
}

#[test]
fn parent_segments_absolute_paths_and_empty_names_are_outside() {
    let d = dirs();
    let secret = d.outside.join("secret.md");
    for rel in [
        "../outside/secret.md",
        "notes/../../outside/secret.md",
        secret.to_str().unwrap(),
        "",
        "a\0b",
    ] {
        assert!(
            matches!(open_under_root(&d.vault, rel), Err(OpenError::Outside)),
            "{rel:?}"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_prefixes_and_streams_are_outside() {
    let d = dirs();
    for rel in [
        r"\\?\C:\Windows\win.ini",
        r"\\server\share\x.md",
        r"C:\Windows\win.ini",
        r"C:win.ini",
        r"\Windows\win.ini",
        "notes/a.md:stream",
    ] {
        assert!(
            matches!(open_under_root(&d.vault, rel), Err(OpenError::Outside)),
            "{rel:?}"
        );
    }
}

#[cfg(unix)]
mod links {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn a_link_to_a_file_outside_is_refused_and_one_inside_is_followed() {
        let d = dirs();
        symlink(d.outside.join("secret.md"), d.vault.join("notes/out.md")).unwrap();
        symlink(d.vault.join("notes/a.md"), d.vault.join("notes/in.md")).unwrap();
        assert!(matches!(
            open_under_root(&d.vault, "notes/out.md"),
            Err(OpenError::Outside)
        ));
        assert_eq!(
            text(open_under_root(&d.vault, "notes/in.md").unwrap()),
            "inside"
        );
    }

    #[test]
    fn a_folder_linked_outside_hides_whether_a_file_exists_there() {
        let d = dirs();
        symlink(&d.outside, d.vault.join("linked")).unwrap();
        for rel in [
            "linked/secret.md",
            "linked/nothing.md",
            "linked/sub/nothing.md",
        ] {
            assert!(
                matches!(open_under_root(&d.vault, rel), Err(OpenError::Outside)),
                "{rel}"
            );
        }
    }

    #[test]
    fn a_dangling_link_is_outside() {
        let d = dirs();
        symlink(d.outside.join("gone.md"), d.vault.join("dangling.md")).unwrap();
        assert!(matches!(
            open_under_root(&d.vault, "dangling.md"),
            Err(OpenError::Outside)
        ));
    }

    #[test]
    fn a_vault_root_that_is_itself_a_link_still_works() {
        let d = dirs();
        let alias = d._tmp.path().join("alias");
        symlink(&d.vault, &alias).unwrap();
        assert_eq!(
            text(open_under_root(&alias, "notes/a.md").unwrap()),
            "inside"
        );
    }

    #[test]
    fn a_fifo_named_like_a_note_is_refused_without_blocking() {
        let d = dirs();
        let fifo = d.vault.join("pipe.md");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(matches!(
            open_under_root(&d.vault, "pipe.md"),
            Err(OpenError::NotRegular)
        ));
    }

    #[test]
    fn a_file_swapped_for_an_outside_link_after_the_open_is_refused() {
        let d = dirs();
        let hook_vault = d.vault.clone();
        let outside = d.outside.join("secret.md");
        let mut swap = move || {
            let path = hook_vault.join("notes/a.md");
            fs::remove_file(&path).unwrap();
            symlink(&outside, &path).unwrap();
        };
        assert!(matches!(
            open_checked(&d.vault, "notes/a.md", &mut swap),
            Err(OpenError::Outside)
        ));
    }

    #[test]
    fn a_file_replaced_by_another_inside_file_is_opened_again_and_then_gives_up() {
        let d = dirs();
        let path = d.vault.join("notes/a.md");

        // One replacement, as a save renaming a new file over the note: the retry succeeds.
        let swaps = Cell::new(0);
        let mut once = || {
            if swaps.get() == 0 {
                fs::write(d.vault.join("notes/tmp"), "replacement").unwrap();
                fs::rename(d.vault.join("notes/tmp"), &path).unwrap();
            }
            swaps.set(swaps.get() + 1);
        };
        assert_eq!(
            text(open_checked(&d.vault, "notes/a.md", &mut once).unwrap()),
            "replacement"
        );
        assert_eq!(swaps.get(), 2);

        // A file replaced every time never settles.
        let count = Cell::new(0);
        let mut always = || {
            count.set(count.get() + 1);
            fs::write(d.vault.join("notes/tmp"), "x").unwrap();
            fs::rename(d.vault.join("notes/tmp"), &path).unwrap();
        };
        assert!(matches!(
            open_checked(&d.vault, "notes/a.md", &mut always),
            Err(OpenError::KeptChanging)
        ));
        assert_eq!(count.get(), 3, "three attempts");
    }
}

#[cfg(windows)]
#[test]
fn a_junction_to_a_folder_outside_is_refused() {
    let d = dirs();
    let link = d.vault.join("junction");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&d.outside)
        .status()
        .unwrap();
    assert!(status.success());
    for rel in ["junction/secret.md", "junction/none.md"] {
        assert!(
            matches!(open_under_root(&d.vault, rel), Err(OpenError::Outside)),
            "{rel}"
        );
    }
}

#[test]
fn resolve_places_a_new_file_by_its_parent_folder() {
    let d = dirs();
    let Resolution::Missing = resolve_under_root(&d.vault, "notes/new.md").unwrap() else {
        panic!("a missing file under a real folder is Missing");
    };
    let Resolution::Inside(path) = resolve_under_root(&d.vault, "notes/a.md").unwrap() else {
        panic!("an existing file is Inside");
    };
    assert!(path.starts_with(Path::new(&d.vault)));
}
