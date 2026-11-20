//! `registry.ts` and `register-builtins.ts`: the importers of this build, by id.

use std::cmp::Ordering;
use std::sync::Arc;

use super::{ImportError, Importer, ImporterMeta};

#[derive(Default)]
pub struct Registry {
    importers: Vec<Arc<dyn Importer>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every importer ported so far. Later stages register theirs here, with Electron's gates:
    /// Apple Notes only on macOS, OneNote only when the build has a OneNote client id.
    pub fn builtin() -> Self {
        let mut registry = Self::new();
        for importer in [
            Arc::new(super::markdown::MarkdownImporter) as Arc<dyn Importer>,
            Arc::new(super::csv::CsvImporter),
            Arc::new(super::google_keep::GoogleKeepImporter),
        ] {
            registry
                .register(importer)
                .expect("built-in importer ids are distinct");
        }
        registry
    }

    pub fn register(&mut self, importer: Arc<dyn Importer>) -> Result<(), ImportError> {
        let id = importer.meta().id;
        if self.get(&id).is_some() {
            return Err(ImportError::AlreadyRegistered(id));
        }
        self.importers.push(importer);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Importer>> {
        self.importers
            .iter()
            .find(|importer| importer.meta().id == id)
            .cloned()
    }

    /// `listImporterMeta`: sorted by name as `localeCompare` sorts these ASCII names, letter
    /// case second.
    pub fn list_meta(&self) -> Vec<ImporterMeta> {
        let mut metas: Vec<ImporterMeta> = self.importers.iter().map(|i| i.meta()).collect();
        metas.sort_by(|a, b| by_name(&a.name, &b.name));
        metas
    }
}

fn by_name(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}
