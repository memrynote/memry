use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

const T0: u64 = 1_800_000_000_000;

/// Runs inside `wait_until_unused`, after the checks and before the rename.
type OnWait = Box<dyn Fn(&Path) + Send + Sync>;

/// The registry and the processes of one machine.
#[derive(Default)]
pub(crate) struct FakeHost {
    pub(crate) registration: Mutex<Option<Registration>>,
    per_machine: bool,
    /// Calls of `wait_until_unused` still to answer "in use".
    busy: AtomicUsize,
    on_wait: Option<OnWait>,
    pub(crate) deletes: AtomicUsize,
}

impl LeftoverHost for FakeHost {
    fn per_user(&self) -> Option<Registration> {
        self.registration.lock().unwrap().clone()
    }

    fn per_machine(&self) -> bool {
        self.per_machine
    }

    fn wait_until_unused(&self, dir: &Path, _bound: Duration) -> bool {
        if let Some(hook) = &self.on_wait {
            hook(dir);
        }
        self.busy
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_err()
    }

    fn delete_registration(&self) -> std::io::Result<()> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        *self.registration.lock().unwrap() = None;
        Ok(())
    }
}

/// A user's machine: home, an NSIS install in `Programs\Memrynote`, this app's Velopack install
/// beside it, the app data directory.
struct Machine {
    _root: tempfile::TempDir,
    home: PathBuf,
    nsis: PathBuf,
    velopack: PathBuf,
    data: PathBuf,
    pins: PathBuf,
}

impl Machine {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        // Canonical, so no link on the path (macOS's `/var` is one).
        let home = root.path().canonicalize().unwrap();
        let nsis = home.join("Local").join("Programs").join("Memrynote");
        electron_install(&nsis);
        let velopack = home.join("Local").join("MemryNote");
        std::fs::create_dir_all(velopack.join("current")).unwrap();
        std::fs::write(velopack.join("current").join("Memrynote.exe"), b"tauri").unwrap();
        let data = home.join("Roaming").join("com.memrynote.memry");
        std::fs::create_dir_all(&data).unwrap();
        let pins = home.join("Roaming").join("TaskBar");
        std::fs::create_dir_all(&pins).unwrap();
        Self {
            _root: root,
            home,
            nsis,
            velopack,
            data,
            pins,
        }
    }

    fn registration(&self) -> Registration {
        registration_for(&self.nsis)
    }

    fn host(&self) -> FakeHost {
        FakeHost {
            registration: Mutex::new(Some(self.registration())),
            ..FakeHost::default()
        }
    }

    fn run(&self, host: &FakeHost, now_ms: u64) -> Outcome {
        let own = [self.velopack.clone(), self.velopack.join("current")];
        let roots = [self.home.clone(), self.home.join("Local")];
        retire(
            host,
            &Context {
                data_dir: &self.data,
                own_install: &own,
                user_roots: &roots,
                pins_dir: Some(&self.pins),
                now_ms,
            },
        )
    }

    /// First launch finds it, a later one a day on removes it.
    fn run_past_grace(&self, host: &FakeHost) -> Outcome {
        assert_eq!(self.run(host, T0), Outcome::Waiting);
        self.run(host, T0 + GRACE_MS)
    }

    fn state(&self) -> LeftoverState {
        state::read(&self.data)
    }

    fn tombstone(&self) -> PathBuf {
        tombstone_of(&self.nsis).unwrap()
    }
}

pub(crate) fn electron_install(dir: &Path) {
    std::fs::create_dir_all(dir.join("resources")).unwrap();
    std::fs::create_dir_all(dir.join("locales")).unwrap();
    for name in [
        "Memrynote.exe",
        "Uninstall Memrynote.exe",
        "ffmpeg.dll",
        "icudtl.dat",
        "resources.pak",
        "LICENSE.electron.txt",
    ] {
        std::fs::write(dir.join(name), name).unwrap();
    }
    std::fs::write(dir.join("resources").join("app.asar"), b"asar").unwrap();
    std::fs::write(dir.join("locales").join("en-US.pak"), b"pak").unwrap();
}

pub(crate) fn registration_for(dir: &Path) -> Registration {
    Registration {
        install_location: Some(dir.to_string_lossy().into_owned()),
        uninstall_string: Some(format!(
            "\"{}\" /currentuser",
            dir.join("Uninstall Memrynote.exe").display()
        )),
    }
}

