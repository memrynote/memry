//! Windows side of [`memry_desktop::updater::nsis_leftover`]: the NSIS install's registry keys
//! and the processes running from its directory.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use memry_desktop::updater::nsis_leftover::{
    INSTALL_KEY, LeftoverHost, Registration, UNINSTALL_KEY, lies_within,
};
use memry_desktop::updater::service::UpdaterService;
use tauri::{AppHandle, Manager, Wry};
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    QueryFullProcessImageNameW, WaitForSingleObject,
};
use windows::core::{Owned, PWSTR};
use winreg::RegKey;
use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
};

/// What the removal must never take, read before the blocking pass starts.
pub struct Inputs {
    own_install: Vec<PathBuf>,
    user_roots: Vec<PathBuf>,
    pins_dir: Option<PathBuf>,
}

impl Inputs {
    pub fn read(app: &AppHandle<Wry>) -> Self {
        // `<root>\current\Memrynote.exe`: the exe's directory and the Velopack root.
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_owned));
        let own_install = exe_dir
            .iter()
            .flat_map(|dir| [Some(dir.clone()), dir.parent().map(Path::to_owned)])
            .flatten()
            .collect();
        let paths = app.path();
        let local = paths.local_data_dir().ok();
        let roaming = paths.data_dir().ok();
        let user_roots = [
            paths.home_dir().ok(),
            local.clone(),
            local.map(|local| local.join("Programs")),
            roaming.clone(),
        ]
        .into_iter()
        .flatten()
        .collect();
        let pins_dir = roaming.map(|roaming| {
            roaming.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
        });
        Self {
            own_install,
            user_roots,
            pins_dir,
        }
    }
}

/// One pass, on a blocking thread after the updater's init.
pub fn retire(service: &UpdaterService, inputs: &Inputs) {
    service.retire_nsis_leftover(
        &WinHost::new(INSTALL_KEY, UNINSTALL_KEY),
        &inputs.own_install,
        &inputs.user_roots,
        inputs.pins_dir.as_deref(),
    );
}

struct WinHost {
    install_key: String,
    uninstall_key: String,
}

impl WinHost {
    fn new(install_key: &str, uninstall_key: &str) -> Self {
        Self {
            install_key: install_key.to_owned(),
            uninstall_key: uninstall_key.to_owned(),
        }
    }
}

