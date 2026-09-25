import SwiftUI

// Spec 006 ST43, artboards 12 / 12b / 13. Colour mode tiles (F6), accent
// presets plus a system ColorPicker (F7), and the built-in fonts. All three
// sync (F2), so the footer says so rather than Paper's "This iPhone" (F3).
struct AppearanceScreen: View {
    let store: SettingsStore
    @State private var custom = Color.orange

    var body: some View {
        List {
            if let failure = store.failure { Section { ErrorNotice(error: failure, code: nil) } }
            Section(SettingsCopy.colorMode) {
                HStack(spacing: Tokens.Space.small) {
                    ForEach(ThemeChoice.allCases) { theme in
                        ThemeTile(theme: theme, isSelected: store.theme == theme) {
                            Task { await store.setTheme(theme) }
                        }
                    }
                }
                .padding(.vertical, Tokens.Space.small)
            }
            Section(SettingsCopy.accentColor) {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: Tokens.Size.minimumHitArea))], spacing: Tokens.Space.small) {
                    ForEach(AccentColor.presets, id: \.hex) { preset in
                        ColorSwatch(
                            color: Tokens.Palette.color(preset.hex),
                            name: preset.name,
                            isSelected: store.accentHex == preset.hex
                        ) {
                            Task { await store.setAccent(preset.hex) }
                        }
                        .accessibilityIdentifier("settings.accent.\(preset.name)")
                    }
                }
                ColorPicker(SettingsCopy.customColor, selection: customBinding, supportsOpacity: false)
                    .font(Tokens.Typography.body.font)
                    .accessibilityIdentifier("settings.accent.custom")
            }
            Section {
                SettingsLinkRow(title: SettingsCopy.font, value: SettingsLabels.font(store.font), route: .font)
            } header: {
                Text(SettingsCopy.typography)
            } footer: {
                SettingsFooter(SettingsCopy.appearanceFooter)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.appearance)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { custom = Tokens.Palette.color(store.accentHex) }
    }

    private var customBinding: Binding<Color> {
        Binding(
            get: { custom },
            set: { color in
                custom = color
                guard let hex = AccentColor.hex(of: color) else { return }
                Task { await store.setAccent(hex) }
            }
        )
    }
}

/// One colour-mode tile: a small preview of the canvas plus its name.
private struct ThemeTile: View {
    let theme: ThemeChoice
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Tokens.Space.small) {
                RoundedRectangle(cornerRadius: Tokens.Radius.control)
                    .fill(preview)
                    .overlay {
                        RoundedRectangle(cornerRadius: Tokens.Radius.control)
                            .stroke(isSelected ? Tokens.Line.focus.color : Tokens.Line.border.color,
                                    lineWidth: isSelected ? 2 : Tokens.Size.hairline)
                    }
                    .frame(height: Tokens.Size.minimumHitArea + Tokens.Space.medium)
                Text(SettingsLabels.theme(theme))
                    .font(Tokens.Typography.caption.font.weight(isSelected ? .semibold : .regular))
                    .foregroundStyle(Tokens.Text.primary.color)
            }
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(SettingsLabels.theme(theme))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("settings.theme.\(theme.rawValue)")
    }

    private var preview: AnyShapeStyle {
        let light = Tokens.Canvas.background.light.uiColor
        let dark = Tokens.Canvas.background.dark.uiColor
        switch theme {
        case .light: return AnyShapeStyle(Color(Tokens.Canvas.surface.light.uiColor))
        case .white: return AnyShapeStyle(Color(light))
        case .dark: return AnyShapeStyle(Color(dark))
        case .system: return AnyShapeStyle(LinearGradient(colors: [Color(light), Color(dark)], startPoint: .leading, endPoint: .trailing))
        }
    }
}

/// Artboard 12b: the built-in fonts (installed-font search is desktop-only).
struct FontScreen: View {
    let store: SettingsStore

    var body: some View {
        List {
            Section {
                ForEach(FontChoice.allCases) { font in
                    Button {
                        Task { await store.setFont(font) }
                    } label: {
                        HStack {
                            Text(SettingsLabels.font(font))
                                .font(TypeRole(.body, design: design(font)).font)
                                .foregroundStyle(Tokens.Text.primary.color)
                            Spacer()
                            if store.font == font {
                                Image(systemName: "checkmark").foregroundStyle(Tokens.Text.tint.color)
                            }
                        }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                    }
                    .accessibilityAddTraits(store.font == font ? .isSelected : [])
                    .accessibilityIdentifier("settings.font.\(font.rawValue)")
                }
            } header: {
                Text(SettingsCopy.builtIn)
            } footer: {
                SettingsFooter(SettingsCopy.fontFooter)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.font)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func design(_ font: FontChoice) -> Font.Design {
        switch font {
        case .serif, .gelasio: .serif
        case .monospace: .monospaced
        default: .default
        }
    }
}

/// Artboard 14. The last shipped feature that is on refuses to turn off.
struct FeaturesScreen: View {
    let local: LocalSettings
    @State private var refused = false

    var body: some View {
        List {
            Section {
                ForEach(AppFeature.allCases.filter(SettingsFeatureGates.isShipped)) { feature in
                    SettingsToggleRow(title: title(feature), isOn: binding(feature),
                                      identifier: "settings.features.\(feature.rawValue)")
                }
            } footer: {
                SettingsFooter(refused ? SettingsCopy.keepOne : SettingsCopy.featuresFooter)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.features)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func title(_ feature: AppFeature) -> String {
        switch feature {
        case .home: SettingsCopy.home
        case .inbox: SettingsCopy.inbox
        case .journal: SettingsCopy.journal
        case .tasks: SettingsCopy.tasks
        }
    }

    private func binding(_ feature: AppFeature) -> Binding<Bool> {
        Binding(get: { local.isOn(feature) }, set: { refused = !local.set(feature, on: $0) })
    }
}

/// Artboard 21.
struct AboutScreen: View {
    var body: some View {
        List {
            Section {
                VStack(spacing: Tokens.Space.small) {
                    MemryMark()
                        .fill(Tokens.Text.primary.color)
                        .frame(width: 40 * MemryMark.aspectRatio, height: 40)
                        .accessibilityHidden(true)
                    Text("memrynote").font(Tokens.Typography.sectionTitle.font)
                    Text(SettingsCopy.version(Self.version, Self.build))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .accessibilityIdentifier("settings.about.version")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Tokens.Space.small)
            }
            Section(SettingsCopy.loveMemry) {
                link(SettingsCopy.starGitHub, "star", "https://github.com/memrynote/memry")
                link(SettingsCopy.feedback, "bubble.left", "https://github.com/memrynote/memry/issues?q=sort%3Aupdated-desc+is%3Aissue+is%3Aopen+")
            }
            Section {
                link(SettingsCopy.privacyPolicy, "hand.raised", "https://memrynote.com/privacy")
                link(SettingsCopy.terms, "doc.text", "https://memrynote.com/terms")
                DisclosureGroup(SettingsCopy.licenses) {
                    SettingsFooter(SettingsCopy.licensesBody)
                }
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.about)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func link(_ title: String, _ symbol: String, _ url: String) -> some View {
        Group {
            if let target = URL(string: url) {
                Link(destination: target) {
                    Label(title, systemImage: symbol).foregroundStyle(Tokens.Text.primary.color)
                }
                .frame(minHeight: Tokens.Size.minimumHitArea)
            }
        }
    }

    static var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—" }
    static var build: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—" }
}
