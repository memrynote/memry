//! A definition renamed with the vault-wide field rename (`renameDefinition` of
//! `tags/schema/field-rename.ts`).

use super::{DefinitionsError, Next, PropertyDefinitions};

impl PropertyDefinitions {
    /// `to` takes `from`'s definition unless it has one of its own (a file entry or a record this
    /// build cannot read counts), then `from`'s goes; each step is an edit of its own turn, so
    /// the file and the records keep one writer. A name with no definition this build reads
    /// leaves both alone. `true` when `from`'s definition went. Run again after a stop between
    /// the steps, it finishes what is left.
    pub fn rename(&self, from: &str, to: &str) -> Result<bool, DefinitionsError> {
        let Some(definition) = self.change(from, |current| Ok((Next::Keep, current)))? else {
            return Ok(false);
        };
        self.change_renaming(to, None, |existing, held| {
            let next = match existing.is_some() || held.defined_elsewhere() {
                true => Next::Keep,
                false => Next::Put(definition.clone()),
            };
            Ok((next, ()))
        })?;
        self.change(from, |_| Ok((Next::Remove, ())))?;
        Ok(true)
    }
}
