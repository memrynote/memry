//! What the directory must be, hold and sit apart from before anything in it is removed.

use super::*;

#[test]
fn a_folder_with_anything_else_in_it_is_kept_and_reported_once() {
    for extra in ["notes.txt", "resources/notes.txt", "locales/notes.txt"] {
        let machine = Machine::new();
        std::fs::write(at(&machine.nsis, extra), b"mine").unwrap();
        let mut host = machine.host();
        // Refused before anything is touched: no wait, no rename.
        host.on_wait = Some(Box::new(|_: &Path| {
            panic!("a refused folder was waited on")
        }));

        assert_eq!(
            machine.run_past_grace(&host),
            kept(Keep::ExtraEntry, true),
            "{extra}"
        );
        assert_eq!(
            machine.run(&host, T0 + GRACE_MS + 1),
            kept(Keep::ExtraEntry, false)
        );
        assert!(at(&machine.nsis, extra).exists());
        assert!(machine.nsis.join("Memrynote.exe").exists());
        assert_eq!(host.deletes(), 0);
    }
    for extra in ["Backups", "resources/Backups", "locales/Backups"] {
        let machine = Machine::new();
        std::fs::create_dir_all(at(&machine.nsis, extra)).unwrap();
        assert_eq!(
            machine.run_past_grace(&machine.host()),
            kept(Keep::ExtraEntry, true),
            "{extra}"
        );
        assert!(at(&machine.nsis, extra).exists());
    }
}

#[test]
fn a_folder_that_is_not_this_electron_install_is_kept() {
    let machine = Machine::new();
    std::fs::remove_file(machine.nsis.join("resources").join("app.asar")).unwrap();
    assert_eq!(
        machine.run_past_grace(&machine.host()),
        kept(Keep::NotElectron, true)
    );

    let machine = Machine::new();
    let elsewhere = machine.home.join("Other");
    electron_install(&elsewhere);
    let host = machine.host();
    host.registration
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .uninstall_string = registration_for(&elsewhere).uninstall_string;
    assert_eq!(machine.run_past_grace(&host), kept(Keep::NotElectron, true));
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert!(elsewhere.join("Memrynote.exe").exists());
}

#[test]
fn this_install_and_the_user_roots_are_never_taken() {
    // The registry names this app's own install, its root, or the user's home that holds it, in
    // any case.
    let machine = Machine::new();
    electron_install(&machine.velopack.join("current"));
    let upper = |path: &Path| PathBuf::from(path.to_string_lossy().to_uppercase());
    for (dir, reason) in [
        (machine.velopack.join("current"), Keep::OwnInstall),
        (upper(&machine.velopack.join("current")), Keep::OwnInstall),
        (machine.velopack.clone(), Keep::OwnInstall),
        (machine.home.clone(), Keep::OwnInstall),
    ] {
        // The upper-case spelling exists only on a case-insensitive file system.
        if !dir.exists() {
            continue;
        }
        let host = FakeHost::naming(&dir);
        std::fs::remove_file(machine.data.join(STATE_FILENAME)).ok();
        assert_eq!(machine.run_past_grace(&host), kept(reason, true), "{dir:?}");
        assert!(
            machine
                .velopack
                .join("current")
                .join("Memrynote.exe")
                .exists()
        );
        assert_eq!(host.deletes(), 0, "{dir:?}");
    }
}

#[test]
fn neither_inside_this_install_nor_above_it() {
    let machine = Machine::new();
    let inside = machine.velopack.join("packages").join("Memrynote");
    electron_install(&inside);
    let own = [machine.velopack.clone()];
    let host = FakeHost::naming(&inside);
    assert_eq!(machine.run_in(&host, T0, &own, &[]), Outcome::Waiting);
    assert_eq!(
        machine.run_in(&host, T0 + GRACE_MS, &own, &[]),
        kept(Keep::OwnInstall, true)
    );
    assert!(inside.join("Memrynote.exe").exists());

    // The Velopack root holding the running exe's folder, which alone is given.
    let machine = Machine::new();
    electron_install(&machine.velopack);
    let own = [machine.velopack.join("current")];
    let host = FakeHost::naming(&machine.velopack);
    assert_eq!(machine.run_in(&host, T0, &own, &[]), Outcome::Waiting);
    assert_eq!(
        machine.run_in(&host, T0 + GRACE_MS, &own, &[]),
        kept(Keep::OwnInstall, true)
    );
    assert!(machine.velopack.join("Memrynote.exe").exists());
}