impl LeftoverHost for WinHost {
    fn per_user(&self) -> Option<Registration> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let install = user.open_subkey(&self.install_key).ok();
        let uninstall = user.open_subkey(&self.uninstall_key).ok();
        if install.is_none() && uninstall.is_none() {
            return None;
        }
        Some(Registration {
            install_location: install.and_then(|key| key.get_value("InstallLocation").ok()),
            uninstall_string: uninstall.and_then(|key| key.get_value("UninstallString").ok()),
        })
    }

    fn per_machine(&self) -> bool {
        let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
        [KEY_WOW64_64KEY, KEY_WOW64_32KEY].into_iter().any(|view| {
            [&self.install_key, &self.uninstall_key]
                .into_iter()
                .any(|key| machine.open_subkey_with_flags(key, KEY_READ | view).is_ok())
        })
    }

    fn wait_until_unused(&self, dir: &Path, bound: Duration) -> bool {
        wait_until_none_inside(dir, bound)
    }

    fn delete_registration(&self) -> std::io::Result<()> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        for key in [&self.uninstall_key, &self.install_key] {
            match user.delete_subkey_all(key) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

/// Waits on every process whose image lies in `dir`, all within `bound`, then looks again for
/// one that started meanwhile.
fn wait_until_none_inside(dir: &Path, bound: Duration) -> bool {
    let running = processes_inside(dir);
    if running.is_empty() {
        return true;
    }
    tracing::info!(
        scope = "NsisLeftover",
        "waiting for {} processes of the NSIS install to exit",
        running.len()
    );
    let deadline = Instant::now() + bound;
    for process in &running {
        let left = deadline.saturating_duration_since(Instant::now());
        let millis = u32::try_from(left.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: the handle is open (owned) and was opened with SYNCHRONIZE.
        if unsafe { WaitForSingleObject(**process, millis) } != WAIT_OBJECT_0 {
            return false;
        }
    }
    processes_inside(dir).is_empty()
}

/// Every other process whose image lies in `dir`, each opened so it can be waited on. A process
/// this user cannot open (another session's, an elevated one) is not seen.
fn processes_inside(dir: &Path) -> Vec<Owned<HANDLE>> {
    let own = std::process::id();
    // SAFETY: a snapshot of the process list; the handle is owned and closed on drop.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    // SAFETY: the snapshot handle is valid and owned from here on.
    let snapshot = unsafe { Owned::new(snapshot) };
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..PROCESSENTRY32W::default()
    };
    let mut found = Vec::new();
    // SAFETY: `entry` is a PROCESSENTRY32W with its size set, as both calls require.
    let mut next = unsafe { Process32FirstW(*snapshot, &mut entry) };
    while next.is_ok() {
        let pid = entry.th32ProcessID;
        if pid != own
            && let Some(process) = open_if_inside(pid, dir)
        {
            found.push(process);
        }
        // SAFETY: as above.
        next = unsafe { Process32NextW(*snapshot, &mut entry) };
    }
    found
}

fn open_if_inside(pid: u32, dir: &Path) -> Option<Owned<HANDLE>> {
    // SAFETY: opens a handle that is owned and closed on drop.
    let process = unsafe {
        Owned::new(
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                pid,
            )
            .ok()?,
        )
    };
    let mut buffer = vec![0u16; 32_768];
    let mut len = buffer.len() as u32;
    // SAFETY: `buffer` holds `len` u16s; the call writes at most that many and sets `len`.
    unsafe {
        QueryFullProcessImageNameW(
            *process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
    }
    .ok()?;
    let image = PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize]));
    lies_within(&image, dir).then_some(process)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway `HKCU` key standing in for the NSIS keys; deleted on drop.
    struct TestKeys {
        root: String,
    }

    impl TestKeys {
        fn new() -> Self {
            Self {
                root: format!(r"Software\MemryTest-{}", uuid::Uuid::new_v4()),
            }
        }

        fn host(&self) -> WinHost {
            WinHost::new(
                &format!(r"{}\install", self.root),
                &format!(r"{}\uninstall", self.root),
            )
        }
    }

    impl Drop for TestKeys {
        fn drop(&mut self) {
            let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.root);
        }
    }

    #[test]
    fn the_keys_are_read_and_deleted_and_a_missing_one_is_no_error() {
        let keys = TestKeys::new();
        let host = keys.host();
        assert_eq!(host.per_user(), None);

        let user = RegKey::predef(HKEY_CURRENT_USER);
        let (install, _) = user.create_subkey(&host.install_key).unwrap();
        install
            .set_value(
                "InstallLocation",
                &r"C:\Users\k\AppData\Local\Programs\Memrynote",
            )
            .unwrap();
        assert_eq!(
            host.per_user(),
            Some(Registration {
                install_location: Some(r"C:\Users\k\AppData\Local\Programs\Memrynote".into()),
                uninstall_string: None,
            })
        );

        host.delete_registration().unwrap();
        assert_eq!(host.per_user(), None);
        assert!(!host.per_machine());
    }

    #[test]
    fn a_process_running_from_the_directory_is_waited_for() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().canonicalize().unwrap();
        let system = std::env::var_os("SystemRoot").expect("SystemRoot");
        let ping = dir.join("PING.EXE");
        std::fs::copy(PathBuf::from(system).join(r"System32\PING.EXE"), &ping).unwrap();
        let mut child = std::process::Command::new(&ping)
            .args(["-n", "120", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();

        assert_eq!(processes_inside(&dir).len(), 1);
        assert!(processes_inside(&dir.join("elsewhere")).is_empty());
        assert!(!wait_until_none_inside(&dir, Duration::from_millis(200)));

        child.kill().unwrap();
        child.wait().unwrap();
        assert!(wait_until_none_inside(&dir, Duration::from_secs(10)));
    }
}
