import SwiftUI

// Spec 006 ST21. The rows every Settings screen is built from. Native
// `List(.insetGrouped)` rows with Tokens type and colour; the spec 005 rule
// holds: the tint fills, text stays in ink.

/// A row that pushes a page and shows its current value trailing.
struct SettingsLinkRow: View {
    let title: String
    var symbol: String?
    var value: String?
    let route: SettingsRoute

    var body: some View {
        NavigationLink(value: route) {
            SettingsRowLabel(title: title, symbol: symbol, value: value)
        }
        .accessibilityIdentifier("settings.row.\(route.identifier)")
    }
}

/// Title, optional symbol, trailing value. Stacks at accessibility sizes.
struct SettingsRowLabel: View {
    let title: String
    var symbol: String?
    var value: String?
    var detail: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Tokens.Space.tight))
            : AnyLayout(HStackLayout(spacing: Tokens.Space.medium))
        layout {
            HStack(spacing: Tokens.Space.medium) {
                if let symbol {
                    Image(systemName: symbol)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .frame(minWidth: Tokens.Space.section)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                    Text(title)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                    if let detail {
                        Text(detail)
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                    }
                }
            }
            if !typeSize.isAccessibilitySize { Spacer(minLength: Tokens.Space.small) }
            if let value {
                Text(value)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .multilineTextAlignment(.trailing)
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityElement(children: .combine)
    }
}

/// A switch with the accent as its fill.
struct SettingsToggleRow: View {
    let title: String
    var detail: String?
    @Binding var isOn: Bool
    var identifier: String

    var body: some View {
        Toggle(isOn: $isOn) {
            SettingsRowLabel(title: title, detail: detail)
        }
        .tint(Tokens.Tint.base.color)
        .accessibilityIdentifier(identifier)
    }
}

/// A red row for a destructive action. The role gives VoiceOver the word.
struct SettingsDestructiveRow: View {
    let title: String
    var identifier: String
    let action: () -> Void

    var body: some View {
        Button(title, role: .destructive, action: action)
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Interaction.destructive.color)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier(identifier)
    }
}

/// A plain action row (Sync now, Link new device).
struct SettingsActionRow: View {
    let title: String
    var symbol: String?
    var identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label {
                Text(title).font(Tokens.Typography.body.font)
            } icon: {
                if let symbol { Image(systemName: symbol) }
            }
            .foregroundStyle(Tokens.Text.tint.color)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        }
        .accessibilityIdentifier(identifier)
    }
}

/// A section footer in the caption role.
struct SettingsFooter: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.secondary.color)
    }
}

/// The sync dot: colour plus the words beside it, never colour alone.
struct SyncDot: View {
    enum State { case synced, pending, offline }
    let state: State

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: Tokens.Space.small, height: Tokens.Space.small)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch state {
        case .synced: Tokens.Task.complete.color
        case .pending: Tokens.Task.dueToday.color
        case .offline: Tokens.Text.tertiary.color
        }
    }
}

/// The account card on the Settings root (01) and Account (02).
struct SettingsAccountCard: View {
    let email: String?
    let line: String
    let dot: SyncDot.State
    var showsBadge = false

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Text(initial)
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(Tokens.Text.tint.color)
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .background(Tokens.Tint.base.color.opacity(Tokens.Palette.chipFillAlpha * 1.5), in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(email ?? SettingsCopy.account)
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .lineLimit(2)
                if showsBadge {
                    Label(SettingsCopy.endToEnd, systemImage: "lock.fill")
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                HStack(spacing: Tokens.Space.small) {
                    SyncDot(state: dot)
                    Text(line)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
        }
        .padding(.vertical, Tokens.Space.tight)
        .accessibilityElement(children: .combine)
    }

    private var initial: String {
        email?.first.map { String($0).uppercased() } ?? "M"
    }
}

/// One accent swatch. Selected = a ring in ink, never the tint alone.
struct ColorSwatch: View {
    let color: Color
    let name: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(color)
                .frame(width: Tokens.Size.pill, height: Tokens.Size.pill)
                .overlay {
                    if isSelected {
                        Circle().stroke(Tokens.Line.focus.color, lineWidth: 2).padding(-Tokens.Space.tight)
                        Image(systemName: "checkmark")
                            .font(Tokens.Typography.caption.font.weight(.bold))
                            .foregroundStyle(Tokens.Text.primary.color)
                            .padding(Tokens.Space.tight)
                            .background(Tokens.Canvas.background.color, in: .circle)
                    }
                }
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The storage bar (03): one segment per category, sized by bytes.
struct StorageBar: View {
    struct Segment: Identifiable {
        let id: String
        let bytes: Int64
        let color: Color
    }

    let segments: [Segment]
    let limit: Int64

    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: Tokens.Size.hairline) {
                ForEach(segments) { segment in
                    Rectangle()
                        .fill(segment.color)
                        .frame(width: width(segment.bytes, in: proxy.size.width))
                }
                Spacer(minLength: 0)
            }
            .background(Tokens.Canvas.surfaceActive.color)
            .clipShape(.capsule)
        }
        .frame(height: Tokens.Space.small)
        .accessibilityHidden(true)
    }

    private func width(_ bytes: Int64, in total: CGFloat) -> CGFloat {
        guard limit > 0 else { return 0 }
        return max(0, total * CGFloat(Double(bytes) / Double(limit)))
    }
}

extension ByteCountFormatter {
    static func memry(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowsNonnumericFormatting = false
        return formatter.string(fromByteCount: bytes)
    }
}

extension List {
    /// The inset grouped list every Settings page uses.
    func settingsList() -> some View {
        listStyle(.insetGrouped)
            .scrollContentBackground(.visible)
    }
}
