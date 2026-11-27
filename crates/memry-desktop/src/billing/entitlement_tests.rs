//! Ported from Electron's `billing/entitlement-cache.test.ts`, over a real `memry-config.json`.

use std::sync::Arc;

use memry_core::protocol::billing::BillingSnapshot;
use serde_json::{Value, json};

use super::*;

const NOW_MS: i64 = 1_800_000_000_000;
const NOW_SECS: i64 = NOW_MS / 1000;
const SECOND: i64 = 1000;
const MB5: i64 = 5 * 1024 * 1024;

fn snapshot(plan: &str, status: &str, expires_at: Option<i64>) -> BillingSnapshot {
    BillingSnapshot {
        plan: plan.into(),
        cadence: None,
        status: status.into(),
        email: None,
        storage_limit: 0,
        max_file_size: MB5,
        max_vaults: Some(0),
        version_history_days: 0,
        storage_used: 0,
        expires_at,
        can_manage_billing: false,
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    config: Arc<AppConfig>,
    cache: EntitlementCache,
}

/// A config file holding `file`, as another build left it.
fn fixture(file: Value) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memry-config.json");
    std::fs::write(&path, file.to_string()).unwrap();
    let config = Arc::new(AppConfig::load(path));
    Fixture {
        _dir: dir,
        cache: EntitlementCache::new(config.clone()),
        config,
    }
}

fn entitlement(value: Value) -> Fixture {
    fixture(json!({ "sync": { "entitlement": value } }))
}

#[test]
fn is_paid_billing_status_is_true_only_for_a_non_free_active_plan() {
    assert!(is_paid(&snapshot("plus", "active", None), NOW_SECS));
    assert!(is_paid(&snapshot("pro", "active", None), NOW_SECS));
    assert!(!is_paid(&snapshot("free", "active", None), NOW_SECS));
    assert!(!is_paid(&snapshot("plus", "canceled", None), NOW_SECS));
    assert!(!is_paid(&snapshot("plus", "past_due", None), NOW_SECS));
}

#[test]
fn is_paid_billing_status_is_false_for_an_active_plan_whose_expiry_has_passed() {
    assert!(!is_paid(
        &snapshot("plus", "active", Some(NOW_SECS - 60)),
        NOW_SECS
    ));
    assert!(!is_paid(
        &snapshot("plus", "active", Some(NOW_SECS)),
        NOW_SECS
    ));
    assert!(is_paid(
        &snapshot("plus", "active", Some(NOW_SECS + 3600)),
        NOW_SECS
    ));
}

#[test]
fn get_cached_entitlement_returns_none_when_nothing_cached() {
    assert_eq!(fixture(json!({})).cache.get(), None);
    assert_eq!(fixture(json!({ "sync": {} })).cache.get(), None);
    assert_eq!(
        entitlement(json!({ "plan": "plus" })).cache.get(),
        None,
        "an object without isPaid is no verdict"
    );
}

/// Every TTL edge of `isCachedUnpaidFresh` and `getCachedMaxFileSize`, as `(cachedAt offset,
/// unpaid fresh, max file size)`. `None` offsets are stores written before `cachedAt` existed.
#[test]
fn cache_ttl_table() {
    let rows: [(&str, Option<i64>, bool, Option<i64>); 8] = [
        ("just written", Some(0), true, Some(MB5)),
        (
            "unpaid fresh at 3599 s",
            Some(-3599 * SECOND),
            true,
            Some(MB5),
        ),
        (
            "unpaid at exactly the TTL",
            Some(-UNPAID_ENTITLEMENT_TTL_MS),
            true,
            Some(MB5),
        ),
        (
            "unpaid stale at 3601 s",
            Some(-3601 * SECOND),
            false,
            Some(MB5),
        ),
        (
            "limits fresh at 24 h less 1 s",
            Some(-ENTITLEMENT_LIMITS_TTL_MS + SECOND),
            false,
            Some(MB5),
        ),
        (
            "limits stale at 24 h plus 1 s",
            Some(-ENTITLEMENT_LIMITS_TTL_MS - SECOND),
            false,
            None,
        ),
        (
            "future cachedAt fails open",
            Some(60 * 60 * SECOND),
            false,
            None,
        ),
        ("no cachedAt is stale", None, false, None),
    ];
    for (name, offset, unpaid_fresh, max_file_size) in rows {
        let mut value = json!({
            "isPaid": false, "plan": "free", "status": "inactive",
            "limits": { "maxFileSize": MB5 },
        });
        if let Some(offset) = offset {
            value["cachedAt"] = json!(NOW_MS + offset);
        }
        let f = entitlement(value);
        let cached = f.cache.get().expect(name);
        assert_eq!(
            cached.is_unpaid_fresh(NOW_MS),
            unpaid_fresh,
            "{name}: unpaid fresh"
        );
        assert_eq!(
            f.cache.max_file_size(NOW_MS),
            max_file_size,
            "{name}: max file size"
        );
    }
}

