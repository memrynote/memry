import MemryCore
import SwiftUI

// A note's tags and typed properties, under its title.
//
// **Nothing is drawn until it has been read.** `metadata == nil` is "not
// answered yet" and draws nothing; a note that was read and carries neither
// also draws nothing. The two look the same on screen and must not be the same
// in the model, because only the first can still change.
//
// **A property is shown against its declared type, and shown anyway when it
// has none.** The core carries the value as JSON text plus a type name, so a
// type this build has never heard of renders as its raw value rather than
// vanishing — the same rule the block walker follows for unknown blocks. A
// property written before its definition arrived is legal (§13.7.1) and is
// exactly the case that would otherwise disappear.
//
// **Read-only.** Editing a property means writing a payload merge, and the
// write surface exports create, rename, move and delete and nothing else yet.
// No control here suggests otherwise.

struct NoteMetaView: View {
    let metadata: NoteMetadata

    private var hasContent: Bool {
        !metadata.tags.isEmpty || !metadata.properties.isEmpty
    }

    var body: some View {
        if hasContent {
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                if !metadata.tags.isEmpty {
                    TagRow(tags: metadata.tags)
                }
                if !metadata.properties.isEmpty {
                    PropertyTable(properties: metadata.properties)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The tags, wrapped.
///
/// Spelled as the payload holds them: `Café` and `CAFÉ` are two rows one layer
/// down, and only matching folds case — a row that normalised them would be
/// showing the user something they did not write.
private struct TagRow: View {
    let tags: [String]

    var body: some View {
        // The platform's own flow layout. A hand-rolled wrap would need its
        // own Dynamic Type measurement, and this one already has it.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Tokens.Space.small) { chips }
            VStack(alignment: .leading, spacing: Tokens.Space.small) { chips }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Tags")
        .accessibilityValue(tags.joined(separator: ", "))
    }

    private var chips: some View {
        ForEach(tags, id: \.self) { tag in
            Text(tag)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .padding(.horizontal, Tokens.Space.small)
                .padding(.vertical, Tokens.Space.tight)
                .background(
                    RoundedRectangle(cornerRadius: Tokens.Radius.control)
                        .fill(Tokens.Canvas.surface.color)
                )
                .accessibilityHidden(true)
        }
    }
}

/// Name and value, one row each.
private struct PropertyTable: View {
    let properties: [NoteProperty]

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            ForEach(properties, id: \.name) { property in
                PropertyRow(property: property)
            }
        }
    }
}

private struct PropertyRow: View {
    let property: NoteProperty

    var body: some View {
        // Label above value rather than beside it: a fixed label column either
        // truncates a long property name or starves the value, and at the
        // largest Dynamic Type sizes it does both.
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(property.name)
                .font(Tokens.Typography.label.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            Text(NotePropertyValue.display(property))
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A property value as one line of text.
///
/// A free function rather than view code so the mapping is asserted over
/// values. Every branch ends in something printable: the fallback is the raw
/// JSON, because a property whose type this build does not know is still a
/// property the user wrote.
enum NotePropertyValue {
    static func display(_ property: NoteProperty) -> String {
        guard let value = try? JSONSerialization.jsonObject(
            with: Data(property.valueJson.utf8),
            options: [.fragmentsAllowed]
        ) else {
            // Unparseable JSON from the core would be a core bug, and showing
            // the raw text is how it becomes visible rather than blank.
            return property.valueJson
        }
        switch value {
        case is NSNull:
            // An explicitly cleared property (§13.4). Empty, and said as
            // empty: "null" is the wire's word, not the user's.
            return "—"
        case let text as String:
            return text
        case let flag as Bool:
            // Only a `checkbox` is a yes/no; a number that happens to be 0 or
            // 1 is still a number, which is why the bool case is checked
            // before the number one.
            return flag ? "Yes" : "No"
        case let number as NSNumber:
            return number.stringValue
        case let list as [Any]:
            // `multiselect` and `relation` both arrive as arrays. Joined with
            // commas, and an empty array reads as empty rather than as "[]".
            let items = list.compactMap { $0 as? String }
            return items.isEmpty ? "—" : items.joined(separator: ", ")
        default:
            return property.valueJson
        }
    }
}
