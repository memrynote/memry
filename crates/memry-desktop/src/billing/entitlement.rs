//! The cached plan verdict in `memry-config.json` `sync.entitlement`, ported from Electron's
//! `billing/entitlement-cache.ts`. Electron writes the same object, and both builds read each
//! other's: `{ isPaid, plan, status, limits?: { maxFileSize }, cachedAt? }`, `cachedAt` in epoch
//! milliseconds.

use std::sync::Arc;

use memry_core::protocol::billing::BillingSnapshot;
use serde_json::{Map, Value, json};

use crate::registry::config::{AppConfig, ConfigError};

/// How long a cached plan limit may be trusted by the upload preflight
/// (`ENTITLEMENT_LIMITS_TTL_MS`). Nothing refreshes the cache in the background, so a stale
/// limit fails open rather than blocking an upload the server would accept.
pub const ENTITLEMENT_LIMITS_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// How long a cached unpaid verdict gates the sync start before the server is asked again
/// (`UNPAID_ENTITLEMENT_TTL_MS`). A paid verdict needs no TTL: the server checks every request.
pub const UNPAID_ENTITLEMENT_TTL_MS: i64 = 60 * 60 * 1000;

/// `isPaidBillingStatus`: a non-free plan, `active`, and an `expiresAt` (seconds) that is absent
/// or still ahead, as the server's `isPaidSyncEntitlementActive` reads it.
pub fn is_paid(snapshot: &BillingSnapshot, now_secs: i64) -> bool {
    snapshot.plan != "free"
        && snapshot.status == "active"
        && snapshot.expires_at.is_none_or(|at| at > now_secs)
}

/// One read of `sync.entitlement`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedEntitlement {
    pub is_paid: bool,
    pub plan: String,
    pub status: String,
    /// `limits.maxFileSize`, absent after an invalidation or in an older store.
    pub max_file_size: Option<i64>,
    /// Absent in a store written before the field existed: its age is unknown.
    pub cached_at: Option<i64>,
}

impl CachedEntitlement {
    /// `isCachedUnpaidFresh`: unpaid, and cached no more than an hour ago. A missing or future
    /// `cachedAt` has an unknowable age and reads as stale.
    pub fn is_unpaid_fresh(&self, now_ms: i64) -> bool {
        !self.is_paid && age(self.cached_at, now_ms).is_some_and(|a| a <= UNPAID_ENTITLEMENT_TTL_MS)
    }

    /// `getCachedMaxFileSize`: the limit when positive and cached no more than a day ago;
    /// `None` (no opinion, the server decides) otherwise.
    pub fn max_file_size(&self, now_ms: i64) -> Option<i64> {
        let size = self.max_file_size.filter(|size| *size > 0)?;
        age(self.cached_at, now_ms)
            .is_some_and(|a| a <= ENTITLEMENT_LIMITS_TTL_MS)
            .then_some(size)
    }

    fn read(value: &Value) -> Option<Self> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            // An object without a boolean `isPaid` is not a verdict; the server is asked.
            is_paid: value.get("isPaid")?.as_bool()?,
            plan: text("plan").unwrap_or_default(),
            status: text("status").unwrap_or_default(),
            max_file_size: value
                .get("limits")
                .and_then(|limits| number(limits.get("maxFileSize"))),
            cached_at: number(value.get("cachedAt")),
        })
    }
}

/// `None` when `cached_at` is absent or ahead of `now_ms` (the clock moved).
fn age(cached_at: Option<i64>, now_ms: i64) -> Option<i64> {
    cached_at.map(|at| now_ms - at).filter(|age| *age >= 0)
}

/// A JSON number as Electron wrote it; JavaScript may write an integer as `5242880.0`.
fn number(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.is_finite())
            // Truncation is intended: the stored values are whole numbers.
            .map(|f| f as i64)
    })
}

/// `sync.entitlement` in `memry-config.json`, written through the config's atomic update, which
/// keeps every other key another build wrote.
pub struct EntitlementCache {
    config: Arc<AppConfig>,
}

impl EntitlementCache {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self { config }
    }

    pub fn get(&self) -> Option<CachedEntitlement> {
        self.config.read(|config| {
            config
                .get("sync")
                .and_then(|sync| sync.get("entitlement"))
                .and_then(CachedEntitlement::read)
        })
    }

    /// `setCachedEntitlementFromStatus`.
    pub fn set_from_snapshot(
        &self,
        snapshot: &BillingSnapshot,
        now_ms: i64,
    ) -> Result<CachedEntitlement, ConfigError> {
        let cached = CachedEntitlement {
            is_paid: is_paid(snapshot, now_ms.div_euclid(1000)),
            plan: snapshot.plan.clone(),
            status: snapshot.status.clone(),
            max_file_size: Some(snapshot.max_file_size),
            cached_at: Some(now_ms),
        };
        let value = json!({
            "isPaid": cached.is_paid,
            "plan": cached.plan,
            "status": cached.status,
            "limits": { "maxFileSize": snapshot.max_file_size },
            "cachedAt": now_ms,
        });
        self.update_sync(|sync| {
            sync.insert("entitlement".into(), value);
        })?;
        Ok(cached)
    }

    /// `invalidateCachedEntitlementLimits`: drops `limits` and `cachedAt` and keeps the verdict,
    /// after the server refused an upload on its own size limit. A cold cache stays cold.
    pub fn invalidate_limits(&self) -> Result<(), ConfigError> {
        self.config.update(|config| {
            if let Some(Value::Object(entitlement)) = config
                .get_mut("sync")
                .and_then(|sync| sync.get_mut("entitlement"))
            {
                entitlement.remove("limits");
                entitlement.remove("cachedAt");
            }
            Ok::<_, ConfigError>(())
        })
    }

    /// Drops the verdict (sign-out).
    pub fn clear(&self) -> Result<(), ConfigError> {
        self.config.update(|config| {
            if let Some(Value::Object(sync)) = config.get_mut("sync") {
                sync.remove("entitlement");
            }
            Ok::<_, ConfigError>(())
        })
    }

    /// The upload preflight's limit; `None` fails open.
    pub fn max_file_size(&self, now_ms: i64) -> Option<i64> {
        self.get()?.max_file_size(now_ms)
    }

    fn update_sync(&self, f: impl FnOnce(&mut Map<String, Value>)) -> Result<(), ConfigError> {
        self.config.update(|config| {
            let sync = config
                .entry("sync")
                .or_insert_with(|| Value::Object(Map::new()));
            if !sync.is_object() {
                *sync = Value::Object(Map::new());
            }
            if let Value::Object(map) = sync {
                f(map);
            }
            Ok::<_, ConfigError>(())
        })
    }
}

#[cfg(test)]
#[path = "entitlement_tests.rs"]
mod tests;
