//! What the vault watcher costs on the `pnpm seed1k` bench vault (#3529 acceptance: start under
//! 300 ms, idle CPU under 1 % over 60 s). A measurement, not a test: it prints and asserts no
//! time.
//!
//! ```text
//! pnpm seed1k --vault=/tmp/seed1k
//! MEMRY_BENCH_VAULT=/tmp/seed1k cargo test -p memry-desktop --release --test watch_perf \
//!   -- --ignored --nocapture
//! ```
//!
//! The vault is copied, its notes get the `note_files` rows an indexed vault has (path, size,
//! hash, read time), one new file is written as if while the app was closed, and the watcher
//! starts on it as a reopen does. Two numbers for the start: until
//! `VaultWatcher::start` returns (the OS watch is armed), and until the start rescan's
//! `Rescanned` signal (the vault walked and every row's file looked for; edits are the
//! consumer's open walk, not the watcher's). Idle CPU is this process's user and
//! system time over 60 s with nothing changing, which is the watcher's worker alone.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::storage::OpenOptions;
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::watch::{EchoGuard, EventSink, NewFiles, VaultEvent, VaultWatcher};

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        // The Electron databases of the seed; this app keeps its own under `.memry/core`.
        if name == ".memry" {
            continue;
        }
        let target = to.join(&name);
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// The vault's markdown files, and how many folders hold them (the root included).
fn markdown(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> usize {
    let mut folders = 1;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if !path.file_name().unwrap().to_string_lossy().starts_with('.') {
                folders += markdown(root, &path, out);
            }
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(path.strip_prefix(root).unwrap().to_path_buf());
        }
    }
    folders
}

fn cpu_time() -> Duration {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: `getrusage` fills the struct it is given.
    let usage = unsafe {
        assert_eq!(libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()), 0);
        usage.assume_init()
    };
    let of = |t: libc::timeval| {
        Duration::from_secs(t.tv_sec as u64) + Duration::from_micros(t.tv_usec as u64)
    };
    of(usage.ru_utime) + of(usage.ru_stime)
}

#[test]
#[ignore = "a measurement on the seed1k vault; see the module doc"]
fn watch_perf_seed1k() {
    let seed = PathBuf::from(
        std::env::var_os("MEMRY_BENCH_VAULT").expect("MEMRY_BENCH_VAULT: a pnpm seed1k vault"),
    );
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    copy_tree(&seed, &root);
    let core = root.join(".memry/core");
    std::fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    let mut notes = Vec::new();
    let folders = markdown(&root, &root, &mut notes);
    let files = vault.note_files();
    let read_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    for (n, rel) in notes.iter().enumerate() {
        let text = std::fs::read_to_string(root.join(rel)).unwrap();
        files
            .upsert_stat(NoteFileStat {
                note_id: format!("n{n}"),
                path: rel.to_string_lossy().replace('\\', "/"),
                file_type: "markdown".into(),
                mime_type: None,
                file_size: Some(text.len() as i64),
                content_hash: Some(content_hash(&text)),
                indexed_at: read_at,
            })
            .unwrap();
    }

    // One file new since the last session: the start rescan's walk must list it, which shows
    // the walk covered the vault.
    std::fs::write(
        root.join(&notes[0]).with_file_name("new while closed.md"),
        "new\n",
    )
    .unwrap();

    let log: Arc<Mutex<Vec<(Instant, VaultEvent)>>> = Arc::default();
    let sink: EventSink = {
        let log = log.clone();
        Arc::new(move |event| log.lock().unwrap().push((Instant::now(), event)))
    };
    let started = Instant::now();
    let mut watcher = VaultWatcher::start(
        root.clone(),
        Vec::new(),
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink,
        NewFiles::Report,
    )
    .unwrap();
    let armed = started.elapsed();
    let deadline = Instant::now() + Duration::from_secs(60);
    let rescanned = loop {
        let found = log
            .lock()
            .unwrap()
            .iter()
            .find(|(_, e)| matches!(e, VaultEvent::Rescanned { .. }))
            .map(|(at, e)| (*at - started, e.clone()));
        if let Some(found) = found {
            break found;
        }
        // timing-bound: a watchdog; the start rescan signals in milliseconds, 60 s is its hang.
        assert!(Instant::now() < deadline, "no start rescan");
        std::thread::sleep(Duration::from_millis(1));
    };
    assert!(
        matches!(
            rescanned.1,
            VaultEvent::Rescanned {
                added: 1,
                missing: 0,
                ..
            }
        ),
        "{:?}",
        rescanned.1
    );
    eprintln!(
        "watch_perf: {} notes in {folders} folders; start returned after {armed:?}; \
         start rescan signalled after {:?} ({:?})",
        notes.len(),
        rescanned.0,
        rescanned.1
    );

    let events_before = log.lock().unwrap().len();
    let (cpu, wall) = (cpu_time(), Instant::now());
    std::thread::sleep(Duration::from_secs(60));
    let (cpu, wall) = (cpu_time() - cpu, wall.elapsed());
    eprintln!(
        "watch_perf: idle {wall:?}: cpu {cpu:?} = {:.3} % of one core; {} events meanwhile",
        cpu.as_secs_f64() / wall.as_secs_f64() * 100.0,
        log.lock().unwrap().len() - events_before
    );
    watcher.stop();
}
