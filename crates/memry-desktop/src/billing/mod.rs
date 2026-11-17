//! Billing and the plan verdict (Step 20, #3537), ported from Electron's `main/billing/`.

pub mod dto;
pub mod entitlement;
pub mod service;

pub use service::{BillingService, OpenFailed, UrlOpener};
