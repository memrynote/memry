//! A removal an earlier launch recorded and did not finish: resumed only from the tombstone it
//! recorded, after the same checks, and never from anything else.

use super::*;

#[test]
fn a_removal_cut_short_resumes_from_its_recorded_tombstone() {
    let machine = Machine::new();
    let host = machine.host();
    // The last launch renamed the directory and deleted part of it, anchors included.
    let tombstone = machine.renamed(&host);
    std::fs::remove_file(tombstone.join("Memrynote.exe")).unwrap();
    std::fs::remove_dir_all(tombstone.join("resources")).unwrap();

    assert_eq!(machine.run(&host, T0 + 1), retired(true));
    assert!(!tombstone.exists());
    assert_eq!(host.deletes(), 1);
    assert_eq!(machine.state(), LeftoverState::default());
}

#[test]
fn a_recorded_tombstone_that_was_never_renamed_to_starts_over() {
    let machine = Machine::new();
    let host = machine.host();
    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    machine.record(&machine.nsis, &machine.tombstone());

    assert_eq!(machine.run(&host, T0 + GRACE_MS), retired(true));
    assert!(!machine.nsis.exists());
}

#[test]
fn a_tombstone_this_app_did_not_record_is_left_alone() {
    let machine = Machine::new();
    let stranger = machine.tombstone();
    std::fs::create_dir_all(&stranger).unwrap();
    std::fs::write(stranger.join("keep.txt"), b"x").unwrap();

    assert_eq!(
        machine.run_past_grace(&machine.host()),
        kept(Keep::StaleTombstone, true)
    );
    assert!(stranger.join("keep.txt").exists());
    assert!(machine.nsis.join("Memrynote.exe").exists());
}

#[test]
fn a_recorded_tombstone_that_is_not_the_origins_is_never_touched() {
    // A record that names another folder as the tombstone, or no origin at all.
    let machine = Machine::new();
    let host = machine.host();
    let victim = machine.home.join("Victim");
    electron_install(&victim);
    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    machine.record(&machine.nsis, &victim);
    assert_eq!(machine.run(&host, T0 + 1), kept(Keep::StaleTombstone, true));
    assert!(victim.join("Memrynote.exe").exists());

    let mut state = machine.state();
    state.origin = None;
    state.tombstone = Some(machine.tombstone().to_string_lossy().into_owned());
    state::write(&machine.data, &state).unwrap();
    std::fs::rename(&machine.nsis, machine.tombstone()).unwrap();
    assert_eq!(
        machine.run(&host, T0 + GRACE_MS),
        kept(Keep::StaleTombstone, false)
    );
    assert!(machine.tombstone().join("Memrynote.exe").exists());
    assert_eq!(host.deletes(), 0);
}

#[test]
fn a_recorded_tombstone_is_checked_again_before_it_is_deleted() {
    // Something was added to it since the rename.
    let machine = Machine::new();
    let host = machine.host();
    let tombstone = machine.renamed(&host);
    std::fs::write(tombstone.join("notes.txt"), b"mine").unwrap();
    assert_eq!(machine.run(&host, T0 + 1), kept(Keep::ExtraEntry, true));
    assert!(tombstone.join("notes.txt").exists());

    // Reached through a link: a record whose path is not the folder it names on disk.
    let machine = Machine::new();
    let host = machine.host();
    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    let real = machine.home.join("Real");
    electron_install(&real.join("Memrynote.memry-retired"));
    let linked = machine.home.join("Linked");
    link_dir(&linked, &real);
    machine.record(
        &linked.join("Memrynote"),
        &linked.join("Memrynote.memry-retired"),
    );
    assert_eq!(machine.run(&host, T0 + 1), kept(Keep::Reparse, true));
    assert!(
        real.join("Memrynote.memry-retired")
            .join("Memrynote.exe")
            .exists()
    );

    // Holding one of the user's roots.
    let machine = Machine::new();
    let host = machine.host();
    let tombstone = machine.renamed(&host);
    let roots = [tombstone.join("resources")];
    assert_eq!(
        machine.run_in(&host, T0 + 1, &[], &roots),
        kept(Keep::UserRoot, true)
    );
    assert!(tombstone.join("Memrynote.exe").exists());
}

#[test]
fn an_install_made_again_at_the_same_path_neither_blocks_nor_loses_its_keys() {
    let machine = Machine::new();
    let host = machine.host();
    let tombstone = machine.renamed(&host);
    electron_install(&machine.nsis);

    assert_eq!(machine.run(&host, T0 + 1), retired(true));
    assert!(!tombstone.exists());
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert_eq!(host.deletes(), 0);
    // The new install is a leftover of its own, found afresh.
    assert_eq!(machine.run(&host, T0 + 2), Outcome::Waiting);
    assert_eq!(machine.run(&host, T0 + 2 + GRACE_MS), retired(true));
    assert_eq!(host.deletes(), 1);
}

#[test]
fn keys_that_now_name_another_directory_stay() {
    let machine = Machine::new();
    let host = machine.host();
    let tombstone = machine.renamed(&host);
    // Electron was installed again elsewhere before this launch.
    let reinstalled = machine.home.join("Reinstalled");
    electron_install(&reinstalled);
    *host.registration.lock().unwrap() = Some(registration_for(&reinstalled));

    assert_eq!(machine.run(&host, T0 + 1), retired(true));
    assert!(!tombstone.exists());
    assert_eq!(host.deletes(), 0);
    assert!(reinstalled.join("Memrynote.exe").exists());
}

#[test]
fn a_delete_that_stops_partway_resumes_at_the_next_launch() {
    let machine = Machine::new();
    let host = machine.host();
    let tombstone = machine.renamed(&host);
    let held = tombstone.join("resources");
    #[cfg(unix)]
    let release = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&held, std::fs::Permissions::from_mode(0o555)).unwrap();
        move || std::fs::set_permissions(&held, std::fs::Permissions::from_mode(0o755)).unwrap()
    };
    #[cfg(windows)]
    let release = {
        use std::os::windows::fs::OpenOptionsExt;
        let open = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(held.join("app.asar"))
            .unwrap();
        move || drop(open)
    };

    let outcome = machine.run(&host, T0 + 1);
    release();
    assert_eq!(outcome, kept(Keep::PartialDelete, true));
    assert!(tombstone.exists());
    assert_eq!(host.deletes(), 0);

    assert_eq!(machine.run(&host, T0 + 2), retired(true));
    assert!(!tombstone.exists());
    assert_eq!(host.deletes(), 1);
}

#[test]
fn keys_that_could_not_be_deleted_go_at_the_next_launch() {
    let machine = Machine::new();
    let host = machine.host();
    host.delete_fails.store(1, Ordering::SeqCst);

    assert_eq!(machine.run_past_grace(&host), kept(Keep::Registry, true));
    assert!(!machine.nsis.exists());
    assert!(!machine.tombstone().exists());
    assert_eq!(host.deletes(), 0);

    assert_eq!(machine.run(&host, T0 + GRACE_MS + 1), retired(true));
    assert_eq!(host.deletes(), 1);
    assert_eq!(machine.state(), LeftoverState::default());
}
