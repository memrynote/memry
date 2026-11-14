//! Stamps `MEMRY_CORE_BUILD`, the core's build identity: `<package version>+<tree hash>`,
//! where the tree hash is git's hash of this crate's directory at HEAD. The core has no
//! runtime path dependency, so a commit that leaves `crates/memry-core` alone keeps the
//! identity. The refused-items ledger (`src/sync/refused_items.rs`, #4453) keys on it, so a
//! record this build's schema refused is refetched once a different core build runs. The
//! shell's app version cannot key it: iOS reports one marketing version across every
//! TestFlight build. Without git (a source export) the identity is the package version alone.

use std::path::Path;
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!text.is_empty()).then_some(text)
}

/// Reruns when HEAD moves: HEAD, the branch it names, the packed refs, and HEAD's reflog,
/// which every HEAD move appends to even after `git gc` or `git pack-refs` empties the
/// loose ref.
fn watch_head() {
    let mut paths = vec![
        "HEAD".to_owned(),
        "packed-refs".to_owned(),
        "logs/HEAD".to_owned(),
    ];
    paths.extend(git(&["symbolic-ref", "-q", "HEAD"]));
    for path in paths {
        if let Some(file) = git(&["rev-parse", "--git-path", &path])
            && Path::new(&file).exists()
        {
            println!("cargo:rerun-if-changed={file}");
        }
    }
}

fn main() {
    let version = std::env::var("CARGO_PKG_VERSION").expect("cargo sets CARGO_PKG_VERSION");
    // `HEAD:./` is the tree of the build script's directory, the crate root.
    let build = match git(&["rev-parse", "HEAD:./"]) {
        Some(tree) => {
            watch_head();
            format!("{version}+{tree}")
        }
        None => {
            println!(
                "cargo:warning=memry-core: no git tree, so MEMRY_CORE_BUILD is the package \
                 version alone; refused records are refetched only when it changes"
            );
            version
        }
    };
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rustc-env=MEMRY_CORE_BUILD={build}");
}
