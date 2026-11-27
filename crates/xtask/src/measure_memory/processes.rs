//! Which processes a run of the app owns, what kind each one is, and the memory the OS charges it.

use std::collections::{HashMap, HashSet};
use std::fmt;

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// One process of a snapshot. `cmd` only classifies the process and is never printed: other
/// programs carry secrets in their arguments.
#[derive(Debug, Clone)]
pub struct Proc {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub cmd: String,
    /// sysinfo's `virtual_memory`, which on Windows is `PrivateUsage` of `GetProcessMemoryInfo`.
    pub private_bytes: u64,
}

/// Every process running now.
pub fn snapshot() -> Vec<Proc> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_cmd(UpdateKind::Always),
    );
    system
        .processes()
        .values()
        .map(|process| Proc {
            pid: process.pid().as_u32(),
            parent: process.parent().map(|pid| pid.as_u32()),
            name: process.name().to_string_lossy().into_owned(),
            cmd: process
                .cmd()
                .iter()
                .map(|arg| arg.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            private_bytes: process.virtual_memory(),
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    App,
    WebView,
    Gpu,
    Helper,
}

impl Kind {
    pub const ALL: [Kind; 4] = [Kind::App, Kind::WebView, Kind::Gpu, Kind::Helper];

    pub fn label(self) -> &'static str {
        match self {
            Kind::App => "app",
            Kind::WebView => "webview",
            Kind::Gpu => "gpu",
            Kind::Helper => "helper",
        }
    }
}

/// The web content processes of WKWebView, WebKitGTK and WebView2 (and Electron's renderers).
const WEBVIEW_MARKERS: [&str; 3] = ["webkit.webcontent", "webkitwebprocess", "--type=renderer"];
const GPU_MARKERS: [&str; 3] = ["webkit.gpu", "webkitgpuprocess", "--type=gpu-process"];

/// `root` is the app; every other attributed process is web view, GPU or a helper (WebKit's
/// networking process, WebView2's browser and utility processes, a `bwrap` sandbox).
pub fn classify(root: u32, proc: &Proc) -> Kind {
    if proc.pid == root {
        return Kind::App;
    }
    let text = format!("{} {}", proc.name, proc.cmd).to_lowercase();
    if WEBVIEW_MARKERS.iter().any(|marker| text.contains(marker)) {
        Kind::WebView
    } else if GPU_MARKERS.iter().any(|marker| text.contains(marker)) {
        Kind::Gpu
    } else {
        Kind::Helper
    }
}

/// How the processes outside the app's tree are found.
pub enum Responsibility<'a> {
    /// Windows and Linux: the web view processes are descendants of the app.
    NotUsed,
    /// macOS without `responsibility_get_pid_responsible_for_pid`.
    Unresolved,
    /// macOS: the process the system charges a pid's work to, when it has one.
    Api(&'a dyn Fn(u32) -> Option<u32>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributionError {
    /// `dlsym` found no responsibility API, so the WebKit XPC services (launched by launchd, not
    /// children of the app) are missing from the web view subtotal.
    NoResponsibleApi,
}

impl fmt::Display for AttributionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AttributionError::NoResponsibleApi => f.write_str(
                "NoResponsibleApi: responsibility_get_pid_responsible_for_pid did not resolve; \
                 the subtotals count the process tree only",
            ),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Attribution {
    /// The root first, then the rest by pid.
    pub pids: Vec<u32>,
    /// `tree` or `tree+responsibility`.
    pub method: &'static str,
    pub error: Option<AttributionError>,
}

/// The root, its descendants, and every process the root is responsible for.
pub fn attribute(procs: &[Proc], root: u32, responsibility: Responsibility<'_>) -> Attribution {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for proc in procs {
        if let Some(parent) = proc.parent.filter(|parent| *parent != proc.pid) {
            children.entry(parent).or_default().push(proc.pid);
        }
    }
    let mut owned = HashSet::from([root]);
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            if owned.insert(*child) {
                queue.push(*child);
            }
        }
    }
    let (method, error) = match responsibility {
        Responsibility::NotUsed => ("tree", None),
        Responsibility::Unresolved => ("tree", Some(AttributionError::NoResponsibleApi)),
        Responsibility::Api(responsible_for) => {
            owned.extend(
                procs
                    .iter()
                    .filter(|proc| responsible_for(proc.pid) == Some(root))
                    .map(|proc| proc.pid),
            );
            ("tree+responsibility", None)
        }
    };
    let mut rest: Vec<u32> = owned.into_iter().filter(|pid| *pid != root).collect();
    rest.sort_unstable();
    let mut pids = vec![root];
    pids.extend(rest);
    Attribution {
        pids,
        method,
        error,
    }
}

/// `Pss` of `/proc/<pid>/smaps_rollup`, in KiB.
pub fn parse_pss_kib(smaps_rollup: &str) -> Option<u64> {
    smaps_rollup.lines().find_map(|line| {
        let rest = line.strip_prefix("Pss:")?;
        rest.trim().strip_suffix("kB")?.trim().parse().ok()
    })
}

/// The bytes the OS charges `proc` with: macOS `ri_phys_footprint`, Windows `PrivateUsage`,
/// Linux `Pss`. `None` when the process is gone or not readable.
pub fn charged_bytes(proc: &Proc) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        macos::phys_footprint(proc.pid)
    }
    #[cfg(windows)]
    {
        Some(proc.private_bytes).filter(|bytes| *bytes > 0)
    }
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string(format!("/proc/{}/smaps_rollup", proc.pid)).ok()?;
        parse_pss_kib(&text).map(|kib| kib * 1024)
    }
}

