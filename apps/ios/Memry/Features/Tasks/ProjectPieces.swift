import MemryCore
import SwiftUI

// TP052. Small pieces the project screens share: the project's icon and the
// colour palette (desktop's `color-picker.tsx`). The hub's progress is its
// header ring and "N of M done" line (RD18).

/// A project's mark in the sheet (Paper 19): a dot in the project colour, or
/// its emoji when it has one.
struct ProjectIconView: View {
    let icon: String?
    let color: String

    var body: some View {
        Group {
            if let emoji = ProjectIconValue.emoji(icon) {
                Text(emoji).font(Tokens.Typography.sectionTitle.font)
            } else {
                Circle()
                    .fill(Tokens.Palette.color(color))
                    .frame(width: ProjectSwatch.mark, height: ProjectSwatch.mark)
            }
        }
        .accessibilityHidden(true)
    }
}

enum ProjectSwatch {
    /// Paper 19's name dot (30pt) and palette swatch (26pt), from the spacing
    /// scale.
    static let mark = Tokens.Space.section + Tokens.Space.tight + ring
    static let swatch = Tokens.Space.section + ring
    /// The selected swatch's ring and the gap inside it.
    static let ring = Tokens.Space.tight / 2
}

/// The ten desktop swatches in one row; the selected one is ringed (Paper 19).
/// Each button spans its share of the row and the full 44pt height.
struct ProjectColorPalette: View {
    let selection: String
    let onSelect: (String) -> Void
    var identifierPrefix = "tasks.projectColor"

    var body: some View {
        HStack(spacing: 0) {
            ForEach(ProjectPalette.swatches) { swatch in
                let isSelected = swatch.hex.caseInsensitiveCompare(selection) == .orderedSame
                Button { onSelect(swatch.hex) } label: {
                    Circle()
                        .fill(Tokens.Palette.color(swatch.hex))
                        .frame(width: ProjectSwatch.swatch, height: ProjectSwatch.swatch)
                        .padding(ProjectSwatch.ring)
                        .overlay {
                            if isSelected {
                                Circle().strokeBorder(Tokens.Text.primary.color, lineWidth: ProjectSwatch.ring)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(TasksCopy.Projects.colorName(swatch.id))
                .accessibilityAddTraits(isSelected ? .isSelected : [])
                .accessibilityIdentifier("\(identifierPrefix).\(swatch.id)")
            }
        }
    }
}
