//! AI providers, keys and inline AI (Step 22, #3539). Keys and provider network access are
//! Rust only: the renderer gets masked settings and never names a provider host.

pub mod cached_key;
pub mod catalog;
pub mod fill_fields;
pub mod local_agent;
pub mod local_provider;
pub mod provider;
pub mod proxy;
pub mod settings;
pub mod structured;
pub mod writing_assist;