/// The responsibility source of this OS.
pub fn with_responsibility<T>(run: impl FnOnce(Responsibility<'_>) -> T) -> T {
    #[cfg(target_os = "macos")]
    {
        match macos::responsible_api() {
            Some(api) => run(Responsibility::Api(&|pid| macos::responsible_for(api, pid))),
            None => run(Responsibility::Unresolved),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        run(Responsibility::NotUsed)
    }
}

#[cfg(target_os = "macos")]
pub(crate) mod macos {
    use std::ffi::{CStr, c_void};
    use std::mem::MaybeUninit;

    pub type ResponsibleApi = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

    /// A libsystem symbol, looked up at run time: the responsibility calls are private (what
    /// Activity Monitor attributes by), and this developer tool never ships in the app.
    pub fn symbol(name: &CStr) -> Option<*mut c_void> {
        // SAFETY: `dlsym` with `RTLD_DEFAULT` and a NUL-terminated name only reads.
        let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
        (!symbol.is_null()).then_some(symbol)
    }

    /// Needs both calls: without the spawn-time disclaim (`launch::disclaimed`) the app's web
    /// view processes are charged to the terminal, not to the app.
    pub fn responsible_api() -> Option<ResponsibleApi> {
        symbol(c"responsibility_spawnattrs_setdisclaim")?;
        symbol(c"responsibility_get_pid_responsible_for_pid").map(|symbol| {
            // SAFETY: the symbol is `pid_t responsibility_get_pid_responsible_for_pid(pid_t)`.
            unsafe { std::mem::transmute::<*mut c_void, ResponsibleApi>(symbol) }
        })
    }

    pub fn responsible_for(api: ResponsibleApi, pid: u32) -> Option<u32> {
        let pid = libc::pid_t::try_from(pid).ok()?;
        // SAFETY: takes a pid by value; an unknown pid gives -1.
        let responsible = unsafe { api(pid) };
        u32::try_from(responsible).ok().filter(|r| *r > 0)
    }

    pub fn phys_footprint(pid: u32) -> Option<u64> {
        let pid = libc::c_int::try_from(pid).ok()?;
        let mut info = MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: `RUSAGE_INFO_V2` fills exactly a `rusage_info_v2`.
        let status =
            unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, info.as_mut_ptr().cast()) };
        // SAFETY: a zero status means the kernel wrote the struct.
        (status == 0).then(|| unsafe { info.assume_init() }.ri_phys_footprint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: u32, name: &str) -> Proc {
        Proc {
            pid,
            parent: Some(parent),
            name: name.to_owned(),
            cmd: String::new(),
            private_bytes: 0,
        }
    }

    /// The app (10) with a child and a grandchild, launchd's WebKit services (20, 21) and an
    /// unrelated process (30).
    fn processes() -> Vec<Proc> {
        vec![
            proc(1, 0, "launchd"),
            proc(10, 5, "memry-tauri"),
            proc(11, 10, "bwrap"),
            proc(12, 11, "WebKitWebProcess"),
            proc(20, 1, "com.apple.WebKit.WebContent"),
            proc(21, 1, "com.apple.WebKit.GPU"),
            proc(30, 1, "com.apple.WebKit.WebContent"),
        ]
    }

    #[test]
    fn the_responsibility_api_adds_the_xpc_services_the_app_is_charged_with() {
        let responsible = |pid| matches!(pid, 20 | 21).then_some(10);
        let attribution = attribute(&processes(), 10, Responsibility::Api(&responsible));
        assert_eq!(attribution.pids, vec![10, 11, 12, 20, 21]);
        assert_eq!(
            (attribution.method, attribution.error),
            ("tree+responsibility", None)
        );
    }

    #[test]
    fn an_unresolved_api_reports_no_responsible_api_and_falls_back_to_the_tree() {
        let attribution = attribute(&processes(), 10, Responsibility::Unresolved);
        assert_eq!(attribution.pids, vec![10, 11, 12]);
        assert_eq!(attribution.method, "tree");
        assert_eq!(attribution.error, Some(AttributionError::NoResponsibleApi));
        assert!(
            AttributionError::NoResponsibleApi
                .to_string()
                .starts_with("NoResponsibleApi")
        );
    }

    #[test]
    fn each_web_view_names_its_content_and_gpu_processes() {
        let kinds: Vec<Kind> = processes().iter().map(|p| classify(10, p)).collect();
        use Kind::*;
        assert_eq!(kinds, [Helper, App, Helper, WebView, WebView, Gpu, WebView]);
        let webview2 = |args: &str| Proc {
            cmd: format!("msedgewebview2.exe {args}"),
            ..proc(40, 10, "msedgewebview2.exe")
        };
        assert_eq!(classify(10, &webview2("--type=renderer --x")), WebView);
        assert_eq!(classify(10, &webview2("--type=gpu-process")), Gpu);
        assert_eq!(
            classify(10, &webview2("--embedded-browser-webview=1")),
            Helper
        );
    }

    #[test]
    fn pss_comes_from_its_own_line() {
        let rollup = "55d0-7ff rw-p 00000000 00:00 0 [rollup]\nRss:  20480 kB\nPss:  12345 kB\nPss_Anon:  100 kB\n";
        assert_eq!(parse_pss_kib(rollup), Some(12345));
        assert_eq!(parse_pss_kib("Rss: 1 kB\n"), None);
    }

    /// This test process, measured the way the app's processes are.
    #[test]
    fn the_running_process_has_a_charge() {
        let me = std::process::id();
        let found = snapshot().into_iter().find(|p| p.pid == me).expect("self");
        assert!(charged_bytes(&found).is_some_and(|bytes| bytes > 0));
    }
}
