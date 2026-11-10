//! The vault paths the app reads but never writes (#3530 13m-7b-3b): on desktop, the files a
//! vault exclude pattern covers. Electron's index drops such a note, so no write of the app
//! reaches it; here it stays listed and opens read-only, and every writer of the app asks this.
//! The shell sets the rule each time its patterns change. Until it does, nothing is excluded
//! (iOS never sets one).

use std::sync::{Arc, PoisonError, RwLock};

type Rule = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Shared by a vault and its editor: a rule set on one is the rule of both.
#[derive(Clone, Default)]
pub struct ExcludedPaths(Arc<RwLock<Option<Rule>>>);

impl ExcludedPaths {
    /// `covers` decides from now on.
    pub fn set(&self, covers: impl Fn(&str) -> bool + Send + Sync + 'static) {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(covers));
    }

    /// Whether the file at vault-relative `path` is excluded.
    pub fn covers(&self, path: &str) -> bool {
        let rule = self
            .0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        rule.is_some_and(|covers| covers(path))
    }

    /// Whether any rule is set: without one no path needs looking up.
    pub(crate) fn is_set(&self) -> bool {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }
}
