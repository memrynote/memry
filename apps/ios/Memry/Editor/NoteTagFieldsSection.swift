import MemryCore
import SwiftUI

/// The fields a note's tags list, grouped per tag, after desktop's
/// `NoteFieldGroups`. Values only: a field is defined on desktop, so there is
/// no rename or add here, and a field's value is an ordinary note property
/// written through the same model as the Properties table.
struct NoteTagFieldsSection: View {
    let groups: [TagFieldGroup]
    let model: NoteMetadataViewModel
    let reload: () async -> Void
    var noteTitle: (String) -> String? = { _ in nil }
    var noteIcon: (String) -> String? = { _ in nil }
    var relationCandidates: [NoteSummary] = []

    @State private var expanded = true

    private var count: Int { groups.reduce(0) { $0 + $1.fields.count } }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            Button {
                expanded.toggle()
            } label: {
                HStack(spacing: Tokens.Space.small) {
                    Image(systemName: "chevron.right")
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(Tokens.Tint.base.color)
                    Text("Tag fields · \(count)")
                        .foregroundStyle(Tokens.Text.secondary.color)
                    Spacer()
                }
                .font(Tokens.Typography.caption.font.weight(.medium))
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tag fields, \(count)")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("note.tagFields.toggle")

            if expanded {
                Divider()
                ForEach(groups, id: \.groupId) { group in
                    VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                        header(group)
                        ForEach(group.fields, id: \.property.name) { field in
                            row(field)
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(group.tag)
                }
            }
        }
    }

    private func header(_ group: TagFieldGroup) -> some View {
        let color = Tokens.Palette.color(group.color, tag: group.tag)
        return HStack(spacing: Tokens.Space.small) {
            if let emoji = ProjectIconValue.emoji(group.icon) {
                Text(emoji)
            } else {
                Image(systemName: "number").foregroundStyle(color)
            }
            Text(Self.displayName(group.tag))
                .fontWeight(.semibold)
                .foregroundStyle(Tokens.Text.primary.color)
            if let via = group.via {
                Text("via #\(via.lowercased())")
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
        }
        .font(Tokens.Typography.caption.font)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private func row(_ field: TagField) -> some View {
        let property = field.property
        let kind = NotePropertyKind.of(property)
        return NotePropertyEditor(
            property: property,
            kindHint: kind,
            commit: { input in
                Task {
                    await model.setProperty(property.name, input: input, kind: kind)
                    await reload()
                }
            },
            clear: {
                Task {
                    await model.clearProperty(property.name)
                    await reload()
                }
            },
            setRelations: { uris in
                Task {
                    await model.setRelations(property.name, uris)
                    await reload()
                }
            },
            relationCandidates: relationCandidates,
            noteTitle: noteTitle,
            noteIcon: noteIcon
        )
    }

    /// Desktop's `tagDisplayName`: the stored name, first letter capitalised.
    static func displayName(_ name: String) -> String {
        name.prefix(1).uppercased() + name.dropFirst()
    }
}

private extension TagFieldGroup {
    var groupId: String { "\(tag)|\(via ?? "")" }
}
