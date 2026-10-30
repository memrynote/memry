//! Finding the leftover, the wait, and one removal from start to end.

use super::*;

#[test]
fn a_found_leftover_stays_a_day_then_goes_with_its_keys() {
    let machine = Machine::new();
    let host = machine.host();

    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    assert_eq!(machine.run(&host, T0 + GRACE_MS - 1), Outcome::Waiting);
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert_eq!(host.deletes(), 0);

    assert_eq!(machine.run(&host, T0 + GRACE_MS), retired(true));
    assert!(!machine.nsis.exists());
    assert!(!machine.tombstone().exists());
    assert_eq!(host.deletes(), 1);
    assert!(!machine.data.join(STATE_FILENAME).exists());
    assert!(
        machine
            .velopack
            .join("current")
            .join("Memrynote.exe")
            .exists()
    );
    assert!(machine.nsis.parent().unwrap().exists());
}

#[test]
fn a_leftover_at_another_location_waits_its_own_day() {
    let machine = Machine::new();
    let host = machine.host();
    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    // Electron was installed again elsewhere, and the first one removed by hand.
    let moved = machine.home.join("Apps").join("Memrynote");
    electron_install(&moved);
    std::fs::remove_dir_all(&machine.nsis).unwrap();
    *host.registration.lock().unwrap() = Some(registration_for(&moved));
    assert_eq!(machine.run(&host, T0 + GRACE_MS), Outcome::Waiting);
    assert!(moved.join("Memrynote.exe").exists());
    assert_eq!(machine.run(&host, T0 + 2 * GRACE_MS), retired(true));
}

#[test]
fn a_clock_that_ran_ahead_restarts_the_wait() {
    let machine = Machine::new();
    let host = machine.host();
    // Found while the clock was ten days fast, then the clock was put right.
    assert_eq!(machine.run(&host, T0 + 10 * GRACE_MS), Outcome::Waiting);
    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    assert_eq!(machine.state().first_seen_at, Some(T0));
    assert_eq!(machine.run(&host, T0 + GRACE_MS), retired(true));
}

#[test]
fn the_uninstallers_folder_stands_in_for_a_missing_install_location() {
    let machine = Machine::new();
    let host = machine.host();
    host.registration
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .install_location = None;
    assert_eq!(machine.run_past_grace(&host), retired(true));
    assert!(!machine.nsis.exists());
    assert_eq!(host.deletes(), 1);
}

#[test]
fn a_process_running_from_it_keeps_it_until_a_later_launch() {
    let machine = Machine::new();
    let host = machine.host();
    host.busy.store(1, Ordering::SeqCst);

    assert_eq!(machine.run_past_grace(&host), kept(Keep::InUse, true));
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert_eq!(machine.run(&host, T0 + GRACE_MS + 1), retired(true));
    assert!(!machine.nsis.exists());
}

#[test]
fn a_file_that_appears_before_the_rename_puts_the_folder_back() {
    let machine = Machine::new();
    let mut host = machine.host();
    host.on_wait = Some(Box::new(|dir: &Path| {
        std::fs::write(dir.join("arrived.txt"), b"x").unwrap();
    }));

    assert_eq!(machine.run_past_grace(&host), kept(Keep::ExtraEntry, true));
    assert!(machine.nsis.join("arrived.txt").exists());
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert!(!machine.tombstone().exists());
    assert_eq!(machine.state().tombstone, None);
    assert_eq!(host.deletes(), 0);
}

#[cfg(unix)]
#[test]
fn a_rename_without_the_right_to_is_access_denied_not_in_use() {
    use std::os::unix::fs::PermissionsExt;
    let machine = Machine::new();
    let programs = machine.nsis.parent().unwrap().to_owned();
    let mut host = machine.host();
    let locked = programs.clone();
    host.on_wait = Some(Box::new(move |_: &Path| {
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    }));

    let outcome = machine.run_past_grace(&host);
    std::fs::set_permissions(&programs, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(outcome, kept(Keep::AccessDenied, true));
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert_eq!(
        (machine.state().origin, machine.state().tombstone),
        (None, None)
    );
}

#[cfg(unix)]
#[test]
fn nothing_is_renamed_before_the_removal_is_recorded() {
    use std::os::unix::fs::PermissionsExt;
    let machine = Machine::new();
    let mut host = machine.host();
    let data = machine.data.clone();
    host.on_wait = Some(Box::new(move |_: &Path| {
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o555)).unwrap();
    }));

    let outcome = machine.run_past_grace(&host);
    std::fs::set_permissions(&machine.data, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(outcome, Outcome::Waiting);
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert!(!machine.tombstone().exists());
}

#[cfg(windows)]
#[test]
fn a_file_open_in_it_makes_the_rename_fail_as_in_use() {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_READ only, as most programs open a file: no delete or rename below it.
    const FILE_SHARE_READ: u32 = 1;
    let machine = Machine::new();
    let held = std::sync::Arc::new(Mutex::new(None));
    let slot = held.clone();
    let mut host = machine.host();
    host.on_wait = Some(Box::new(move |dir: &Path| {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(dir.join("resources").join("app.asar"))
            .unwrap();
        *slot.lock().unwrap() = Some(file);
    }));

    let outcome = machine.run_past_grace(&host);
    drop(held.lock().unwrap().take());
    assert_eq!(outcome, kept(Keep::InUse, true));
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert_eq!(
        (machine.state().origin, machine.state().tombstone),
        (None, None)
    );
}

