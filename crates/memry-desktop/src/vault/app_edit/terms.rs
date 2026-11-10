//! What an app edit may replace (`Precondition`) and what it came to (`Edited`, `Kept`). Split
//! from `app_edit`, whose module comment says how each precondition reads and keeps the file.

use super::OwnFiles;

/// What an edit may replace (see the module comment).
#[derive(Debug, Clone, Copy)]
pub enum Precondition<'a> {
    /// Only a file the document holds; anything else is kept.
    Held,
    /// [`Precondition::Held`], for a document built while its file was at this path.
    HeldAt(&'a str),
    /// [`Self::Held`], and a body the edit changes kept as a version first: the edit writes over
    /// the user's text.
    Replace,
    /// The user's save: whatever is there, a file that is not the run's own, or a body that
    /// moved by ten words or more, kept as a version first.
    Save(&'a OwnFiles),
    /// [`Self::Save`] over a file the editor never showed: a changed body is always kept.
    SaveOver(&'a OwnFiles),
    /// [`Self::Save`] of a restored version: the replaced file is always kept, as the newest
    /// version.
    Restore(&'a OwnFiles),
}

/// What an edit came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edited {
    /// The file holds the new text. `held`: the document took it too, and the row says so;
    /// otherwise the watcher brings the file to the document as an outside edit.
    /// `kept_outside`: a save's body went over an outside edit not fed yet, kept as a version
    /// first; the editor had no event for it. `text`: the file as written, byte order mark
    /// included.
    Wrote {
        hash: String,
        held: bool,
        kept_outside: bool,
        text: String,
    },
    /// The closure changed nothing; `text` is the file as read.
    Unchanged { text: String },
    /// The file was kept as it is.
    Kept(Kept),
}

/// Why the file was kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kept {
    NoRow,
    NotMarkdown,
    /// The row names a file that is not there.
    NoFile,
    /// The row has no hash, so the document is not known to hold the file.
    NotRead,
    /// The file differs from its row's hash (an outside edit not fed yet), or changed while the
    /// write ran.
    FileChanged,
    /// The file's frontmatter does not parse.
    FrontmatterUnreadable,
    /// The edit's text has a frontmatter that does not parse.
    FrontmatterBroken,
    /// The document holds an edit its file does not have yet.
    BodyAhead,
    /// The file holds an edit the document did not take.
    FileAhead,
    /// The note's server body has not been pulled.
    BodyNotPulled,
    /// The document holds what a markdown file cannot, or does not serialize.
    NotRepresentable,
    /// No live note or journal day by that id.
    NoBody,
    /// The note, or a folder above its file, is locked (Electron `assertNoteWritable`).
    Locked,
    /// The note's file is excluded (`ExcludedPaths`): Electron's index does not hold it, so no
    /// edit of the app reaches it.
    Excluded,
}
