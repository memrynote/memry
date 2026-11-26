import MemryCore

/// What one registry row is called on screen.
///
/// Three cases, not two, because `VaultSummary.name` is `Optional` on purpose:
/// absent means the row carries no name at all, which is a different fact from
/// a row whose name is empty. Coalescing either to `""` renders a blank row and
/// loses the distinction the registry went to the trouble of keeping.
enum VaultLabel: Equatable, Sendable {
    case named(String)
    /// The registry row carries no name.
    case unnamed
    /// The registry row carries a name, and it is empty.
    case blankName

    init(_ summary: VaultSummary) {
        switch summary.name {
        case .none: self = .unnamed
        case let .some(name) where name.isEmpty: self = .blankName
        case let .some(name): self = .named(name)
        }
    }

    /// The row's title. Never empty, and never the vault id: an id identifies
    /// content and is noise to read, so a vault without a usable name says so
    /// in words instead.
    var text: String {
        switch self {
        case let .named(name): name
        case .unnamed: "Unnamed vault"
        case .blankName: "Vault with a blank name"
        }
    }

    /// Whether the title is the user's own words or this file's.
    var isPlaceholder: Bool {
        if case .named = self { return false }
        return true
    }
}
