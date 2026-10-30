//! A fake registry and process list over a real temp-dir file system. Each guard on the delete
//! path has a test here that fails when the guard is removed; link tests run with symlinks on
//! Unix and junctions on Windows.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

mod flow;
mod location;
mod resume;

const T0: u64 = 1_800_000_000_000;

/// Runs inside `wait_until_unused`, after the checks and before the rename.
type OnWait = Box<dyn Fn(&Path) + Send + Sync>;

/// The registry and the processes of one machine.
#[derive(Default)]
pub(crate) struct FakeHost {
    pub(crate) registration: Mutex<Option<Registration>>,
    per_machine: bool,
    restore: bool,
    /// Calls of `wait_until_unused` still to answer "in use".
    busy: AtomicUsize,
    on_wait: Option<OnWait>,
    /// Calls of `delete_registration` still to fail.
    delete_fails: AtomicUsize,
    pub(crate) deletes: AtomicUsize,
}

impl FakeHost {
    fn naming(dir: &Path) -> Self {
        Self {
            registration: Mutex::new(Some(registration_for(dir))),
            ..Self::default()
        }
    }

    fn deletes(&self) -> usize {
        self.deletes.load(Ordering::SeqCst)
    }
}

fn take(counter: &AtomicUsize) -> bool {
    counter
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
        .is_ok()
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
        !take(&self.busy)
    }

    fn delete_registration(&self) -> std::io::Result<()> {
        if take(&self.delete_fails) {
            return Err(std::io::Error::other("access denied"));
        }
        self.deletes.fetch_add(1, Ordering::SeqCst);
        *self.registration.lock().unwrap() = None;
        Ok(())
    }

    fn restore_pending(&self) -> bool {
        self.restore
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

    fn host(&self) -> FakeHost {
        FakeHost::naming(&self.nsis)
    }

    fn run(&self, host: &FakeHost, now_ms: u64) -> Outcome {
        let own = [self.velopack.clone(), self.velopack.join("current")];
        let roots = [self.home.clone(), self.home.join("Local")];
        self.run_in(host, now_ms, &own, &roots)
    }

    fn run_in(
        &self,
        host: &FakeHost,
        now_ms: u64,
        own_install: &[PathBuf],
        user_roots: &[PathBuf],
    ) -> Outcome {
        retire(
            host,
            &Context {
                data_dir: &self.data,
                own_install,
                user_roots,
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
        checks::tombstone_of(&self.nsis).unwrap()
    }

    /// The state of a launch that found the leftover, recorded its removal and renamed the
    /// directory, then stopped.
    fn renamed(&self, host: &FakeHost) -> PathBuf {
        assert_eq!(self.run(host, T0), Outcome::Waiting);
        let tombstone = self.tombstone();
        self.record(&self.nsis, &tombstone);
        std::fs::rename(&self.nsis, &tombstone).unwrap();
        tombstone
    }

    fn record(&self, origin: &Path, tombstone: &Path) {
        let mut state = self.state();
        state.origin = Some(origin.to_string_lossy().into_owned());
        state.tombstone = Some(tombstone.to_string_lossy().into_owned());
        state::write(&self.data, &state).unwrap();
    }
}

/// The layout of the shipped builds this app removes.
pub(crate) fn electron_install(dir: &Path) {
    for sub in [
        "resources/app.asar.unpacked/out",
        "resources/node_modules/sharp",
        "locales",
    ] {
        std::fs::create_dir_all(at(dir, sub)).unwrap();
    }
    for name in [
        "Memrynote.exe",
        "Uninstall Memrynote.exe",
        "ffmpeg.dll",
        "icudtl.dat",
        "resources.pak",
        "LICENSE.electron.txt",
        "resources/app.asar",
        "resources/app-config",
        "resources/.env",
        "resources/app-update.yml",
        "resources/elevate.exe",
        "resources/node_modules/sharp/index.js",
        "locales/en-US.pak",
        "locales/tr.pak",
    ] {
        std::fs::write(at(dir, name), name).unwrap();
    }
}

/// `dir` joined with a `/`-separated relative path one part at a time: a Windows verbatim path
/// (`\\?\C:\`, which `canonicalize` returns) takes no `/` as a separator.
fn at(dir: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(dir.to_owned(), |path, part| path.join(part))
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

fn retired(files: bool) -> Outcome {
    Outcome::Retired {
        stale_pins: 0,
        files,
    }
}

/// `link` points at the directory `target`: a symlink on Unix, a junction on Windows, which
/// needs no elevation.
fn link_dir(link: &Path, target: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(layout::display(link))
            .arg(layout::display(target))
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J failed");
    }
}
