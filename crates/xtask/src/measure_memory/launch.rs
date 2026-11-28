//! Starts the app on a throwaway profile, waits for its vault, and stops it.
//!
//! Isolation: a `MEMRY_DEVICE` of its own keeps the run off the user's keychain accounts, log
//! and single-instance lock (`memry_desktop::paths::profile_identifier`); `MEMRY_APP_DATA_DIR`
//! and `MEMRY_TEST_LOG_DIR` put the profile and `main.log` in a temp folder of the run, which
//! names the vault the way `apps/desktop-tauri/e2e/harness/seed-registry.mjs` does and turns
//! telemetry off. macOS 13 has no per-instance WKWebView store (`AppPaths::webview_store_id`),
//! so there the run shares web storage with an installed app of the same bundle id.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "macos"))]
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use memry_desktop::telemetry::config::FILE_NAME as TELEMETRY_FILE;
use serde_json::json;
use tempfile::TempDir;

use super::interrupt;

/// Any other device (`dev`, the `A`/`B`/`C` of `tauri:dev:a`) may hold a signed-in account.
pub const DEVICE: &str = "memory-bench";
/// The line `LaunchTimeline::mark` logs once the session has opened the vault
/// (`shell/vault_boot.rs`): its own line, before the `launch timeline {` block of the reveal.
pub const READY_LINE: &str = "launch mark vault_open_ready at ";
const READY_DEADLINE: Duration = Duration::from_secs(120);
const QUIT_DEADLINE: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(100);

/// `MEMRY_DEVICE` of the run: [`DEVICE`] when unset or empty, else `memory-bench-<a-z0-9>`.
pub fn device(current: Option<&str>) -> Result<String, String> {
    let device = current.map(str::trim).filter(|d| !d.is_empty());
    let Some(device) = device else {
        return Ok(DEVICE.to_owned());
    };
    let suffix_ok = |suffix: &str| {
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    };
    let ok = device == DEVICE
        || device
            .strip_prefix(DEVICE)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(suffix_ok);
    if ok {
        Ok(device.to_owned())
    } else {
        Err(format!(
            "MEMRY_DEVICE={device:?} may hold a signed-in account; unset it or use {DEVICE}-<a-z0-9>"
        ))
    }
}

/// The executable inside `app`. Electron builds are refused: they ignore `MEMRY_APP_DATA_DIR`
/// and open the keychain's Safe Storage item. An AppImage hides its layout, so it needs
/// `tauri_appimage`.
pub fn resolve_executable(app: &Path, tauri_appimage: bool) -> Result<PathBuf, String> {
    let electron = || {
        format!(
            "{} is an Electron build; this tool measures the Tauri app",
            app.display()
        )
    };
    match app.extension().and_then(|ext| ext.to_str()) {
        Some("AppImage") if !tauri_appimage => Err(format!(
            "{} may be an Electron build; pass --tauri-appimage if it is the Tauri app",
            app.display()
        )),
        Some("AppImage") => Ok(app.to_owned()),
        Some("app") => {
            if app
                .join("Contents/Frameworks/Electron Framework.framework")
                .exists()
            {
                return Err(electron());
            }
            let plist = fs::read_to_string(app.join("Contents/Info.plist"))
                .map_err(|error| format!("{}/Contents/Info.plist: {error}", app.display()))?;
            let name = plist
                .split_once("<key>CFBundleExecutable</key>")
                .and_then(|(_, rest)| rest.split_once("<string>"))
                .and_then(|(_, rest)| rest.split_once("</string>"))
                .map(|(name, _)| name.trim())
                .ok_or(format!("no CFBundleExecutable in {}", app.display()))?;
            Ok(app.join("Contents/MacOS").join(name))
        }
        _ => {
            let beside = app.parent().unwrap_or(Path::new("."));
            if beside.join("resources/app.asar").exists() {
                return Err(electron());
            }
            Ok(app.to_owned())
        }
    }
}

/// Replaces the file log level (`memry_desktop::logging::init`): a `RUST_LOG=warn` in the shell
/// would hide [`READY_LINE`].
const DROPPED_VARS: [&str; 1] = ["RUST_LOG"];

