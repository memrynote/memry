import SwiftUI

// The two screens before sign-in, and the only screens in the app that are
// marketing rather than mechanism.
//
// **Two pages, not a tour.** The first states one outcome and offers one
// action; the second states the three facts a privacy product has to state
// before it asks for an email address. Every sentence is checkable — the
// encryption, the local store, the linking — because `DESIGN.md` forbids hype
// and there is nothing here a support thread could not defend.
//
// **Seen once, per install.** `@AppStorage` rather than the keychain: this is a
// presentation preference, not key material, and a user who reinstalls to get
// a clean app is entitled to see it again.
//
// **Skippable from the first screen.** A returning user signing in on a new
// phone should not have to read the pitch, so "Sign in" is on page one.
struct WelcomeView: View {
    /// Called when the user is done here — by finishing or by skipping. The
    /// caller owns the flag; this view never decides that sign-in comes next.
    let onFinish: () -> Void

    @State private var page = Page.promise

    enum Page: Int, CaseIterable, Equatable {
        case promise
        case trust
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            TabView(selection: $page) {
                PromisePage().tag(Page.promise)
                TrustPage().tag(Page.trust)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            footer
        }
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: page)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.inset) {
            PageDots(current: page)
            Button(page == .promise ? "Get started" : "Continue") { advance() }
                .memryPrimaryAction()
            if page == .promise {
                Button("Already have an account? Sign in", action: onFinish)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.primary.color)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
            } else {
                Text("Memry is open source. Read the code any time.")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
            }
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.bottom, Tokens.Space.inset)
    }

    /// The mark, and the way back to the page before this one.
    ///
    /// Back is on the second page only, because the first has nothing behind
    /// it: the app opened here.
    private var header: some View {
        ZStack(alignment: .leading) {
            if page == .trust {
                BackButton { page = .promise }
            }
            HStack {
                Spacer(minLength: 0)
                BrandLockup(markHeight: 14, role: Tokens.Typography.label)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.top, Tokens.Space.small)
    }

    private func advance() {
        switch page {
        case .promise: page = .trust
        case .trust: onFinish()
        }
    }
}

/// Page one: one outcome, in the editorial serif this product keeps for the
/// moments that are not the working interface.
private struct PromisePage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.inset) {
            Spacer()
            Text("Everything you think, in one quiet place.")
                .font(Tokens.Typography.welcomeHeadline.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text("Notes, tasks and journals that stay yours. Encrypted on your device before they ever leave it.")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Tokens.Space.screenInline)
        .accessibilityElement(children: .combine)
    }
}

/// Page two: the three facts, each with something a user could verify.
private struct TrustPage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.section) {
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                Text("How Memry keeps it private")
                    .font(Tokens.Typography.screenTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Text("Three things worth knowing before you sign in.")
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .accessibilityElement(children: .combine)

            VStack(alignment: .leading, spacing: 0) {
                Fact(
                    symbol: "lock",
                    tinted: true,
                    title: "Encrypted before it leaves",
                    detail: "Your key never reaches our servers, so we cannot read a single note."
                )
                Divider().overlay(Tokens.Line.border.color)
                Fact(
                    symbol: "iphone.gen3",
                    tinted: false,
                    title: "Works with no signal",
                    detail: "Everything is stored on this phone first. Sync catches up when you are back online."
                )
                Divider().overlay(Tokens.Line.border.color)
                Fact(
                    symbol: "laptopcomputer.and.iphone",
                    tinted: false,
                    title: "One vault, every device",
                    detail: "Link this phone to your computer once, and both stay in step."
                )
            }
            Spacer()
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.top, Tokens.Space.section)
    }
}

private struct Fact: View {
    let symbol: String
    /// The one tinted moment on the screen. `DESIGN.md`: the tint fills, and
    /// one intense colour moment is stronger than five.
    let tinted: Bool
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.inset) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(tinted ? Tokens.Tint.base.color : Tokens.Text.primary.color)
                .frame(width: Tokens.Space.section, alignment: .leading)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(title)
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Text(detail)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .padding(.vertical, Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Where the user is in the two pages. Position only — the button label and the
/// content say what the page is, so this carries no accessibility value of its
/// own.
private struct PageDots: View {
    let current: WelcomeView.Page

    var body: some View {
        HStack(spacing: Tokens.Space.tight + 2) {
            ForEach(WelcomeView.Page.allCases, id: \.rawValue) { page in
                Capsule()
                    .fill(page == current ? Tokens.Tint.base.color : Tokens.Line.border.color)
                    .frame(width: page == current ? 18 : 4, height: 4)
            }
        }
        .accessibilityHidden(true)
    }
}

#Preview {
    WelcomeView {}
}
