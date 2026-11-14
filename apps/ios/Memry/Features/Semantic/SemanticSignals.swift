import Foundation
import MemryCore
import SwiftUI
import UIKit

// #4512. The OS signals the embedder and the model slot listen to: thermal
// state and power for each step, leaving the foreground and memory warnings
// for the 330 MB model.

extension Thermal {
    init(_ state: ProcessInfo.ThermalState) {
        switch state {
        case .nominal: self = .nominal
        case .fair: self = .fair
        case .serious: self = .serious
        case .critical: self = .critical
        // An unknown future state stops the embedder rather than heat the phone.
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

/// Hands the open vault to the background embedder, and relays leaving the
/// foreground and memory warnings to the model slot.
private struct SemanticEmbeddingScope: ViewModifier {
    let vault: Vault
    @Environment(\.semanticSearch) private var semantic
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .task(id: vault.id()) { SemanticBackgroundTask.shared.attach(semantic: semantic, vault: vault) }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .background else { return }
                semantic?.release(reason: .background)
                SemanticBackgroundTask.shared.scheduleIfDue()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                semantic?.release(reason: .memoryWarning)
            }
    }
}

extension View {
    func semanticEmbedding(vault: Vault) -> some View {
        modifier(SemanticEmbeddingScope(vault: vault))
    }
}