/// A new temp folder for one run, removed when dropped: `memry-config.json` names `vault` as the
/// current vault, and `telemetry.json` turns telemetry off, so no run reports itself as a new
/// install (the stored flag beats `MEMRY_TELEMETRY_ENABLED` and the production default,
/// `RuntimeConfig::telemetry_enabled`).
pub fn fresh_profile(vault: &Path) -> std::io::Result<TempDir> {
    let profile = tempfile::Builder::new()
        .prefix("memry-measure-memory-")
        .tempdir()?;
    fs::create_dir_all(profile.path().join("logs"))?;
    let name = vault
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let vault = vault.to_string_lossy();
    let config = json!({
        "currentVault": vault,
        "vaults": [{
            "path": vault,
            "name": name,
            "noteCount": 0,
            "taskCount": 0,
            "lastOpened": chrono::Utc::now().to_rfc3339(),
            "isDefault": true,
        }],
    });
    fs::write(profile.path().join("memry-config.json"), config.to_string())?;
    fs::write(
        profile.path().join(TELEMETRY_FILE),
        json!({ "enabled": false }).to_string(),
    )?;
    Ok(profile)
}

/// The app's environment: this process's, without [`DROPPED_VARS`], with the profile's paths and
/// the bench device.
pub fn child_env(
    parent: impl IntoIterator<Item = (OsString, OsString)>,
    profile: &Path,
    device: &str,
) -> BTreeMap<OsString, OsString> {
    let mut env: BTreeMap<OsString, OsString> = parent
        .into_iter()
        .filter(|(key, _)| !DROPPED_VARS.iter().any(|dropped| key == dropped))
        .collect();
    for (key, value) in [
        ("MEMRY_DEVICE", OsString::from(device)),
        ("MEMRY_APP_DATA_DIR", profile.as_os_str().to_owned()),
        ("MEMRY_TEST_LOG_DIR", profile.join("logs").into_os_string()),
    ] {
        env.insert(OsString::from(key), value);
    }
    env
}

pub struct Running {
    process: AppProcess,
    pub log: PathBuf,
}

/// A process this tool started: its pid, whether it has exited (and how), and a hard kill.
trait Started {
    fn pid(&self) -> u32;
    fn exited(&mut self) -> Result<Option<String>, String>;
    fn kill_and_reap(&mut self);
}

#[cfg(not(target_os = "macos"))]
type AppProcess = Child;
#[cfg(target_os = "macos")]
type AppProcess = disclaimed::Spawned;

#[cfg(not(target_os = "macos"))]
impl Started for Child {
    fn pid(&self) -> u32 {
        self.id()
    }

    fn exited(&mut self) -> Result<Option<String>, String> {
        self.try_wait()
            .map(|status| status.map(|s| s.to_string()))
            .map_err(|error| format!("the app: {error}"))
    }

    fn kill_and_reap(&mut self) {
        #[cfg(windows)]
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &self.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.kill();
        let _ = self.wait();
    }
}

pub fn launch(executable: &Path, profile: &Path, device: &str) -> Result<Running, String> {
    let env = child_env(std::env::vars_os(), profile, device);
    #[cfg(target_os = "macos")]
    let process = disclaimed::spawn(executable, &env);
    #[cfg(not(target_os = "macos"))]
    let process = Command::new(executable)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string());
    let process = process.map_err(|error| format!("{}: {error}", executable.display()))?;
    Ok(Running {
        process,
        log: profile.join("logs").join("main.log"),
    })
}

impl Running {
    pub fn pid(&self) -> u32 {
        self.process.pid()
    }

    /// Waits for [`READY_LINE`] in `main.log`; fails when the app exits first or the deadline
    /// passes.
    pub fn wait_ready(&mut self) -> Result<Duration, String> {
        let started = Instant::now();
        loop {
            if fs::read_to_string(&self.log).is_ok_and(|log| log.contains(READY_LINE)) {
                return Ok(started.elapsed());
            }
            self.ensure_alive()?;
            interrupt::check()?;
            if started.elapsed() > READY_DEADLINE {
                return Err(format!(
                    "no {READY_LINE:?} in {} within {} s",
                    self.log.display(),
                    READY_DEADLINE.as_secs()
                ));
            }
            std::thread::sleep(POLL);
        }
    }