#[test]
fn a_pending_nsis_restore_keeps_it_and_its_keys() {
    // The backup beside it.
    let machine = Machine::new();
    let backup = machine.nsis.with_file_name("Memrynote.update-backup");
    std::fs::create_dir_all(&backup).unwrap();
    assert_eq!(
        machine.run(&machine.host(), T0),
        kept(Keep::BackupPending, true)
    );
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert!(backup.exists());

    // Mid-update: the install moved into the backup, its folder missing.
    let machine = Machine::new();
    let backup = machine.nsis.with_file_name("Memrynote.update-backup");
    std::fs::rename(&machine.nsis, &backup).unwrap();
    let host = machine.host();
    assert_eq!(machine.run(&host, T0), kept(Keep::BackupPending, true));
    assert_eq!(host.deletes(), 0);

    // The `RunOnce` restore armed, the backup already copied back.
    let machine = Machine::new();
    let host = FakeHost {
        restore: true,
        ..machine.host()
    };
    assert_eq!(machine.run(&host, T0), kept(Keep::BackupPending, true));
    std::fs::remove_dir_all(&machine.nsis).unwrap();
    assert_eq!(machine.run(&host, T0 + 1), kept(Keep::BackupPending, false));
    assert_eq!(host.deletes(), 0);
}

#[test]
fn keys_whose_files_are_gone_are_removed() {
    let machine = Machine::new();
    std::fs::remove_dir_all(&machine.nsis).unwrap();
    let host = machine.host();
    assert_eq!(machine.run(&host, T0), retired(false));
    assert_eq!(host.deletes(), 1);
}

#[test]
fn keys_whose_uninstaller_is_still_there_stay() {
    let machine = Machine::new();
    let elsewhere = machine.home.join("Other");
    electron_install(&elsewhere);
    std::fs::remove_dir_all(&machine.nsis).unwrap();
    let host = machine.host();
    host.registration
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .uninstall_string = registration_for(&elsewhere).uninstall_string;
    assert_eq!(machine.run(&host, T0), kept(Keep::NotElectron, true));
    assert_eq!(host.deletes(), 0);
}

#[test]
fn keys_on_a_drive_that_is_not_attached_stay() {
    let machine = Machine::new();
    let host = FakeHost::naming(&machine.home.join("Unplugged").join("Memrynote"));
    assert_eq!(machine.run(&host, T0), kept(Keep::Offline, true));
    assert_eq!(host.deletes(), 0);
}

#[test]
fn a_per_machine_install_is_reported_once_and_left() {
    let machine = Machine::new();
    let host = FakeHost {
        per_machine: true,
        ..FakeHost::default()
    };
    assert_eq!(machine.run(&host, T0), kept(Keep::PerMachine, true));
    assert_eq!(machine.run(&host, T0 + 1), kept(Keep::PerMachine, false));
}

#[test]
fn nothing_left_clears_the_record() {
    let machine = Machine::new();
    assert_eq!(machine.run(&machine.host(), T0), Outcome::Waiting);
    assert!(machine.data.join(STATE_FILENAME).exists());

    assert_eq!(machine.run(&FakeHost::default(), T0 + 1), Outcome::None);
    assert!(!machine.data.join(STATE_FILENAME).exists());
}

#[test]
fn taskbar_pins_into_it_are_counted() {
    let machine = Machine::new();
    // A shortcut keeps its target as UTF-16; the pin's case need not match the registry's.
    let target = machine
        .nsis
        .join("Memrynote.exe")
        .to_string_lossy()
        .to_uppercase();
    let mut pin = b"L\0\0\0header".to_vec();
    pin.extend(target.encode_utf16().flat_map(u16::to_le_bytes));
    std::fs::write(machine.pins.join("MemryNote.lnk"), pin).unwrap();
    std::fs::write(machine.pins.join("Other.lnk"), b"C:\\Other\\app.exe").unwrap();

    assert_eq!(
        machine.run_past_grace(&machine.host()),
        Outcome::Retired {
            stale_pins: 1,
            files: true
        }
    );
}

#[test]
fn the_uninstall_string_is_read_as_nsis_writes_it() {
    let registration = Registration {
        install_location: None,
        uninstall_string: Some(
            r#""C:\Users\Kağan & Co\AppData\Local\Programs\Memrynote\Uninstall Memrynote.exe" /currentuser"#
                .into(),
        ),
    };
    assert_eq!(
        registration.uninstaller().unwrap().to_string_lossy(),
        r"C:\Users\Kağan & Co\AppData\Local\Programs\Memrynote\Uninstall Memrynote.exe"
    );
    for broken in ["", "unquoted.exe /S", "\"no end", "\"\" /S"] {
        let registration = Registration {
            install_location: None,
            uninstall_string: Some(broken.into()),
        };
        assert_eq!(registration.uninstaller(), None, "{broken}");
    }
}
