use std::collections::BTreeMap;

/// The launch switches of one app run, read from the process environment once.
///
/// This is the only reader of the process environment for the whole app. Later steps overlay
/// values with [`LaunchEnv::set`] and read them with [`LaunchEnv::get`]; none of them calls
/// `std::env::var` for a launch switch.
#[derive(Debug, Clone, Default)]
pub struct LaunchEnv {
    pub vars: BTreeMap<String, String>,
}

impl LaunchEnv {
    /// Snapshot of the process environment. Entries that are not valid Unicode are skipped.
    pub fn from_process() -> Self {
        let vars = std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        Self { vars }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.vars.get(key).map(String::as_str)
    }

    pub fn set(&mut self, key: &str, value: &str) {
        self.vars.insert(key.to_owned(), value.to_owned());
    }
}
