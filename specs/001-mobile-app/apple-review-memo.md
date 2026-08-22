# Apple Review Compliance Memo — Double-Subscription Setup

**Feature**: 001-mobile-app | **Task**: T013 (R6 desk spike) | **Date**: 2026-08-22
**Inputs**: research.md §R6, record §9/§12, spec FR-041

## Question

Can Memry ship a StoreKit 2 subscription on iOS while some subscribers already
hold an active web (Paddle) subscription, without conflicting with App Review
Guidelines 3.1.x?

## Mapping to App Store Review Guidelines

| Guideline | Planned behaviour | Verdict |
|---|---|---|
| **3.1.1** In-App Purchase | Sync entitlement unlocks only via StoreKit 2 purchase inside the iOS app (`expo-iap` / OpenIAP). No external checkout link, no mention of the web price, no deep link to Paddle from iOS. Paywall is calm, no dark patterns (Constitution IV). | Compliant |
| **3.1.2** Subscriptions | Auto-renewable subscription via StoreKit 2; restore purchases in-app; manage-subscription hand-off uses Apple's own sheet/endpoints. Offer codes: **not promised in v1** until `presentCodeRedemptionSheet` is verified in OpenIAP (research.md B2 open flag). | Compliant |
| **3.1.3** Multiplatform services | The app may be *used* on other platforms, but iOS users are never directed to buy elsewhere. An existing Paddle subscriber opening the paywall sees the **double-subscription notice** below instead of an upsell. | Compliant |
| **5.1.1(v)** Account deletion | In-app account deletion over the existing `account-deletion` service (T123). | Compliant |
| **5.1.1–5.1.2** Data & privacy | Accurate App Privacy labels: telemetry declared, not identity-linked; `PrivacyInfo.xcprivacy` + required-reason APIs shipped in Phase 5 (T122). Never "collects nothing". | Compliant |

## Double-subscription notice wording (draft)

Informational only; no purchase link, no steering:

> You already have an active Memry plan through our website, so there's nothing
> to buy here — your sync works on this device today. If you'd prefer to be
> billed through Apple instead, cancel your web plan first; your data and notes
> are unaffected either way.

Rules encoded for Phase 5 UI: shown only when the account holds both an active
Paddle entitlement and the user reaches the paywall; never blocks reading or
writing; never names prices; never links out.

## Entitlement behaviour (server-side, review-invisible)

`active(paddle) ∪ active(apple)`; later expiry governs; additive
`doubleSubscription` status field (contracts §5c). Review cannot observe or
reject server merge logic; only the notice UX above is visible.

## Fallback plan (if rejection cites the notice)

Ship v1.0.1 with the notice reworded to platform-neutral text ("You already
have an active plan; nothing to purchase here."), dropping the "billed through
Apple" sentence entirely. Entitlement merge behaviour is unchanged — it is
server-side and unaffected by review.

## Residual risk

App Review is not deterministic. The memo finds no guideline conflict in the
planned flow; Phase 7 carries the submission buffer per the release train.
