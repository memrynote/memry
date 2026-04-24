// Shared bench utility — dumps renderer-collected results to /tmp for the
// orchestrator to pick up.

use std::fs;
use std::path::PathBuf;

#[tauri::command]
pub fn bench_dump_results(option: String, json: String) -> Result<String, String> {
    let path: PathBuf = PathBuf::from(format!("/tmp/s3-{}-results.json", option));
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
