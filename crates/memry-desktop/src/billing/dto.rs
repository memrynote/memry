//! What the billing commands answer, in the shapes the renderer reads from Electron's
//! `billing/paddle-billing.ts` (`BillingStatus`, `PlanChangePreview`, the `{ success, error }`
//! envelopes). A failure the user can act on answers an envelope; a server or network failure
//! rejects the command, as Electron's handlers throw.

use memry_core::protocol::billing::{
    BillingSnapshot, PlanChangeCadence, PlanChangeEffective, PlanChangePreview, PlanChangeTier,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BillingLimits {
    pub storage_limit: i64,
    pub max_file_size: i64,
    /// `null` is unlimited (Believer).
    pub max_vaults: Option<i64>,
    pub version_history_days: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BillingUsage {
    pub storage_used: i64,
}

/// `BillingStatus` of `paddle-billing.ts`. `plan`, `cadence` and `status` stay as the server
/// sends them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BillingStatusDto {
    pub plan: String,
    pub cadence: Option<String>,
    pub status: String,
    pub email: Option<String>,
    pub limits: BillingLimits,
    pub usage: BillingUsage,
    /// Epoch seconds.
    pub expires_at: Option<i64>,
    pub can_manage_billing: bool,
}

impl From<BillingSnapshot> for BillingStatusDto {
    fn from(s: BillingSnapshot) -> Self {
        Self {
            plan: s.plan,
            cadence: s.cadence,
            status: s.status,
            email: s.email,
            limits: BillingLimits {
                storage_limit: s.storage_limit,
                max_file_size: s.max_file_size,
                max_vaults: s.max_vaults,
                version_history_days: s.version_history_days,
            },
            usage: BillingUsage {
                storage_used: s.storage_used,
            },
            expires_at: s.expires_at,
            can_manage_billing: s.can_manage_billing,
        }
    }
}

/// `BillingActionResult`: the envelope of a call that did not reach the server (signed out).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BillingActionResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

impl BillingActionResult {
    pub fn signed_out(error: &str) -> Self {
        Self {
            success: false,
            error: Some(error.to_owned()),
        }
    }
}

/// The status, or the signed-out envelope; the renderer tells them apart with `'plan' in r`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum BillingStatusResult {
    Status(BillingStatusDto),
    Failed(BillingActionResult),
}

/// `refreshBillingStatus(input?)`: the web checkout's transaction, when known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RefreshBillingInput {
    #[serde(default)]
    #[specta(optional)]
    pub transaction_id: Option<String>,
}

/// The plan picked during onboarding (`StartCheckoutInput`, `ipc-channels.ts:648`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartCheckoutInput {
    pub plan: CheckoutPlan,
    pub cadence: CheckoutCadence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CheckoutPlan {
    Plus,
    Pro,
    Believer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CheckoutCadence {
    Monthly,
    Annual,
    Lifetime,
}

impl CheckoutPlan {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plus => "plus",
            Self::Pro => "pro",
            Self::Believer => "believer",
        }
    }
}

impl CheckoutCadence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Monthly => "monthly",
            Self::Annual => "annual",
            Self::Lifetime => "lifetime",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub checkout_url: Option<String>,
}

/// `no-billing-customer` is a `409`: the server has no billing customer for the account (never
/// paid, webhook pending).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PortalFailureReason {
    NoBillingCustomer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PortalResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub reason: Option<PortalFailureReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub portal_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