#[test]
fn a_user_root_is_never_taken_even_when_it_holds_electron_files() {
    let machine = Machine::new();
    let documents = machine.home.join("Documents");
    electron_install(&documents);
    let host = FakeHost::naming(&documents);
    let roots = [documents.join("Notes")];
    assert_eq!(machine.run_in(&host, T0, &[], &roots), Outcome::Waiting);
    assert_eq!(
        machine.run_in(&host, T0 + GRACE_MS, &[], &roots),
        kept(Keep::UserRoot, true)
    );
    assert!(documents.join("Memrynote.exe").exists());
}

#[test]
fn a_root_that_cannot_be_compared_refuses_the_removal() {
    let machine = Machine::new();
    let host = machine.host();
    // Windows: a device path (a redirected profile on a share is the same case). A climb with
    // `..` cannot stand in there: a path pushed onto a verbatim `\\?\` base drops it.
    #[cfg(windows)]
    let roots = [PathBuf::from(r"\\.\pipe\memry-nsis-test\Notes")];
    #[cfg(not(windows))]
    let roots = [machine.home.join("gone").join("..").join("Notes")];
    assert_eq!(machine.run_in(&host, T0, &[], &roots), Outcome::Waiting);
    assert_eq!(
        machine.run_in(&host, T0 + GRACE_MS, &[], &roots),
        kept(Keep::Uncomparable, true)
    );
    assert!(machine.nsis.join("Memrynote.exe").exists());
}

#[test]
fn a_drive_root_is_never_taken() {
    let machine = Machine::new();
    #[cfg(windows)]
    let root = PathBuf::from(format!(
        "{}\\",
        std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into())
    ));
    #[cfg(not(windows))]
    let root = PathBuf::from("/");
    let host = FakeHost::naming(&root);
    assert_eq!(machine.run_in(&host, T0, &[], &[]), Outcome::Waiting);
    assert_eq!(
        machine.run_in(&host, T0 + GRACE_MS, &[], &[]),
        kept(Keep::DriveRoot, true)
    );
}

#[test]
fn a_relative_install_location_is_never_resolved() {
    let machine = Machine::new();
    let host = FakeHost {
        registration: Mutex::new(Some(Registration {
            install_location: Some(".".into()),
            uninstall_string: None,
        })),
        ..FakeHost::default()
    };
    assert_eq!(machine.run(&host, T0), kept(Keep::Relative, true));
}

#[test]
fn a_link_on_the_path_or_inside_is_kept() {
    for inside in ["locales", "resources/node_modules"] {
        let machine = Machine::new();
        let target = machine.home.join("Elsewhere");
        electron_install(&target);
        std::fs::remove_dir_all(at(&machine.nsis, inside)).unwrap();
        link_dir(&at(&machine.nsis, inside), &target);
        assert_eq!(
            machine.run_past_grace(&machine.host()),
            kept(Keep::Reparse, true),
            "{inside}"
        );
        assert!(target.join("Memrynote.exe").exists());
        assert!(machine.nsis.join("Memrynote.exe").exists());
    }

    // Reached through a linked parent.
    let machine = Machine::new();
    let linked = machine.home.join("Linked");
    link_dir(&linked, machine.nsis.parent().unwrap());
    let host = FakeHost::naming(&linked.join("Memrynote"));
    assert_eq!(machine.run_past_grace(&host), kept(Keep::Reparse, true));
    assert!(machine.nsis.join("Memrynote.exe").exists());

    // The folder itself a link.
    let machine = Machine::new();
    let linked = machine.home.join("LinkedInstall");
    link_dir(&linked, &machine.nsis);
    let host = FakeHost::naming(&linked);
    assert_eq!(machine.run_past_grace(&host), kept(Keep::Reparse, true));
    assert!(machine.nsis.join("Memrynote.exe").exists());
}

#[cfg(windows)]
#[test]
fn windows_paths_compare_as_windows_compares_them() {
    use super::layout::components;
    assert_eq!(
        components(Path::new(r"\\?\C:\Users\K\AppData")),
        components(Path::new(r"c:\users\k\appdata\"))
    );
    assert_eq!(components(Path::new(r"\\server\share\Memrynote")), None);
    assert_eq!(components(Path::new(r"\\?\UNC\server\share\x")), None);
    assert_eq!(components(Path::new(r"C:\a\..\b")), None);
}
