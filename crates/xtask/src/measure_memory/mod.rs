//! `cargo xtask measure-memory`: the idle memory of the Tauri app and its web view processes,
//! replacing `apps/desktop/scripts/measure-memory.ts` (Electron `getAppMetrics`).
//!
//! Each run launches the app on a fresh profile ([`launch`]), waits for the vault to open,
//! idles, then sums the processes the app owns ([`processes`]): app, web view, GPU and helper
//! subtotals and the total, in MiB.

pub mod launch;
pub mod processes;

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};

use processes::{Kind, Proc};

pub const USAGE: &str = "usage: cargo xtask measure-memory --app <path> [--vault <dir>] [--runs 3] [--idle 60] [--out <file.json>] [--tauri-appimage]";

#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    pub app: PathBuf,
    pub vault: Option<PathBuf>,
    pub runs: usize,
    pub idle_secs: u64,
    pub out: Option<PathBuf>,
    pub tauri_appimage: bool,
}

/// `--flag value` or `--flag=value`, after the `--` that `pnpm bench:memory -- ...` passes on.
pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let args = match args {
        [first, rest @ ..] if first == "--" => rest,
        _ => args,
    };
    let (mut app, mut vault, mut out) = (None, None, None);
    let (mut runs, mut idle_secs, mut tauri_appimage) = (3, 60, false);
    let positive = |flag: &str, value: String| {
        value
            .parse::<u64>()
            .ok()
            .filter(|n| *n >= 1)
            .ok_or(format!("{flag} must be an integer >= 1"))
    };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_owned())),
            None => (arg.as_str(), None),
        };
        if flag == "--tauri-appimage" && inline.is_none() {
            tauri_appimage = true;
            continue;
        }
        let value = inline
            .or_else(|| rest.next().cloned())
            .ok_or(format!("{flag} needs a value\n{USAGE}"))?;
        match flag {
            "--app" => app = Some(PathBuf::from(value)),
            "--vault" => vault = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            "--runs" => runs = positive(flag, value)? as usize,
            "--idle" => idle_secs = positive(flag, value)?,
            other => return Err(format!("unknown argument: {other}\n{USAGE}")),
        }
    }
    Ok(Args {
        app: app.ok_or(format!("--app is required\n{USAGE}"))?,
        vault,
        runs,
        idle_secs,
        out,
        tauri_appimage,
    })
}

/// One process of a sample.
#[derive(Debug, Clone)]
pub struct Measured {
    pub pid: u32,
    pub name: String,
    pub kind: Kind,
    pub bytes: u64,
}

#[derive(Debug)]
pub struct Sample {
    pub processes: Vec<Measured>,
    pub method: &'static str,
    pub warnings: Vec<String>,
    pub ready_ms: u128,
}

impl Sample {
    pub fn subtotal(&self, kind: Kind) -> u64 {
        self.processes
            .iter()
            .filter(|p| p.kind == kind)
            .map(|p| p.bytes)
            .sum()
    }

    pub fn total(&self) -> u64 {
        self.processes.iter().map(|p| p.bytes).sum()
    }
}

/// The processes `root` owns in `procs`, each with its kind and charge. A process that exited
/// between the snapshot and its read is left out with a warning.
pub fn measure(
    procs: &[Proc],
    root: u32,
    attribution: processes::Attribution,
    charged: impl Fn(&Proc) -> Option<u64>,
) -> Sample {
    let mut warnings: Vec<String> = attribution.error.iter().map(|e| e.to_string()).collect();
    let mut measured = Vec::new();
    for pid in attribution.pids {
        let Some(proc) = procs.iter().find(|p| p.pid == pid) else {
            continue;
        };
        match charged(proc) {
            Some(bytes) => measured.push(Measured {
                pid,
                name: proc.name.clone(),
                kind: processes::classify(root, proc),
                bytes,
            }),
            None => warnings.push(format!("pid {pid} ({}) was not readable", proc.name)),
        }
    }
    Sample {
        processes: measured,
        method: attribution.method,
        warnings,
        ready_ms: 0,
    }
}

fn mib(bytes: u64) -> f64 {
    (bytes as f64 / 1024.0 / 1024.0 * 10.0).round() / 10.0
}

fn median(mut values: Vec<u64>) -> u64 {
    values.sort_unstable();
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2
    }
}

fn subtotals_json(subtotal: impl Fn(Kind) -> u64, total: u64) -> Value {
    let mut map = serde_json::Map::new();
    for kind in Kind::ALL {
        map.insert(format!("{}MiB", kind.label()), json!(mib(subtotal(kind))));
    }
    map.insert("totalMiB".to_owned(), json!(mib(total)));
    Value::Object(map)
}

