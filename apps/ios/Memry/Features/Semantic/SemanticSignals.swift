import Foundation
import MemryCore
import SwiftUI
import UIKit

extension Thermal {
    init(_ state: ProcessInfo.ThermalState) {
        switch state {
        case .nominal: self = .nominal
        case .fair: self = .fair
        case .serious: self = .serious
        case .critical: self = .critical
        @unknown default: self = .critical
        }
    }
}

@MainActor
enum SemanticSignals {
    static func current() -> StepConditions {
        UIDevice.current.isBatteryMonitoringEnabled = true
        return StepConditions(
            thermal: Thermal(ProcessInfo.processInfo.thermalState),
            externalPower: UIDevice.current.batteryState != .unplugged
        )
    }
}

private struct SemanticEmbeddingScope: ViewModifier {
    let vault: Vault
    @Environment(\.semanticSearch) private var semantic
    @Environment(\.scenePhase) private var scenePhase
    private let memoryWarnings = NotificationCenter.default
        .publisher(for: UIApplication.didReceiveMemoryWarningNotification)

    func body(content: Content) -> some View {
        content
            .task(id: vault.id()) { SemanticBackgroundTask.shared.attach(semantic: semantic, vault: vault) }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .background else { return }
                semantic?.release(reason: .background)
                SemanticBackgroundTask.shared.scheduleIfReady()
            }
            .onReceive(memoryWarnings) { _ in semantic?.release(reason: .memoryWarning) }
    }
}

extension View {
    func semanticEmbedding(vault: Vault) -> some View {
        modifier(SemanticEmbeddingScope(vault: vault))
    }
}