    /// Lets the app idle for `idle`; fails when it exits or the user interrupts.
    pub fn idle(&mut self, idle: Duration) -> Result<(), String> {
        let started = Instant::now();
        while started.elapsed() < idle {
            self.ensure_alive()?;
            interrupt::check()?;
            std::thread::sleep(POLL);
        }
        self.ensure_alive()
    }

    pub fn ensure_alive(&mut self) -> Result<(), String> {
        match self.process.exited()? {
            None => Ok(()),
            Some(status) => Err(format!(
                "the app exited ({status}); see {}",
                self.log.display()
            )),
        }
    }

    /// Asks the app to quit (SIGTERM starts its shutdown; Windows gets WM_CLOSE), then forces
    /// it. Returns a warning when it had to be killed.
    pub fn quit(mut self) -> Option<String> {
        let pid = self.pid();
        #[cfg(unix)]
        if let Ok(pid) = libc::pid_t::try_from(pid) {
            // SAFETY: signals our own child.
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        #[cfg(windows)]
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let started = Instant::now();
        while started.elapsed() < QUIT_DEADLINE {
            if !matches!(self.process.exited(), Ok(None)) {
                return None;
            }
            std::thread::sleep(POLL);
        }
        self.process.kill_and_reap();
        Some(format!(
            "the app did not quit within {} s and was killed",
            QUIT_DEADLINE.as_secs()
        ))
    }
}

/// macOS charges a process's XPC services (WebKit's WebContent, GPU and Networking) to the
/// process responsible for it, which for a child of a terminal is the terminal. Spawned with
/// `responsibility_spawnattrs_setdisclaim`, the app is responsible for itself, so
/// `responsibility_get_pid_responsible_for_pid` names it for its own web view processes.
#[cfg(target_os = "macos")]
mod disclaimed {
    use std::collections::BTreeMap;
    use std::ffi::{CString, OsString, c_char, c_int};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;

    use super::Started;
    use crate::measure_memory::processes::macos::symbol;

    type SetDisclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;

    pub struct Spawned(libc::pid_t);

    fn c_string(bytes: &[u8]) -> Result<CString, String> {
        CString::new(bytes).map_err(|_| "a NUL byte in the path or environment".to_owned())
    }