#[test]
fn a_paid_verdict_is_never_unpaid_fresh() {
    let f = entitlement(
        json!({ "isPaid": true, "plan": "plus", "status": "active", "cachedAt": NOW_MS }),
    );
    assert!(!f.cache.get().unwrap().is_unpaid_fresh(NOW_MS));
}

#[test]
fn get_cached_max_file_size_fails_open_on_absent_or_non_positive_limits() {
    for limits in [
        json!(null),
        json!({}),
        json!({ "maxFileSize": 0 }),
        json!({ "maxFileSize": -1 }),
    ] {
        let mut value =
            json!({ "isPaid": true, "plan": "plus", "status": "active", "cachedAt": NOW_MS });
        if !limits.is_null() {
            value["limits"] = limits.clone();
        }
        assert_eq!(
            entitlement(value).cache.max_file_size(NOW_MS),
            None,
            "{limits}"
        );
    }
}

#[test]
fn set_cached_entitlement_from_status_writes_electrons_shape_and_keeps_other_keys() {
    let f = fixture(json!({
        "sync": { "email": "a@b.c", "recoveryPhraseConfirmed": true },
        "theme": "dark",
    }));
    let cached = f
        .cache
        .set_from_snapshot(&snapshot("plus", "active", None), NOW_MS)
        .unwrap();
    assert!(cached.is_paid);

    let on_disk: Value = serde_json::from_slice(&std::fs::read(f.config.path()).unwrap()).unwrap();
    assert_eq!(
        on_disk,
        json!({
            "sync": {
                "email": "a@b.c",
                "recoveryPhraseConfirmed": true,
                "entitlement": {
                    "isPaid": true, "plan": "plus", "status": "active",
                    "limits": { "maxFileSize": MB5 }, "cachedAt": NOW_MS,
                },
            },
            "theme": "dark",
        })
    );
    assert_eq!(f.cache.max_file_size(NOW_MS), Some(MB5));
}

#[test]
fn invalidate_cached_entitlement_limits_drops_the_limit_so_the_next_preflight_fails_open() {
    let f = fixture(json!({}));
    f.cache
        .set_from_snapshot(&snapshot("plus", "active", None), NOW_MS)
        .unwrap();
    f.cache.invalidate_limits().unwrap();

    assert_eq!(f.cache.max_file_size(NOW_MS), None);
    let cached = f.cache.get().unwrap();
    assert!(cached.is_paid, "the verdict stays for the sync start");
    assert_eq!(cached.plan, "plus");
    assert_eq!((cached.max_file_size, cached.cached_at), (None, None));
}

#[test]
fn invalidate_cached_entitlement_limits_is_a_no_op_on_a_cold_cache() {
    let f = fixture(json!({ "theme": "dark" }));
    f.cache.invalidate_limits().unwrap();
    assert_eq!(f.cache.get(), None);
    assert_eq!(
        f.config.read(|config| Value::Object(config.clone())),
        json!({ "theme": "dark" })
    );
}

/// Electron's `electron-store` file, as an Electron build of `main` writes it: the same verdicts.
#[test]
fn an_electron_written_entitlement_reads_the_same() {
    let f = fixture(json!({
        "sync": {
            "deviceId": "d-1",
            "entitlement": {
                "isPaid": false, "plan": "free", "status": "inactive",
                "limits": { "maxFileSize": 5242880.0 }, "cachedAt": NOW_MS - 10 * SECOND,
            },
        },
    }));
    let cached = f.cache.get().unwrap();
    assert!(cached.is_unpaid_fresh(NOW_MS));
    assert_eq!(cached.max_file_size(NOW_MS), Some(MB5));

    let older = entitlement(json!({ "isPaid": true, "plan": "pro", "status": "active" }));
    let cached = older
        .cache
        .get()
        .expect("a file without limits or cachedAt still loads");
    assert!(cached.is_paid);
    assert_eq!(cached.max_file_size(NOW_MS), None);
}
