//! `cargo xtask <task>`; the alias lives in `crates/.cargo/config.toml`.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use xtask::seed::{self, DEFAULT_COUNT, DEFAULT_SEED};

const USAGE: &str = "usage: cargo xtask seed bench [--vault <dir>] [--count <n>] [--seed <s>]";

struct BenchArgs {
    vault: Option<PathBuf>,
    count: usize,
    seed: u32,
}

/// `--flag value` or `--flag=value`, after the `--` that `pnpm seed1k -- ...` passes on.
fn parse_bench(args: &[String]) -> Result<BenchArgs, String> {
    let args = match args {
        [first, rest @ ..] if first == "--" => rest,
        _ => args,
    };
    let mut parsed = BenchArgs {
        vault: None,
        count: DEFAULT_COUNT,
        seed: DEFAULT_SEED,
    };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_owned())),
            None => (arg.as_str(), None),
        };
        let mut value = || {
            inline
                .clone()
                .or_else(|| rest.next().cloned())
                .ok_or(format!("{flag} needs a value"))
        };
        match flag {
            "--vault" => parsed.vault = Some(PathBuf::from(value()?)),
            "--count" => {
                parsed.count = value()?
                    .parse()
                    .ok()
                    .filter(|count| *count >= 1)
                    .ok_or("--count must be an integer >= 1")?;
            }
            "--seed" => {
                parsed.seed = value()?
                    .parse()
                    .map_err(|_| "--seed must be an integer from 0 to 4294967295")?;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(parsed)
}

fn seed_bench(args: &[String]) -> Result<(), String> {
    let args = parse_bench(args)?;
    let vault = args
        .vault
        .or_else(seed::default_bench_vault)
        .ok_or("no home folder: pass --vault")?;
    println!("Seeding benchmark vault at: {}", vault.display());
    println!("  → {} notes, seed {}", args.count, args.seed);
    let started = Instant::now();
    let summary =
        seed::seed_bench(&vault, args.count, args.seed).map_err(|error| error.to_string())?;
    let mib = summary.bytes as f64 / 1024.0 / 1024.0;
    println!(
        "Seeded {} notes across {} folders, {} tags, {mib:.2} MB of markdown (avg {} bytes/note) in {:.1} s.",
        summary.notes,
        summary.folders,
        summary.tags,
        summary.bytes / summary.notes as u64,
        started.elapsed().as_secs_f64(),
    );
    println!("Vault path: {}", summary.vault.display());
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["seed", "demo" | "rich" | "small", ..] => xtask::seed_template::run(&args[1..]),
        ["seed", "bench", ..] => seed_bench(&args[2..]),
        _ => Err(USAGE.to_owned()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn a_leading_double_dash_from_pnpm_is_skipped() {
        let parsed = parse_bench(&args(&["--", "--count=5000", "--seed", "7"])).expect("parsed");
        assert_eq!((parsed.count, parsed.seed), (5000, 7));
        assert!(parse_bench(&args(&["--count=5", "--"])).is_err());
    }
}
