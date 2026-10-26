//! Runs the Electron converter as the oracle, in batches, for the ignored
//! differential and corpus tests. The oracle is the Vitest project
//! `markdown-oracle` (`apps/desktop/scripts/markdown-oracle/oracle-serve.oracle.ts`):
//! it reads the JSONL job file named by `MEMRY_ORACLE_IN` and writes one result
//! line per job to `MEMRY_ORACLE_OUT`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value as Json, json};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

/// One `doc-serialize` job per markdown string: `Ok(Some(output))` is what the
/// oracle answered, `Ok(None)` is "the oracle failed closed" (it threw, or it
/// answered `seeded: false`), in the order of `inputs`.
pub fn doc_serialize(inputs: &[String]) -> Result<Vec<Option<Json>>, String> {
    let jobs: Vec<Json> = inputs.iter().map(|m| json!({ "markdown": m })).collect();
    Ok(run_jobs("doc-serialize", &jobs)?
        .into_iter()
        .map(|output| output.filter(|o| o["seeded"] == Json::Bool(true)))
        .collect())
}

/// One job of `op` per input: `Some(output)` when the oracle answered, `None`
/// when it threw.
pub fn run_jobs(op: &str, inputs: &[Json]) -> Result<Vec<Option<Json>>, String> {
    let dir = tempfile::Builder::new()
        .prefix("memry-oracle-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (jobs, out) = (dir.join("jobs.jsonl"), dir.join("out.jsonl"));
    let mut lines = String::new();
    for (i, input) in inputs.iter().enumerate() {
        let job = json!({ "id": i.to_string(), "op": op, "input": input });
        lines.push_str(&job.to_string());
        lines.push('\n');
    }
    std::fs::write(&jobs, lines).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out);
    let status = Command::new("pnpm")
        .args([
            "--filter",
            "@memry/desktop",
            "exec",
            "vitest",
            "run",
            "--config",
            "config/vitest.config.ts",
            "--project",
            "markdown-oracle",
        ])
        .current_dir(repo_root())
        .env("TZ", "UTC")
        .env("MEMRY_ORACLE_IN", &jobs)
        .env("MEMRY_ORACLE_OUT", &out)
        .output()
        .map_err(|e| format!("cannot start the oracle: {e}"))?;
    if !status.status.success() {
        let both = format!(
            "{}\n{}",
            String::from_utf8_lossy(&status.stdout),
            String::from_utf8_lossy(&status.stderr)
        );
        let tail: Vec<&str> = both.lines().rev().take(40).collect();
        return Err(format!("the oracle failed:\n{}", tail.join("\n")));
    }
    let raw = std::fs::read_to_string(&out).map_err(|e| format!("no oracle output: {e}"))?;
    let mut by_id: HashMap<usize, Option<Json>> = HashMap::new();
    for line in raw.lines().filter(|l| !l.is_empty()) {
        let result: Json = serde_json::from_str(line).map_err(|e| e.to_string())?;
        let id: usize = result["id"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .ok_or("bad id")?;
        let output = (result["ok"] == Json::Bool(true)).then(|| result["output"].clone());
        by_id.insert(id, output);
    }
    let _ = std::fs::remove_dir_all(&dir);
    (0..inputs.len())
        .map(|i| {
            by_id
                .remove(&i)
                .ok_or_else(|| format!("no result for job {i}"))
        })
        .collect()
}