/// The JSON report: per run the processes and subtotals, and the median of each subtotal.
pub fn report(args: &Args, vault: &std::path::Path, samples: &[Sample]) -> Value {
    let runs: Vec<Value> = samples
        .iter()
        .map(|sample| {
            json!({
                "readyMs": sample.ready_ms,
                "attribution": sample.method,
                "warnings": sample.warnings,
                "subtotals": subtotals_json(|kind| sample.subtotal(kind), sample.total()),
                "processes": sample.processes.iter().map(|p| json!({
                    "pid": p.pid,
                    "name": p.name,
                    "kind": p.kind.label(),
                    "MiB": mib(p.bytes),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let median_of = |of: &dyn Fn(&Sample) -> u64| median(samples.iter().map(of).collect());
    json!({
        "meta": {
            "measuredAt": chrono::Utc::now().to_rfc3339(),
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "metric": METRIC,
            "app": args.app,
            "vault": vault,
            "runs": args.runs,
            "idleSeconds": args.idle_secs,
        },
        "median": subtotals_json(|kind| median_of(&|s| s.subtotal(kind)), median_of(&|s| s.total())),
        "runs": runs,
    })
}

const METRIC: &str = if cfg!(target_os = "macos") {
    "ri_phys_footprint"
} else if cfg!(windows) {
    "PrivateUsage"
} else {
    "Pss"
};

fn run_once(
    executable: &std::path::Path,
    vault: &std::path::Path,
    device: &str,
    idle: Duration,
) -> Result<Sample, String> {
    let profile = launch::fresh_profile(vault).map_err(|e| format!("profile: {e}"))?;
    let mut app = launch::launch(executable, &profile, device)?;
    let sampled = (|| -> Result<Sample, String> {
        let ready = app.wait_ready()?;
        std::thread::sleep(idle);
        app.ensure_alive()?;
        let root = app.pid();
        let procs = processes::snapshot();
        let attribution =
            processes::with_responsibility(|source| processes::attribute(&procs, root, source));
        let mut sample = measure(&procs, root, attribution, processes::charged_bytes);
        sample.ready_ms = ready.as_millis();
        Ok(sample)
    })();
    let quit_warning = app.quit();
    let mut sample = sampled?;
    sample.warnings.extend(quit_warning);
    Ok(sample)
}

pub fn run(args: &[String]) -> Result<(), String> {
    let args = parse_args(args)?;
    let device = launch::device(std::env::var("MEMRY_DEVICE").ok().as_deref())?;
    let executable = launch::resolve_executable(&args.app, args.tauri_appimage)?;
    let vault = args
        .vault
        .clone()
        .or_else(crate::seed::default_bench_vault)
        .ok_or("no home folder: pass --vault")?;
    let vault = std::path::absolute(&vault).map_err(|e| format!("{}: {e}", vault.display()))?;
    if !vault.join(".memry").is_dir() {
        return Err(format!(
            "{} is not a vault; seed one first (cargo xtask seed bench --vault <dir>)",
            vault.display()
        ));
    }
    println!(
        "measure-memory: {} on {}, {} run(s), {} s idle, metric {METRIC}",
        executable.display(),
        vault.display(),
        args.runs,
        args.idle_secs
    );
    let mut samples = Vec::new();
    for run in 1..=args.runs {
        let sample = run_once(
            &executable,
            &vault,
            &device,
            Duration::from_secs(args.idle_secs),
        )?;
        println!(
            "  run {run}: total {:.1} MiB (app {:.1}, webview {:.1}, gpu {:.1}, helper {:.1}; {} processes, {}; vault ready after {} ms)",
            mib(sample.total()),
            mib(sample.subtotal(Kind::App)),
            mib(sample.subtotal(Kind::WebView)),
            mib(sample.subtotal(Kind::Gpu)),
            mib(sample.subtotal(Kind::Helper)),
            sample.processes.len(),
            sample.method,
            sample.ready_ms,
        );
        for warning in &sample.warnings {
            println!("    warning: {warning}");
        }
        samples.push(sample);
    }
    let report = report(&args, &vault, &samples);
    println!("median MiB: {}", report["median"]);
    if let Some(out) = &args.out {
        if let Some(parent) = out.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
        std::fs::write(out, text + "\n").map_err(|e| format!("{}: {e}", out.display()))?;
        println!("wrote {}", out.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::processes::{Attribution, AttributionError};
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn the_flags_take_both_spellings_and_the_app_is_required() {
        let args = parse_args(&strings(&[
            "--",
            "--app",
            "/a/M.app",
            "--runs=2",
            "--idle",
            "5",
            "--tauri-appimage",
        ]))
        .expect("parsed");
        assert_eq!(
            (args.app, args.runs, args.idle_secs, args.tauri_appimage),
            (PathBuf::from("/a/M.app"), 2, 5, true)
        );
        assert!(parse_args(&strings(&["--runs", "2"])).is_err());
        assert!(parse_args(&strings(&["--app", "x", "--idle", "0"])).is_err());
    }

    #[test]
    fn subtotals_sum_by_kind_and_a_vanished_process_is_a_warning() {
        let proc = |pid, name: &str| Proc {
            pid,
            parent: Some(1),
            name: name.to_owned(),
            cmd: String::new(),
            private_bytes: 0,
        };
        let procs = vec![
            proc(10, "memry-tauri"),
            proc(20, "com.apple.WebKit.WebContent"),
            proc(21, "com.apple.WebKit.Networking"),
            proc(22, "com.apple.WebKit.GPU"),
        ];
        let attribution = Attribution {
            pids: vec![10, 20, 21, 22],
            method: "tree",
            error: Some(AttributionError::NoResponsibleApi),
        };
        let mib = 1024 * 1024;
        let sample = measure(&procs, 10, attribution, |p| {
            (p.pid != 22).then_some(u64::from(p.pid) * mib)
        });
        assert_eq!(
            (
                sample.subtotal(Kind::App),
                sample.subtotal(Kind::WebView),
                sample.subtotal(Kind::Helper),
                sample.subtotal(Kind::Gpu),
                sample.total(),
            ),
            (10 * mib, 20 * mib, 21 * mib, 0, 51 * mib)
        );
        assert_eq!(sample.warnings.len(), 2);
        assert!(sample.warnings[0].starts_with("NoResponsibleApi"));
    }
}