fn kept(reason: Keep, first_report: bool) -> Outcome {
    Outcome::Kept {
        reason,
        first_report,
    }
}

#[test]
fn a_found_leftover_stays_a_day_then_goes_with_its_keys() {
    let machine = Machine::new();
    let host = machine.host();

    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    assert_eq!(machine.run(&host, T0 + GRACE_MS - 1), Outcome::Waiting);
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert_eq!(host.deletes.load(Ordering::SeqCst), 0);

    assert_eq!(
        machine.run(&host, T0 + GRACE_MS),
        Outcome::Retired { stale_pins: 0 }
    );
    assert!(!machine.nsis.exists());
    assert!(!machine.tombstone().exists());
    assert_eq!(host.deletes.load(Ordering::SeqCst), 1);
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
fn a_folder_with_anything_else_in_it_is_kept_and_reported_once() {
    let machine = Machine::new();
    std::fs::write(machine.nsis.join("notes.txt"), b"mine").unwrap();
    let host = machine.host();

    assert_eq!(machine.run_past_grace(&host), kept(Keep::ExtraEntry, true));
    assert_eq!(
        machine.run(&host, T0 + GRACE_MS + 1),
        kept(Keep::ExtraEntry, false)
    );
    assert!(machine.nsis.join("notes.txt").exists());
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert_eq!(host.deletes.load(Ordering::SeqCst), 0);
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
    // The registry names this app's own install, its root, or the user's home, in any case.
    let machine = Machine::new();
    electron_install(&machine.velopack.join("current"));
    let upper = |path: &Path| PathBuf::from(path.to_string_lossy().to_uppercase());
    for dir in [
        machine.velopack.join("current"),
        upper(&machine.velopack.join("current")),
        machine.velopack.clone(),
        machine.home.clone(),
    ] {
        // The upper-case spelling exists only on a case-insensitive file system.
        if !dir.exists() {
            continue;
        }
        let host = FakeHost {
            registration: Mutex::new(Some(registration_for(&dir))),
            ..FakeHost::default()
        };
        std::fs::remove_file(machine.data.join(STATE_FILENAME)).ok();
        assert_eq!(
            machine.run_past_grace(&host),
            kept(Keep::UnsafeLocation, true),
            "{dir:?}"
        );
        assert!(
            machine
                .velopack
                .join("current")
                .join("Memrynote.exe")
                .exists()
        );
        assert_eq!(host.deletes.load(Ordering::SeqCst), 0, "{dir:?}");
    }
}

#[test]
fn a_user_root_is_never_taken_even_when_it_holds_electron_files() {
    let machine = Machine::new();
    let documents = machine.home.join("Documents");
    electron_install(&documents);
    let host = FakeHost {
        registration: Mutex::new(Some(registration_for(&documents))),
        ..FakeHost::default()
    };
    let roots = [documents.clone()];
    let run = |now_ms| {
        retire(
            &host,
            &Context {
                data_dir: &machine.data,
                own_install: &[],
                user_roots: &roots,
                pins_dir: None,
                now_ms,
            },
        )
    };
    assert_eq!(run(T0), Outcome::Waiting);
    assert_eq!(run(T0 + GRACE_MS), kept(Keep::UnsafeLocation, true));
    assert!(documents.join("Memrynote.exe").exists());
}

#[test]
fn keys_that_now_name_another_directory_stay() {
    let machine = Machine::new();
    let host = machine.host();
    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    let tombstone = machine.tombstone();
    let mut state = machine.state();
    state.tombstone = Some(tombstone.to_string_lossy().into_owned());
    state::write(&machine.data, &state).unwrap();
    std::fs::rename(&machine.nsis, &tombstone).unwrap();
    // Electron was installed again elsewhere before this launch.
    let reinstalled = machine.home.join("Reinstalled");
    electron_install(&reinstalled);
    *host.registration.lock().unwrap() = Some(registration_for(&reinstalled));

    assert_eq!(
        machine.run(&host, T0 + 1),
        Outcome::Retired { stale_pins: 0 }
    );
    assert!(!tombstone.exists());
    assert_eq!(host.deletes.load(Ordering::SeqCst), 0);
    assert!(reinstalled.join("Memrynote.exe").exists());
}

#[cfg(unix)]
#[test]
fn a_link_on_the_path_or_inside_is_kept() {
    let machine = Machine::new();
    let target = machine.home.join("Elsewhere");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::remove_dir_all(machine.nsis.join("locales")).unwrap();
    std::os::unix::fs::symlink(&target, machine.nsis.join("locales")).unwrap();
    assert_eq!(
        machine.run_past_grace(&machine.host()),
        kept(Keep::Reparse, true)
    );
    assert!(target.exists());

    // Reached through a linked parent.
    let machine = Machine::new();
    let linked = machine.home.join("Linked");
    std::os::unix::fs::symlink(machine.nsis.parent().unwrap(), &linked).unwrap();
    let host = FakeHost {
        registration: Mutex::new(Some(registration_for(&linked.join("Memrynote")))),
        ..FakeHost::default()
    };
    assert_eq!(machine.run_past_grace(&host), kept(Keep::Reparse, true));
    assert!(machine.nsis.join("Memrynote.exe").exists());
}

#[test]
fn a_pending_nsis_restore_keeps_it() {
    let machine = Machine::new();
    let backup = machine.nsis.with_file_name("Memrynote.update-backup");
    std::fs::create_dir_all(&backup).unwrap();
    assert_eq!(
        machine.run_past_grace(&machine.host()),
        kept(Keep::BackupPending, true)
    );
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert!(backup.exists());
}

#[test]
fn a_process_running_from_it_keeps_it_until_a_later_launch() {
    let machine = Machine::new();
    let host = machine.host();
    host.busy.store(1, Ordering::SeqCst);

    assert_eq!(machine.run_past_grace(&host), kept(Keep::InUse, true));
    assert!(machine.nsis.join("Memrynote.exe").exists());
    assert_eq!(
        machine.run(&host, T0 + GRACE_MS + 1),
        Outcome::Retired { stale_pins: 0 }
    );
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
    assert_eq!(host.deletes.load(Ordering::SeqCst), 0);
}

#[test]
fn a_removal_cut_short_resumes_from_its_recorded_tombstone() {
    let machine = Machine::new();
    let host = machine.host();
    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    // The last launch renamed the directory and deleted part of it, anchors included.
    let tombstone = machine.tombstone();
    let mut state = machine.state();
    state.tombstone = Some(tombstone.to_string_lossy().into_owned());
    state::write(&machine.data, &state).unwrap();
    std::fs::rename(&machine.nsis, &tombstone).unwrap();
    std::fs::remove_file(tombstone.join("Memrynote.exe")).unwrap();
    std::fs::remove_dir_all(tombstone.join("resources")).unwrap();

    assert_eq!(
        machine.run(&host, T0 + 1),
        Outcome::Retired { stale_pins: 0 }
    );
    assert!(!tombstone.exists());
    assert_eq!(host.deletes.load(Ordering::SeqCst), 1);
    assert_eq!(machine.state(), LeftoverState::default());
}

#[test]
fn a_recorded_tombstone_that_was_never_renamed_to_starts_over() {
    let machine = Machine::new();
    let host = machine.host();
    assert_eq!(machine.run(&host, T0), Outcome::Waiting);
    let mut state = machine.state();
    state.tombstone = Some(machine.tombstone().to_string_lossy().into_owned());
    state::write(&machine.data, &state).unwrap();

    assert_eq!(
        machine.run(&host, T0 + GRACE_MS),
        Outcome::Retired { stale_pins: 0 }
    );
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
fn keys_whose_files_are_gone_are_removed() {
    let machine = Machine::new();
    std::fs::remove_dir_all(&machine.nsis).unwrap();
    let host = machine.host();
    assert_eq!(machine.run(&host, T0), Outcome::Retired { stale_pins: 0 });
    assert_eq!(host.deletes.load(Ordering::SeqCst), 1);
}

#[test]
fn keys_on_a_drive_that_is_not_attached_stay() {
    let machine = Machine::new();
    let unplugged = machine.home.join("Unplugged").join("Memrynote");
    let host = FakeHost {
        registration: Mutex::new(Some(registration_for(&unplugged))),
        ..FakeHost::default()
    };
    assert_eq!(machine.run(&host, T0), kept(Keep::UnsafeLocation, true));
    assert_eq!(host.deletes.load(Ordering::SeqCst), 0);
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
        Outcome::Retired { stale_pins: 1 }
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
