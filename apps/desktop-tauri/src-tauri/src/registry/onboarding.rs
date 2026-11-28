//! The onboarding commands.

macro_rules! onboarding {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::onboarding::onboarding_detect_sources,
            crate::commands::onboarding::onboarding_is_memry_vault,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
