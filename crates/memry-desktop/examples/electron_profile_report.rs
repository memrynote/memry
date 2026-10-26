//! Prints a JSON report of what the Electron profile readers find on this machine: counts,
//! verdicts, the app name that decrypted and the unreadable reasons. It never prints a value, a
//! note body or a localStorage entry, and it never writes to the profile.
//!
//! `cargo run -p memry-desktop --example electron_profile_report [-- --timeout-secs 60]`
//!
//! `MEMRY_ELECTRON_PROFILE_DIR` replaces the profile search. The Keychain, libsecret or KWallet
//! prompt for the Electron app's key appears once; the timeout bounds each OS call.

use std::process::ExitCode;
use std::time::Duration;

use memry_desktop::electron_import::secrets::{
    Guarded, OsKeySource, OsKeytar, SecretSource, read_all_secrets,
};
use memry_desktop::electron_import::{
    CustomDictionary, ElectronConfig, ElectronProfile, ImportError, LocalStorageSnapshot,
    ProfileEnv, ProfileLock, Scratch, YStoreReader, profile,
};
use memry_desktop::launch_env::LaunchEnv;
use serde_json::{Value, json};

const SYNC_SERVICE: &str = "com.memry.sync";
const SYNC_ACCOUNTS: [&str; 5] = [
    "master-key",
    "device-signing-key",
    "access-token",
    "refresh-token",
    "setup-token",
];

fn timeout_arg() -> Duration {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--timeout-secs"
            && let Some(secs) = args.next().and_then(|v| v.parse().ok())
        {
            return Duration::from_secs(secs);
        }
    }
    Duration::from_secs(60)
}

fn error_json(error: &ImportError) -> Value {
    json!({ "error": error.to_string() })
}

/// A scratch copy of a CRDT store holds note history, so it lives under the app data dir (next
/// to, not inside, the Electron profile) and never under the system temp dir.
fn report(
    profile: &ElectronProfile,
    app_data: &std::path::Path,
    timeout: Duration,
) -> Result<Value, ImportError> {
    ProfileLock::probe(profile)?;
    let scratch = Scratch::new(app_data.join("memry-import-scratch"))?;

    let config = ElectronConfig::read(profile)?;
    let config_json = match &config {
        None => json!(null),
        Some(config) => {
            let (vaults, skipped) = config.vaults();
            json!({
                "vaults": vaults.len(),
                "skippedVaultEntries": skipped,
                "currentVault": config.current_vault().is_some(),
                "locale": config.locale(),
                "deviceId": config.device_id().is_some(),
                "email": config.email().is_some(),
                "legacyStoreClaimed": config.legacy_store_claimed_by().is_some(),
                "legacyPartitionPending": config.legacy_store_partition_pending_for().is_some(),
            })
        }
    };

    let keys = Guarded::with_timeout(OsKeySource, timeout);
    let keytar = Guarded::with_timeout(OsKeytar, timeout);
    let secrets = read_all_secrets(profile, &keys, &keytar)?;
    let sync_decrypted = SYNC_ACCOUNTS
        .iter()
        .filter(|account| secrets.get(SYNC_SERVICE, account).is_some())
        .count();
    let entries: Vec<Value> = secrets
        .entries
        .iter()
        .map(|e| {
            json!({
                "service": e.service,
                "account": e.account,
                "source": match e.source {
                    SecretSource::SafeStorage => "safeStorage",
                    SecretSource::Keytar => "keytar",
                },
            })
        })
        .collect();
    let unreadable: Vec<Value> = secrets
        .unreadable
        .iter()
        .map(|u| json!({ "service": u.service, "account": u.account, "reason": format!("{:?}", u.reason), "detail": u.detail }))
        .collect();

    let dictionary = CustomDictionary::read(profile)?.map(|d| {
        json!({ "words": d.words.len(), "checksumOk": d.checksum_ok, "fromBackup": d.from_backup })
    });
    let local_storage = LocalStorageSnapshot::read(
        profile,
        memry_desktop::electron_import::local_storage::PACKAGED_ORIGIN,
        &scratch,
    )?
    .map(|s| {
        json!({ "entries": s.entries.len(), "skipped": s.skipped, "tornTails": torn_json(&s.torn_tails) })
    });

    let mut stores = Vec::new();
    let vaults = config.as_ref().map(|c| c.vaults().0).unwrap_or_default();
    for vault in vaults.iter().filter_map(|v| v.vault_uuid.as_deref()) {
        let store = YStoreReader::open(profile, vault, config.as_ref(), &scratch)?;
        stores.push(match store {
            None => json!({ "vault": "missing-store" }),
            Some(store) => {
                let mut value = store_json(&store);
                value["previousStoreAlsoPresent"] = json!(
                    YStoreReader::unread_previous_store(profile, vault, config.as_ref()).is_some()
                );
                value
            }
        });
    }
    let legacy = YStoreReader::open_legacy(profile, &scratch)?.map(|s| store_json(&s));

    Ok(json!({
        "profile": {
            "appNameCandidates": profile.app_names.0,
            "pin": profile.pin.as_ref().map(|p| json!({ "appName": p.app_name, "flipped": p.flipped })),
            "hasConfig": profile.has_config,
            "hasSecureStore": profile.has_secure_store,
            "hasLocalState": profile.has_local_state,
            "hasLocalStorage": profile.has_local_storage,
            "hasLegacyCrdtStore": profile.has_legacy_crdt_store,
            "hasCustomDictionary": profile.has_custom_dictionary,
            "crdtStoreDirs": profile.crdt_store_dirs.len(),
        },
        "config": config_json,
        "secrets": {
            "decrypted": entries.len(),
            "syncSecretsDecrypted": sync_decrypted,
            "unreadable": unreadable.len(),
            "entries": entries,
            "unreadableEntries": unreadable,
            "keytarError": secrets.keytar_error,
        },
        "dictionary": dictionary,
        "localStorage": local_storage,
        "ystores": stores,
        "legacyYstore": legacy,
    }))
}

fn torn_json(torn: &[memry_desktop::electron_import::TornFile]) -> Value {
    torn.iter()
        .map(|t| json!({ "file": t.file, "offset": t.offset, "droppedBytes": t.dropped_bytes }))
        .collect()
}

fn store_json(store: &YStoreReader) -> Value {
    let names = store.doc_names();
    let updates: usize = names.iter().map(|n| store.updates(n).len()).sum();
    json!({
        "docs": names.len(),
        "updates": updates,
        "withWatermark": names.iter().filter(|n| store.watermark(n).is_some()).count(),
        "ignoredKeys": store.ignored_keys(),
        "tornTails": torn_json(store.torn_tails()),
        "hasEpoch": store.store_epoch().is_some(),
    })
}

fn main() -> ExitCode {
    let env = LaunchEnv::from_process();
    let Some(profile_env) = ProfileEnv::from_host(&env) else {
        println!(
            "{}",
            json!({ "error": "cannot derive the app data directory" })
        );
        return ExitCode::FAILURE;
    };
    let profile = match profile::locate_profile(&profile_env) {
        Ok(Some(profile)) => profile,
        Ok(None) => {
            println!("{}", json!({ "profile": null }));
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            println!("{}", error_json(&error));
            return ExitCode::FAILURE;
        }
    };
    match report(&profile, &profile_env.app_data, timeout_arg()) {
        Ok(report) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&report).unwrap_or_default()
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", error_json(&error));
            ExitCode::FAILURE
        }
    }
}
