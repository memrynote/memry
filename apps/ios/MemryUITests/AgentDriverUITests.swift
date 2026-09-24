import XCTest

// A file-driven XCUITest harness for agent-run simulator checks.
//
// Why it exists: with Xcode 27 there is no Simulator.app, and host-side HID
// injection (AXe through Device Hub) stops delivering touches whenever Device
// Hub is not rendering the device. XCUITest synthesizes events inside the
// simulator through testmanagerd, so it keeps working headless.
//
// It is inert unless the runner gets `MEMRY_DRIVER_DIR` (pass it to xcodebuild
// as `TEST_RUNNER_MEMRY_DRIVER_DIR=<dir>`). The host writes `<dir>/cmd.json`,
// the test executes it and answers in `<dir>/res.json`, until a `stop` command.
@MainActor
final class AgentDriverUITests: XCTestCase {
    private let app = XCUIApplication()
    /// System alerts (notification permission) live in SpringBoard.
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var directory = URL(fileURLWithPath: "/")

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["MEMRY_DRIVER_DIR"], !path.isEmpty else {
            throw XCTSkip("MEMRY_DRIVER_DIR is not set; the agent driver only runs on demand.")
        }
        directory = URL(fileURLWithPath: path)
        continueAfterFailure = true
        executionTimeAllowance = 60 * 60 * 8
    }

    func testDrive() throws {
        let command = directory.appendingPathComponent("cmd.json")
        let response = directory.appendingPathComponent("res.json")
        write(["ok": true, "ready": true], to: response)
        while true {
            guard let data = try? Data(contentsOf: command) else {
                Thread.sleep(forTimeInterval: 0.1)
                continue
            }
            try? FileManager.default.removeItem(at: command)
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                write(["ok": false, "error": "unreadable command"], to: response)
                continue
            }
            let id = object["id"] as? String ?? ""
            if object["action"] as? String == "stop" {
                write(["ok": true, "id": id], to: response)
                return
            }
            var result = perform(object)
            result["id"] = id
            write(result, to: response)
        }
    }

    // MARK: - Commands

    private func perform(_ command: [String: Any]) -> [String: Any] {
        let action = command["action"] as? String ?? ""
        switch action {
        case "launch":
            app.terminate()
            app.launchArguments = command["args"] as? [String] ?? []
            app.launch()
            return ["ok": true]
        case "activate":
            app.activate()
            return ["ok": true]
        case "terminate":
            app.terminate()
            return ["ok": true]
        case "tree":
            return ["ok": true, "tree": app.debugDescription]
        case "screenshot":
            let path = command["path"] as? String ?? directory.appendingPathComponent("shot.png").path
            do {
                try XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: path))
                return ["ok": true, "path": path]
            } catch {
                return ["ok": false, "error": "\(error)"]
            }
        case "wait":
            let timeout = command["timeout"] as? Double ?? 10
            guard let element = find(command, timeout: timeout) else {
                return ["ok": false, "error": "not found"]
            }
            return ["ok": true, "label": element.label]
        case "gone":
            let timeout = command["timeout"] as? Double ?? 10
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                if find(command, timeout: 0) == nil { return ["ok": true] }
                Thread.sleep(forTimeInterval: 0.25)
            }
            return ["ok": false, "error": "still present"]
        case "tap", "doubletap", "longpress", "type", "swipe", "exists", "value", "drag", "adjust":
            return elementAction(action, command)
        case "tapxy":
            let x = command["x"] as? Double ?? 0.5
            let y = command["y"] as? Double ?? 0.5
            app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
            return ["ok": true]
        case "dragxy":
            let from = app.coordinate(withNormalizedOffset: CGVector(
                dx: command["x"] as? Double ?? 0.5, dy: command["y"] as? Double ?? 0.5
            ))
            let to = app.coordinate(withNormalizedOffset: CGVector(
                dx: command["toX"] as? Double ?? 0.5, dy: command["toY"] as? Double ?? 0.5
            ))
            from.press(forDuration: command["hold"] as? Double ?? 0.8, thenDragTo: to)
            return ["ok": true]
        case "typetext":
            app.typeText(command["text"] as? String ?? "")
            return ["ok": true]
        case "key":
            let key = command["key"] as? String ?? ""
            var flags: XCUIElement.KeyModifierFlags = []
            for modifier in command["modifiers"] as? [String] ?? [] {
                switch modifier {
                case "cmd": flags.insert(.command)
                case "shift": flags.insert(.shift)
                case "alt": flags.insert(.option)
                case "ctrl": flags.insert(.control)
                default: break
                }
            }
            app.typeKey(keyValue(key), modifierFlags: flags)
            return ["ok": true]
        case "wheel":
            // Sets one picker wheel (a time picker's hour, minute, AM/PM).
            let wheels = app.pickerWheels
            let index = command["index"] as? Int ?? 0
            guard wheels.count > index else { return ["ok": false, "error": "no wheel \(index)"] }
            wheels.element(boundBy: index).adjust(toPickerWheelValue: command["value"] as? String ?? "")
            return ["ok": true, "count": wheels.count]
        case "home":
            XCUIDevice.shared.press(.home)
            return ["ok": true]
        case "sleep":
            Thread.sleep(forTimeInterval: command["seconds"] as? Double ?? 1)
            return ["ok": true]
        default:
            return ["ok": false, "error": "unknown action \(action)"]
        }
    }

    private func elementAction(_ action: String, _ command: [String: Any]) -> [String: Any] {
        let timeout = command["timeout"] as? Double ?? 5
        if action == "exists" {
            return ["ok": true, "exists": find(command, timeout: timeout) != nil]
        }
        guard let element = find(command, timeout: timeout) else {
            return ["ok": false, "error": "not found"]
        }
        // Read before acting: a tapped button may be gone afterwards, and
        // reading a vanished element's label is a test failure that ends the
        // driver.
        let label = element.label
        // A tap on an element with no hit point (off screen, covered) is a
        // test failure that ends the driver; answer with an error instead.
        let needsHitPoint = ["tap", "doubletap", "longpress", "drag"].contains(action)
            || (action == "type" && command["tapFirst"] as? Bool ?? true)
        if needsHitPoint, command["dx"] == nil, !element.isHittable {
            return ["ok": false, "error": "not hittable", "label": label]
        }
        switch action {
        case "tap":
            if let dx = command["dx"] as? Double, let dy = command["dy"] as? Double {
                element.coordinate(withNormalizedOffset: CGVector(dx: dx, dy: dy)).tap()
            } else {
                element.tap()
            }
        case "doubletap":
            element.doubleTap()
        case "longpress":
            element.press(forDuration: command["duration"] as? Double ?? 1.0)
        case "type":
            if command["tapFirst"] as? Bool ?? true { element.tap() }
            if command["clear"] as? Bool ?? false, let current = element.value as? String, !current.isEmpty {
                element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
            }
            element.typeText(command["text"] as? String ?? "")
        case "swipe":
            switch command["direction"] as? String ?? "up" {
            case "down": element.swipeDown()
            case "left": element.swipeLeft()
            case "right": element.swipeRight()
            default: element.swipeUp()
            }
        case "value":
            return ["ok": true, "value": "\(element.value ?? "")", "label": element.label]
        case "adjust":
            element.adjust(toNormalizedSliderPosition: command["position"] as? Double ?? 0.5)
        case "drag":
            var target = command
            target["label"] = command["toLabel"]
            target["ident"] = command["toIdent"]
            target["type"] = command["toType"]
            target["index"] = command["toIndex"]
            target["contains"] = command["toContains"]
            guard let destination = find(target, timeout: timeout) else {
                return ["ok": false, "error": "drop target not found"]
            }
            element.press(
                forDuration: command["hold"] as? Double ?? 0.8,
                thenDragTo: destination,
                withVelocity: .slow,
                thenHoldForDuration: 0.5
            )
        default:
            break
        }
        return ["ok": true, "label": label]
    }

    /// Selector: `ident` (accessibility identifier), `label` (exact), `contains` (label substring),
    /// optional `type` (button, cell, staticText, textField, textView, switch,
    /// image, other, any) and `index`.
    private func find(_ command: [String: Any], timeout: Double) -> XCUIElement? {
        // Querying an app that is not running is a test failure that ends the
        // driver; answer "not found" instead.
        let target = command["app"] as? String == "springboard" ? springboard : app
        guard target.state != .notRunning else { return nil }
        let type = elementType(command["type"] as? String)
        var query = target.descendants(matching: type)
        if let identifier = command["ident"] as? String {
            query = query.matching(identifier: identifier)
        } else if let label = command["label"] as? String {
            query = query.matching(NSPredicate(format: "label == %@", label))
        } else if let contains = command["contains"] as? String {
            query = query.matching(NSPredicate(format: "label CONTAINS[c] %@", contains))
        }
        let index = command["index"] as? Int ?? 0
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if query.count > index {
                let element = query.element(boundBy: index)
                if element.exists { return element }
            }
            if timeout > 0 { Thread.sleep(forTimeInterval: 0.25) }
        } while Date() < deadline
        return nil
    }

    private func elementType(_ name: String?) -> XCUIElement.ElementType {
        switch name {
        case "button": .button
        case "cell": .cell
        case "staticText", "text": .staticText
        case "textField": .textField
        case "secureTextField": .secureTextField
        case "textView": .textView
        case "switch": .switch
        case "image": .image
        case "other": .other
        case "menuItem": .menuItem
        case "segmentedControl": .segmentedControl
        case "picker": .pickerWheel
        case "datePicker": .datePicker
        case "tab": .tab
        case "tabBar": .tabBar
        case "navigationBar": .navigationBar
        case "slider": .slider
        case "link": .link
        case "sheet": .sheet
        case "alert": .alert
        case "collectionView": .collectionView
        case "scrollView": .scrollView
        case "table": .table
        case "searchField": .searchField
        case "toggle": .toggle
        default: .any
        }
    }

    private func keyValue(_ key: String) -> String {
        switch key {
        case "return": XCUIKeyboardKey.return.rawValue
        case "delete": XCUIKeyboardKey.delete.rawValue
        case "escape": XCUIKeyboardKey.escape.rawValue
        case "tab": XCUIKeyboardKey.tab.rawValue
        case "space": XCUIKeyboardKey.space.rawValue
        case "up": XCUIKeyboardKey.upArrow.rawValue
        case "down": XCUIKeyboardKey.downArrow.rawValue
        case "left": XCUIKeyboardKey.leftArrow.rawValue
        case "right": XCUIKeyboardKey.rightArrow.rawValue
        default: key
        }
    }

    private func write(_ object: [String: Any], to url: URL) {
        let staging = url.deletingLastPathComponent().appendingPathComponent("res.tmp")
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        try? data.write(to: staging)
        _ = try? FileManager.default.replaceItemAt(url, withItemAt: staging)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.moveItem(at: staging, to: url)
        }
    }
}