/// Recurring plans only: Believer is a one-time purchase with nothing to switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanChangeTarget {
    pub plan: PlanChangePlan,
    pub cadence: PlanChangePeriod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum PlanChangePlan {
    Plus,
    Pro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum PlanChangePeriod {
    Monthly,
    Annual,
}

impl From<PlanChangeTarget> for memry_core::protocol::billing::PlanChangeTarget {
    fn from(t: PlanChangeTarget) -> Self {
        Self {
            plan: match t.plan {
                PlanChangePlan::Plus => PlanChangeTier::Plus,
                PlanChangePlan::Pro => PlanChangeTier::Pro,
            },
            cadence: match t.cadence {
                PlanChangePeriod::Monthly => PlanChangeCadence::Monthly,
                PlanChangePeriod::Annual => PlanChangeCadence::Annual,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanChangeTiming {
    Immediate,
    NextBillingPeriod,
}

/// `PlanChangePreview` of `paddle-billing.ts`. Amounts are Paddle's minor-unit strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanChangePreviewDto {
    pub plan: PlanChangePlan,
    pub cadence: PlanChangePeriod,
    pub is_upgrade: bool,
    pub effective: PlanChangeTiming,
    pub immediate_charge_amount: Option<String>,
    pub recurring_amount: String,
    pub currency_code: String,
    pub next_billed_at: Option<String>,
}

impl From<PlanChangePreview> for PlanChangePreviewDto {
    fn from(p: PlanChangePreview) -> Self {
        Self {
            plan: match p.plan {
                PlanChangeTier::Plus => PlanChangePlan::Plus,
                PlanChangeTier::Pro => PlanChangePlan::Pro,
            },
            cadence: match p.cadence {
                PlanChangeCadence::Monthly => PlanChangePeriod::Monthly,
                PlanChangeCadence::Annual => PlanChangePeriod::Annual,
            },
            is_upgrade: p.is_upgrade,
            effective: match p.effective {
                PlanChangeEffective::Immediate => PlanChangeTiming::Immediate,
                PlanChangeEffective::NextBillingPeriod => PlanChangeTiming::NextBillingPeriod,
            },
            immediate_charge_amount: p.immediate_charge_amount,
            recurring_amount: p.recurring_amount,
            currency_code: p.currency_code,
            next_billed_at: p.next_billed_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum PlanChangePreviewResult {
    Preview(PlanChangePreviewDto),
    Failed(BillingActionResult),
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn believer() -> BillingSnapshot {
        BillingSnapshot {
            plan: "believer".into(),
            cadence: Some("lifetime".into()),
            status: "active".into(),
            email: Some("a@b.c".into()),
            storage_limit: 53_687_091_200,
            max_file_size: 209_715_200,
            max_vaults: None,
            version_history_days: 365,
            storage_used: 12,
            expires_at: None,
            can_manage_billing: true,
        }
    }

    /// The renderer's `BillingStatus`, with `maxVaults: null` for unlimited.
    #[test]
    fn a_status_serializes_as_the_renderer_reads_it() {
        let dto = BillingStatusResult::Status(believer().into());
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            json!({
                "plan": "believer", "cadence": "lifetime", "status": "active", "email": "a@b.c",
                "limits": {
                    "storageLimit": 53_687_091_200i64, "maxFileSize": 209_715_200,
                    "maxVaults": null, "versionHistoryDays": 365,
                },
                "usage": { "storageUsed": 12 },
                "expiresAt": null,
                "canManageBilling": true,
            })
        );
    }

    #[test]
    fn a_signed_out_answer_is_electrons_envelope() {
        let dto = BillingStatusResult::Failed(BillingActionResult::signed_out("Sign in"));
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            json!({ "success": false, "error": "Sign in" })
        );
        let portal = PortalResult {
            success: false,
            reason: Some(PortalFailureReason::NoBillingCustomer),
            portal_url: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(portal).unwrap(),
            json!({ "success": false, "reason": "no-billing-customer" })
        );
    }

    #[test]
    fn a_preview_keeps_electrons_field_names() {
        let preview = PlanChangePreview {
            plan: PlanChangeTier::Pro,
            cadence: PlanChangeCadence::Annual,
            is_upgrade: true,
            effective: PlanChangeEffective::NextBillingPeriod,
            immediate_charge_amount: None,
            recurring_amount: "9600".into(),
            currency_code: "USD".into(),
            next_billed_at: Some("2027-01-01T00:00:00Z".into()),
        };
        assert_eq!(
            serde_json::to_value(PlanChangePreviewResult::Preview(preview.into())).unwrap(),
            json!({
                "plan": "pro", "cadence": "annual", "isUpgrade": true,
                "effective": "next_billing_period", "immediateChargeAmount": null,
                "recurringAmount": "9600", "currencyCode": "USD",
                "nextBilledAt": "2027-01-01T00:00:00Z",
            })
        );
        let target: PlanChangeTarget =
            serde_json::from_value(json!({ "plan": "plus", "cadence": "annual" })).unwrap();
        let core: memry_core::protocol::billing::PlanChangeTarget = target.into();
        assert_eq!(
            serde_json::to_value(core).unwrap(),
            json!({ "plan": "plus", "cadence": "annual" })
        );
    }
}
