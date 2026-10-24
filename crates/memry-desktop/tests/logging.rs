use memry_desktop::logging::{self, BuildKind};
use memry_desktop::paths::AppPaths;

// One test per binary: `logging::init` installs the global subscriber.
#[test]
fn log_startup_writes_the_marker_line_into_main_log() {
    let tmp = tempfile::tempdir().expect("temp dir");
    let paths = AppPaths {
        data_dir: tmp.path().join("data"),
        log_dir: tmp.path().join("logs"),
    };

    let guard = logging::init(&paths);
    logging::log_startup("0.0.0", BuildKind::Dev);
    logging::log_startup("1.2.3", BuildKind::Packaged);
    drop(guard);

    let log = std::fs::read_to_string(paths.log_dir.join("main.log")).expect("main.log exists");
    let lines: Vec<&str> = log.lines().collect();
    assert!(
        lines
            .iter()
            .any(|l| l.ends_with("MemryNote 0.0.0 starting (dev)")),
        "log was: {log}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.ends_with("MemryNote 1.2.3 starting (packaged)"))
    );
    assert!(!log.contains('\u{1b}'), "no ANSI escapes in the file");
}
