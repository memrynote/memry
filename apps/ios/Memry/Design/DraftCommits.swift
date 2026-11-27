/// One text field's edit of a stored value: what is written when the edit
/// ends, and what the field shows when the stored value changes under it.
/// The note title, a note's property values and a task's title all edit
/// through it.
///
/// An edit starts from the value the field showed when focus came in, its
/// base. Only a draft that differs from the base is written, so a field left
/// as it was never writes over a value a peer, a sync or another copy of the
/// field stored meanwhile (#4616, REVIEW-4529). Focus in on "Foo", type
/// "Food", a peer renames to "Bar", erase back to "Foo", leave: nothing is
/// written, and "Bar" stands (#4680). The first take ends the edit, so a
/// Return and the blur after it, or a blur and the field going away, write
/// once.
struct DraftCommits {
    private var base: String?

    /// An edit is in progress: focus came in and no take has ended it.
    var editing: Bool { base != nil }

    /// Focus came in on the field showing `draft`.
    mutating func begin(_ draft: String) { base = draft }

    /// The value was replaced under an edit in progress (a Clear): the edit
    /// starts again from `draft`.
    mutating func rebase(_ draft: String) {
        if base != nil { base = draft }
    }

    /// Ends the edit. Returns the value to write, or `nil` when the draft is
    /// the base, or is empty and the end is not `explicit`. An explicit end
    /// (a Return) is the only one that writes an emptied field.
    mutating func take(_ draft: String, explicit: Bool) -> String? {
        guard let base else { return nil }
        self.base = nil
        guard draft != base, explicit || !draft.isEmpty else { return nil }
        return draft
    }

    /// What the field shows once the stored value became `stored`. With no
    /// edit, or one the user has not changed, the draft follows it and the
    /// edit starts again from it; a changed draft stays.
    mutating func follow(_ draft: String, stored: String) -> String {
        guard let base else { return stored }
        guard draft == base else { return draft }
        self.base = stored
        return stored
    }
}
