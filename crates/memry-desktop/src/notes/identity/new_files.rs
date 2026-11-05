//! The notes identity's answer for many new files at once (#3530 13q-7): the files
//! [`NotesIdentity`]'s `adopt_or_create` would make a new note of without comparing a body go
//! to the core together, with the bodies the consumer authored for them, in one transaction
//! (`memry_core::domain::notes::new_files`). Every other file is answered `false` and asked
//! about alone.

use memry_core::domain::notes::identity::FileNote;
use memry_core::domain::notes::new_files::NewFileNote;
use memry_core::markdown::frontmatter::split_frontmatter_block;

use super::{
    NotesIdentity, SCOPE, created_ms, electron_db_beside, is_large_file, place, properties,
};
use crate::vault::consumer::identity::{Candidate, IdentityCtx, IdentityError, NewFile};
use crate::vault::file_types::FileType;
use crate::vault::journal_format::JournalDays;
use crate::vault::note_file::NoteFile;

/// Whether `adopt_or_create` would name `file` without a body to compare, unless a record
/// matches it: markdown with its text read, not large-file class, not a journal day's path.
fn may_be_a_new_note(journal: &JournalDays, file: &Candidate<'_>) -> bool {
    file.file_type == FileType::Markdown
        && file
            .file
            .is_some_and(|text| !is_large_file(file.size, &text.raw))
        && journal.day_of(file.path).is_none()
}

/// The vault config is read once for all of `files`.
pub(super) fn may_be_new(
    identity: &NotesIdentity,
    ctx: &IdentityCtx<'_>,
    files: &[Candidate<'_>],
) -> Vec<bool> {
    match identity.journal(ctx.root) {
        Some(journal) => files
            .iter()
            .map(|file| may_be_a_new_note(&journal, file))
            .collect(),
        None => vec![false; files.len()],
    }
}

/// The vault config is read once for all of `files`, and Electron's database looked for once.
pub(super) fn adopt(
    identity: &NotesIdentity,
    ctx: &IdentityCtx<'_>,
    files: &[NewFile<'_>],
) -> Result<Vec<bool>, IdentityError> {
    let mut created = vec![false; files.len()];
    let Some(journal) = identity.journal(ctx.root) else {
        return Ok(created);
    };
    let writer = identity.writer(ctx)?;
    identity.settle_owed(ctx.root, &writer, &journal, None);
    let electron_db_beside = electron_db_beside(ctx.root);
    let mut asked = Vec::new();
    let mut texts = Vec::new();
    let mut notes = Vec::new();
    for (at, new) in files.iter().enumerate() {
        let file = &new.candidate;
        let Some(text) = file.file.filter(|_| may_be_a_new_note(&journal, file)) else {
            continue;
        };
        let (folder_path, title) = place(file.path);
        notes.push(NewFileNote {
            file: FileNote {
                path: file.path,
                title,
                folder_path,
                body: split_frontmatter_block(&text.raw).body,
                created_ms: created_ms(&ctx.root.join(file.path)).unwrap_or(file.modified_ms),
                modified_ms: file.modified_ms,
                electron_db_beside,
            },
            id: new.id,
            body: new.body,
        });
        asked.push(at);
        texts.push(text);
    }
    let answers = writer
        .adopt_new_files(&notes)
        .map_err(|error| IdentityError::Other(error.to_string()))?;
    let made: Vec<(usize, &str, &NoteFile)> = asked
        .into_iter()
        .zip(texts)
        .zip(answers)
        .filter(|(_, answer)| *answer)
        .map(|((at, text), _)| (at, files[at].id, text))
        .collect();
    let found: Vec<(&str, &NoteFile)> = made.iter().map(|(_, id, text)| (*id, *text)).collect();
    // A record whose properties did not go in is asked about alone, which adopts it and
    // fills them again.
    if let Err(error) = properties::found_all(&writer, ctx, identity.store.clone(), &found) {
        tracing::warn!(
            scope = SCOPE,
            "new notes' properties wait for their files alone: {error}"
        );
        return Ok(created);
    }
    for (at, _, _) in made {
        created[at] = true;
    }
    Ok(created)
}
