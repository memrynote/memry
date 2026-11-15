//! The notes identity, plus a note for every PDF, image, audio or video file, as Electron's
//! indexer gives one (`indexBinaryFile`, `vault/indexer.ts`). The app's identity defers those
//! files until #4209 lands, so no `note_files` row names them; the tests of what reads filed
//! files (the file text runner) stand in this part.

use std::path::Path;
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NewFile, NoteIdentity, Removal, Rename,
    Settled,
};
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::note_file::NoteFile;
use memry_desktop::vault::notices::VaultNotices;

pub struct FilesToo {
    notes: Arc<NotesIdentity>,
    store: Arc<dyn SecureStore>,
}

pub fn files_too(store: Arc<dyn SecureStore>) -> Arc<FilesToo> {
    Arc::new(FilesToo {
        notes: NotesIdentity::new(store.clone()),
        store,
    })
}

impl NoteIdentity for FilesToo {
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        if file.file_type == FileType::Markdown {
            return self.notes.adopt_or_create(ctx, file);
        }
        let title = Path::new(file.path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let folder = Path::new(file.path)
            .parent()
            .map(|folder| folder.to_string_lossy().into_owned())
            .filter(|folder| !folder.is_empty());
        let writer = ctx
            .vault
            .notes_writer(self.store.clone())
            .map_err(|error| IdentityError::Other(error.to_string()))?;
        Ok(Adoption::Created(writer.create(title, folder)?))
    }

    fn leaves_vault(&self, ctx: &IdentityCtx<'_>) -> bool {
        self.notes.leaves_vault(ctx)
    }

    fn opened(&self, ctx: &IdentityCtx<'_>) {
        self.notes.opened(ctx);
    }

    fn watch_limited(&self, ctx: &IdentityCtx<'_>) {
        self.notes.watch_limited(ctx);
    }

    fn file_returned(&self, ctx: &IdentityCtx<'_>, note_id: &str) {
        self.notes.file_returned(ctx, note_id);
    }

    fn notices(&self) -> Option<Arc<VaultNotices>> {
        self.notes.notices()
    }

    fn may_be_new(&self, ctx: &IdentityCtx<'_>, files: &[Candidate<'_>]) -> Vec<bool> {
        self.notes.may_be_new(ctx, files)
    }

    fn adopt_new_files(
        &self,
        ctx: &IdentityCtx<'_>,
        files: &[NewFile<'_>],
    ) -> Result<Vec<bool>, IdentityError> {
        self.notes.adopt_new_files(ctx, files)
    }

    fn on_removed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        path: &str,
    ) -> Result<Removal, IdentityError> {
        self.notes.on_removed(ctx, note_id, path)
    }

    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<Rename, IdentityError> {
        self.notes.on_renamed(ctx, note_id, old_path, new_path)
    }

    fn follow_held(&self, ctx: &IdentityCtx<'_>) -> bool {
        self.notes.follow_held(ctx)
    }

    fn cross_renamed_day(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        path: &str,
    ) -> Result<bool, IdentityError> {
        self.notes.cross_renamed_day(ctx, note_id, path)
    }

    fn settle_crossings(&self, ctx: &IdentityCtx<'_>) -> Settled {
        self.notes.settle_crossings(ctx)
    }

    fn on_changed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        previous: &str,
        file: &NoteFile,
    ) -> Result<(), IdentityError> {
        self.notes.on_changed(ctx, note_id, previous, file)
    }

    fn left_large_class(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        file: &NoteFile,
    ) -> Result<(), IdentityError> {
        self.notes.left_large_class(ctx, note_id, file)
    }

    fn keeps_kind(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        new_path: &str,
    ) -> Result<bool, IdentityError> {
        self.notes.keeps_kind(ctx, note_id, new_path)
    }
}
