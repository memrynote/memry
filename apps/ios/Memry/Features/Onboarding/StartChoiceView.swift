import SwiftUI

// After the welcome pages: start free on this iPhone, or sign in and sync.
//
// **This iPhone is the default.** No account is ever required; sync is the
// choice a user makes when they already have a vault on a Mac. One button
// commits, and its label says which road it takes.
struct StartChoiceView: View {
    let onLocal: () -> Void
    let onSync: () -> Void

    enum Choice: Equatable { case local, sync }

    @State private var choice = Choice.local

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Spacer(minLength: 0)
                BrandLockup(markHeight: 14, role: Tokens.Typography.label)
                Spacer(minLength: 0)
            }
            .padding(.top, Tokens.Space.small)

            ScrollView {
                VStack(alignment: .leading, spacing: Tokens.Space.section) {
                    VStack(alignment: .leading, spacing: Tokens.Space.small) {
                        Text("How would you like to begin?")
                            .font(Tokens.Typography.welcomeHeadline.font)
                            .foregroundStyle(Tokens.Text.primary.color)
                            .accessibilityAddTraits(.isHeader)
                        Text("Start free on this phone, or bring the vault you already have.")
                            .font(Tokens.Typography.body.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                    }
                    .accessibilityElement(children: .combine)

                    VStack(spacing: Tokens.Space.medium) {
                        StartCard(
                            symbol: "iphone.gen3",
                            title: "Start on this iPhone",
                            badge: "FREE",
                            detail: "No account, no email. Your notes stay right here.",
                            isSelected: choice == .local
                        ) { choice = .local }
                        StartCard(
                            symbol: "laptopcomputer.and.iphone",
                            title: "Sign in and sync",
                            badge: nil,
                            detail: "Pick up where you left off on your Mac. End-to-end encrypted.",
                            isSelected: choice == .sync
                        ) { choice = .sync }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, Tokens.Space.screenBlock)
            }

            VStack(spacing: Tokens.Space.inset) {
                Button(choice == .local ? "Start writing" : "Continue") {
                    choice == .local ? onLocal() : onSync()
                }
                .memryPrimaryAction()
                .accessibilityIdentifier("onboarding.choice.continue")
                Text("Turn on sync later in Settings — nothing is lost.")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
            .padding(.bottom, Tokens.Space.inset)
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.fast, value: choice)
    }
}

/// One road. Selected is a tinted ring plus a filled check, so the state never
/// rests on colour alone.
private struct StartCard: View {
    let symbol: String
    let title: String
    let badge: String?
    let detail: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: Tokens.Space.inset) {
                Image(systemName: symbol)
                    .font(Tokens.Typography.sectionTitle.font)
                    .foregroundStyle(isSelected ? Tokens.Tint.base.color : Tokens.Text.primary.color)
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                    .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
                VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                    HStack(spacing: Tokens.Space.small) {
                        Text(title)
                            .font(Tokens.Typography.heading.font)
                            .foregroundStyle(Tokens.Text.primary.color)
                        if let badge {
                            Text(badge)
                                .font(Tokens.Typography.caption.font.weight(.semibold))
                                .foregroundStyle(Tokens.Text.tint.color)
                                .padding(.horizontal, Tokens.Space.small)
                                .padding(.vertical, 2)
                                .background(Tokens.Tint.base.color.opacity(0.12), in: .capsule)
                        }
                    }
                    Text(detail)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(isSelected ? Tokens.Tint.base.color : Tokens.Line.border.color)
            }
            .padding(Tokens.Space.inset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Tokens.Radius.panel)
                    .stroke(isSelected ? Tokens.Tint.base.color : Tokens.Line.border.color,
                            lineWidth: isSelected ? 2 : Tokens.Size.hairline)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(badge.map { "\(title), \($0)" } ?? title)
        .accessibilityHint(detail)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

#Preview {
    StartChoiceView(onLocal: {}, onSync: {})
}
