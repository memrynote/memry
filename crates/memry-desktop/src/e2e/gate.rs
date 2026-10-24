use crate::launch_env::LaunchEnv;

/// The switch that opens the gate. Only the value `1` counts.
pub const E2E_VAR: &str = "MEMRY_E2E";

/// The run-time half of the two e2e guards. The compile-time half is the cargo feature `e2e`
/// of `memry-tauri`. A closed gate registers no driver plugin and answers every `e2e_*`
/// command with `e2e_disabled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct E2eGate {
    open: bool,
}

impl E2eGate {
    pub fn from_env(env: &LaunchEnv) -> Self {
        Self {
            open: env.get(E2E_VAR) == Some("1"),
        }
    }

    pub fn is_open(self) -> bool {
        self.open
    }
}
