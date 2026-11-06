//! What the watcher is told of a folder move (`notes::folder_move`): the folder's going as one
//! record.

use std::fs;
use std::path::Path;

use super::Carried;
use crate::vault::app_move::on_disk;
use crate::vault::watch::EchoGuard;

/// Every path the move takes away that the watcher could take for a note's removal: each
/// note's file, each folder that holds one below `from`, and `from`.
fn carried_paths(from: &str, carried: &[Carried]) -> Vec<String> {
    let mut folders = std::collections::BTreeSet::new();
    for note in carried {
        let mut path = note.old.as_str();
        while let Some((folder, _)) = path.rsplit_once('/')
            && folder.len() > from.len()
        {
            folders.insert(folder.to_owned());
            path = folder;
        }
    }
    let notes = carried.iter().map(|note| note.old.clone());
    notes
        .chain(folders.into_iter().rev())
        .chain([from.to_owned()])
        .collect()
}

/// The own-write record of the folder's going ([`EchoGuard::will_remove_tree`]) for the length of
/// a move: settled once the folder is gone ([`Self::settle`]), narrowed to what is still gone
/// when the move did not happen ([`Self::narrow`]), and narrowed on drop when neither ran, a
/// panic included, so no unsettled record outlives the move and absorbs later deletes.
pub(super) struct TreeRecord<'a> {
    echo: &'a EchoGuard,
    root: &'a Path,
    from: &'a str,
    carried: &'a [Carried],
    done: bool,
}

impl<'a> TreeRecord<'a> {
    pub(super) fn new(
        echo: &'a EchoGuard,
        root: &'a Path,
        from: &'a str,
        carried: &'a [Carried],
    ) -> Self {
        echo.will_remove_tree(from);
        Self {
            echo,
            root,
            from,
            carried,
            done: false,
        }
    }

    pub(super) fn settle(&mut self) {
        self.echo.removed_tree(self.from);
        self.done = true;
    }

    /// Keeps a record of each path not back on disk (a hidden staging folder may hold them
    /// until the next open's sweep): the absence of one that is back is not the app's.
    pub(super) fn narrow(&mut self) {
        let root = self.root;
        let still_gone = carried_paths(self.from, self.carried)
            .into_iter()
            .filter(|path| fs::symlink_metadata(on_disk(root, path)).is_err());
        self.echo.narrow_tree(self.from, still_gone);
        self.done = true;
    }
}

impl Drop for TreeRecord<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.narrow();
        }
    }
}