    pub fn spawn(executable: &Path, env: &BTreeMap<OsString, OsString>) -> Result<Spawned, String> {
        let path = c_string(executable.as_os_str().as_bytes())?;
        let env: Vec<CString> = env
            .iter()
            .map(|(key, value)| c_string(&[key.as_bytes(), b"=", value.as_bytes()].concat()))
            .collect::<Result<_, _>>()?;
        let mut envp: Vec<*mut c_char> = env.iter().map(|var| var.as_ptr().cast_mut()).collect();
        envp.push(null_mut());
        let argv = [path.as_ptr().cast_mut(), null_mut()];
        let set_disclaim = symbol(c"responsibility_spawnattrs_setdisclaim").map(|symbol| {
            // SAFETY: the symbol is `int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *, int)`.
            unsafe { std::mem::transmute::<*mut std::ffi::c_void, SetDisclaim>(symbol) }
        });

        let mut pid: libc::pid_t = 0;
        // SAFETY: the attributes and file actions are initialised before use and destroyed after;
        // `argv` and `envp` are NUL-terminated arrays of C strings that outlive the call.
        let (disclaim, status) = unsafe {
            let mut attr: libc::posix_spawnattr_t = null_mut();
            let mut actions: libc::posix_spawn_file_actions_t = null_mut();
            libc::posix_spawnattr_init(&mut attr);
            libc::posix_spawn_file_actions_init(&mut actions);
            let disclaim = set_disclaim.map_or(0, |set_disclaim| set_disclaim(&mut attr, 1));
            for (fd, flags) in [
                (0, libc::O_RDONLY),
                (1, libc::O_WRONLY),
                (2, libc::O_WRONLY),
            ] {
                libc::posix_spawn_file_actions_addopen(
                    &mut actions,
                    fd,
                    c"/dev/null".as_ptr(),
                    flags,
                    0,
                );
            }
            // Not started when the disclaim failed: its web view would be charged to the terminal.
            let status = if disclaim == 0 {
                libc::posix_spawn(
                    &mut pid,
                    path.as_ptr(),
                    &actions,
                    &attr,
                    argv.as_ptr(),
                    envp.as_ptr(),
                )
            } else {
                0
            };
            libc::posix_spawn_file_actions_destroy(&mut actions);
            libc::posix_spawnattr_destroy(&mut attr);
            (disclaim, status)
        };
        if disclaim != 0 {
            return Err(format!(
                "responsibility_spawnattrs_setdisclaim failed ({disclaim}): the web view processes would be charged to the terminal"
            ));
        }
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status).to_string());
        }
        Ok(Spawned(pid))
    }

    impl Spawned {
        fn wait(&self, flags: c_int) -> Result<Option<String>, String> {
            let mut status: c_int = 0;
            // SAFETY: reaps our own child.
            match unsafe { libc::waitpid(self.0, &mut status, flags) } {
                0 => Ok(None),
                pid if pid == self.0 => Ok(Some(if libc::WIFEXITED(status) {
                    format!("exit status: {}", libc::WEXITSTATUS(status))
                } else {
                    format!("signal: {}", libc::WTERMSIG(status))
                })),
                _ => Err(format!("the app: {}", std::io::Error::last_os_error())),
            }
        }
    }

    impl Started for Spawned {
        fn pid(&self) -> u32 {
            self.0.unsigned_abs()
        }

        fn exited(&mut self) -> Result<Option<String>, String> {
            self.wait(libc::WNOHANG)
        }

        fn kill_and_reap(&mut self) {
            // SAFETY: signals our own child.
            unsafe { libc::kill(self.0, libc::SIGKILL) };
            let _ = self.wait(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_turns_telemetry_off() {
        let profile = fresh_profile(Path::new("/tmp/bench")).expect("profile");
        let dir = profile.path().to_owned();
        let telemetry = fs::read_to_string(dir.join("telemetry.json")).expect("telemetry.json");
        let telemetry: serde_json::Value = serde_json::from_str(&telemetry).expect("json");
        assert_eq!(telemetry["enabled"], false);
        drop(profile);
        assert!(!dir.exists(), "the profile outlives its run");
    }

    #[test]
    fn the_app_gets_the_profile_and_no_log_level_override() {
        let parent = [
            ("RUST_LOG", "warn"),
            ("PATH", "/bin"),
            ("MEMRY_DEVICE", "dev"),
        ]
        .map(|(key, value)| (OsString::from(key), OsString::from(value)));
        let env = child_env(parent, Path::new("/p"), DEVICE);
        let get = |key: &str| env.get(&OsString::from(key)).and_then(|v| v.to_str());
        assert_eq!(get("RUST_LOG"), None);
        assert_eq!(get("PATH"), Some("/bin"));
        assert_eq!(get("MEMRY_DEVICE"), Some(DEVICE));
        assert_eq!(get("MEMRY_APP_DATA_DIR"), Some("/p"));
        assert_eq!(
            env.get(&OsString::from("MEMRY_TEST_LOG_DIR")),
            Some(&Path::new("/p").join("logs").into_os_string())
        );
    }

    #[test]
    fn only_a_memory_bench_device_runs() {
        assert_eq!(device(None).as_deref(), Ok(DEVICE));
        assert_eq!(device(Some(" ")).as_deref(), Ok(DEVICE));
        assert_eq!(
            device(Some("memory-bench-2")).as_deref(),
            Ok("memory-bench-2")
        );
        for taken in [
            "dev",
            "A",
            "memory-bench-",
            "memory-bench-X",
            "memory-benchx",
        ] {
            assert!(device(Some(taken)).is_err(), "{taken}");
        }
    }

    #[test]
    fn electron_bundles_are_refused() {
        let dir = tempfile::tempdir().expect("dir");
        let electron = dir.path().join("Old.app");
        fs::create_dir_all(electron.join("Contents/Frameworks/Electron Framework.framework"))
            .expect("framework");
        assert!(resolve_executable(&electron, false).is_err());

        let tauri = dir.path().join("New.app");
        fs::create_dir_all(tauri.join("Contents")).expect("contents");
        fs::write(
            tauri.join("Contents/Info.plist"),
            "<key>CFBundleExecutable</key>\n\t<string>memry-tauri</string>",
        )
        .expect("plist");
        assert_eq!(
            resolve_executable(&tauri, false),
            Ok(tauri.join("Contents/MacOS/memry-tauri"))
        );
        assert!(resolve_executable(Path::new("/x/Memry.AppImage"), false).is_err());
    }
}
