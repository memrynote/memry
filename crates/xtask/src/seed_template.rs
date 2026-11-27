//! `cargo xtask seed demo|rich|small`, ported from `apps/desktop/scripts/seed-vault.ts`,
//! `seed-rich-vault.ts` and `seed-small-vault.ts`. Their output is exported once
//! (`apps/desktop/scripts/export-seed-templates.ts`) into `crates/xtask/seed-data/<profile>/`,
//! and the sandbox replay (`memry_desktop::sandbox::replay`) builds the vault from it, its
//! dates moved to today as the TypeScript seeds date everything from the day they run.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use memry_core::api::errors::SecureStoreError;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::sandbox::{ReplayOptions, SandboxError, SeedCounts, Template, replay};

/// A TypeScript seed whose output is committed under `seed-data/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    Demo,
    Rich,
    /// `seed-small-vault.ts --variant=1` ("Home & Garden") or `2` ("Language Study").
    Small(u8),
}

impl Profile {
    pub const ALL: [Profile; 4] = [
        Profile::Demo,
        Profile::Rich,
        Profile::Small(1),
        Profile::Small(2),
    ];

    /// The folder under `seed-data/` the exporter writes.
    pub fn template_dir(self) -> PathBuf {
        let name = match self {
            Profile::Demo => "demo".to_owned(),
            Profile::Rich => "rich".to_owned(),
            Profile::Small(variant) => format!("small-{variant}"),
        };
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("seed-data")
            .join(name)
    }

    /// The TypeScript seeds' default vaults: `~/MemryDemoVault`, `~/MemryRichVault`,
    /// `~/MemrySmallVault<n>`.
    pub fn default_vault(self) -> Option<PathBuf> {
        let name = match self {
            Profile::Demo => "MemryDemoVault".to_owned(),
            Profile::Rich => "MemryRichVault".to_owned(),
            Profile::Small(variant) => format!("MemrySmallVault{variant}"),
        };
        std::env::home_dir().map(|home| home.join(name))
    }
}

/// The device key the replay writes the notes under: a fresh one per run, held in memory, so a
/// seed never reads or writes the OS keychain.
#[derive(Default)]
struct SeedStore(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for SeedStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().expect("seed store").get(&key).cloned())
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().expect("seed store").insert(key, value);
        Ok(())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().expect("seed store").remove(&key);
        Ok(())
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().expect("seed store").clear();
        Ok(())
    }
}

/// A store holding a new device signing key.
pub fn seed_store() -> Result<Arc<dyn SecureStore>, String> {
    let (_, secret) = sodium::sign_keypair().map_err(|error| error.to_string())?;
    let store = SeedStore::default();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .map_err(|error| error.to_string())?;
    Ok(Arc::new(store))
}

/// Replays `profile` into `vault` with its dates moved to `now`'s local day. Only a missing or
/// empty folder, or a vault an earlier seed or sandbox wrote, is written: the replay refuses
/// any other folder before it writes anything.
pub fn seed_profile(
    profile: Profile,
    vault: &Path,
    now: DateTime<Utc>,
    store: Arc<dyn SecureStore>,
) -> Result<SeedCounts, SandboxError> {
    let dir = profile.template_dir();
    // The exporter writes every file into `vault/`: no asset copies.
    let template = Template::load(&dir, &dir)?;
    let options = ReplayOptions {
        rebase_dates: true,
        now,
        replace: true,
    };
    replay(
        &template,
        &std::path::absolute(vault).map_err(|error| SandboxError::Io {
            path: vault.display().to_string(),
            message: error.to_string(),
        })?,
        &options,
        store,
    )
}

/// `seed demo|rich|small [--vault <dir>] [--variant 1|2]`, after the `--` pnpm passes on.
pub fn parse(args: &[String]) -> Result<(Profile, Option<PathBuf>), String> {
    let (kind, rest) = args.split_first().ok_or("missing seed profile")?;
    let rest = match rest {
        [first, rest @ ..] if first == "--" => rest,
        _ => rest,
    };
    let mut vault = None;
    let mut variant = None;
    let mut iter = rest.iter();
    while let Some(arg) = iter.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_owned())),
            None => (arg.as_str(), None),
        };
        let value = inline
            .or_else(|| iter.next().cloned())
            .ok_or(format!("{flag} needs a value"))?;
        match flag {
            "--vault" => vault = Some(PathBuf::from(value)),
            "--variant" if kind == "small" => match value.as_str() {
                "1" | "2" => variant = value.parse().ok(),
                _ => return Err(format!("--variant must be 1 or 2, got: {value}")),
            },
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    let profile = match kind.as_str() {
        "demo" => Profile::Demo,
        "rich" => Profile::Rich,
        // `seed-small-vault.ts` defaults to variant 1.
        "small" => Profile::Small(variant.unwrap_or(1)),
        other => return Err(format!("unknown seed profile: {other}")),
    };
    Ok((profile, vault))
}

/// `cargo xtask seed demo|rich|small ...`.
pub fn run(args: &[String]) -> Result<(), String> {
    let (profile, vault) = parse(args)?;
    let vault = vault
        .or_else(|| profile.default_vault())
        .ok_or("no home folder: pass --vault")?;
    println!("Seeding {profile:?} vault at: {}", vault.display());
    let counts = seed_profile(profile, &vault, Utc::now(), seed_store()?)
        .map_err(|error| error.to_string())?;
    println!(
        "Seeded {} notes, {} journal entries, {} files, {} canvases.",
        counts.notes, counts.journal_entries, counts.files, counts.canvases
    );
    println!("Vault path: {}", vault.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn flags_parse_as_the_typescript_seeds_take_them() {
        let (profile, vault) =
            parse(&args(&["small", "--", "--variant=2", "--vault", "/v"])).expect("parsed");
        assert_eq!(
            (profile, vault),
            (Profile::Small(2), Some(PathBuf::from("/v")))
        );
        assert_eq!(
            parse(&args(&["small"])).expect("parsed").0,
            Profile::Small(1)
        );
        assert!(parse(&args(&["small", "--variant=3"])).is_err());
        assert!(parse(&args(&["demo", "--variant=1"])).is_err());
        assert!(parse(&args(&["bulk"])).is_err());
    }
}
