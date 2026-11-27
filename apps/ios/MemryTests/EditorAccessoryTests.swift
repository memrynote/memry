//
//  EditorAccessoryTests.swift
//  The keyboard toolbar in a window: the insert panel is as tall as the keys
//  below it, it grows with the `[[`, `@` and `#` menus, it steps aside for
//  a menu over the page, and a block left with the panel open gets its
//  keyboard back.
//

import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

extension KeyWindowSuites {
    @MainActor
    @Suite("the keyboard toolbar", .serialized)
    struct EditorAccessoryTests {
        private func window() throws -> UIWindow {
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = UIViewController()
            window.isHidden = false
            return window
        }

        /// Puts the toolbar where UIKit would: full width, its bottom
        /// `above` points over the screen's bottom edge.
        private func host(_ toolbar: UIView, in window: UIWindow, above: CGFloat) -> NSLayoutConstraint {
            window.addSubview(toolbar)
            let bottom = toolbar.bottomAnchor.constraint(equalTo: window.bottomAnchor, constant: -above)
            NSLayoutConstraint.activate([
                toolbar.leadingAnchor.constraint(equalTo: window.leadingAnchor),
                toolbar.trailingAnchor.constraint(equalTo: window.trailingAnchor),
                bottom,
            ])
            window.layoutIfNeeded()
            return bottom
        }

        private func keyboardWillShow(_ frame: CGRect, on screen: UIScreen) {
            NotificationCenter.default.post(
                name: UIResponder.keyboardWillShowNotification,
                object: screen,
                userInfo: [UIResponder.keyboardFrameEndUserInfoKey: frame, UIResponder.keyboardIsLocalUserInfoKey: true]
            )
        }

        @Test func the_insert_panel_is_as_tall_as_the_keys_below_the_toolbar() throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            let screen = try #require(window.windowScene?.screen)
            let toolbar = session.accessory
            let bottom = host(toolbar, in: window, above: 336)
            let height = toolbar.frame.height
            #expect(height > 0)

            // iOS 26's first frame for the keys reaches a bottom inset above
            // the toolbar.
            keyboardWillShow(
                CGRect(x: 0, y: screen.bounds.maxY - 336 - height - 34, width: screen.bounds.width, height: 336 + height + 34),
                on: screen
            )
            #expect(session.keyboardHeight == 336)

            // A hardware keyboard: only the toolbar is on screen, and the
            // frame runs off the bottom edge.
            bottom.constant = 0
            window.layoutIfNeeded()
            let floating = toolbar.frame.height
            keyboardWillShow(
                CGRect(x: 0, y: screen.bounds.maxY - floating, width: screen.bounds.width, height: floating + 311),
                on: screen
            )
            #expect(session.keyboardHeight == 336, "no keys below the toolbar, so the panel keeps its height")
        }

        @Test(.timeLimit(.minutes(1)), arguments: [" [[", " @", " #"])
        func the_toolbar_grows_when_its_menu_opens(typed: String) async throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            session.linkNotes = [NoteSummary(
                id: "dune", title: "Agent Dune", folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []
            )]
            session.tags = ["agent"]
            let toolbar = session.accessory
            _ = host(toolbar, in: window, above: 0)
            let closed = toolbar.frame.height

            // Typed as UIKit delivers keys to a text view with the caret.
            let textView = field.textView
            textView.selectedRange = NSRange(location: (textView.text as NSString).length, length: 0)
            for character in typed {
                if field.textView(textView, shouldChangeTextIn: textView.selectedRange, replacementText: String(character)) {
                    textView.insertText(String(character))
                    field.textViewDidChange(textView)
                }
            }
            #expect(session.menuOpen, "\(typed) opened no menu")
            for _ in 0 ..< 100 where toolbar.frame.height <= closed {
                try await Task.sleep(for: .milliseconds(20))
                window.layoutIfNeeded()
            }
            #expect(toolbar.frame.height > closed, "the toolbar stayed \(closed)pt with the \(typed) menu open")
        }

        @Test func the_toolbar_steps_aside_while_a_menu_is_over_the_page() async throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            let root = try #require(window.rootViewController)
            func keyboardMoved() {
                NotificationCenter.default.post(name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
            }

            await withCheckedContinuation { done in root.present(UIViewController(), animated: false) { done.resume() } }
            keyboardMoved()
            #expect(session.accessory.alpha == 0, "the toolbar covered the menu")

            // The keys come back while the menu is still on its way out,
            // as after a sheet's Cancel, and they do not move again.
            await withCheckedContinuation { done in
                root.dismiss(animated: true) { done.resume() }
                #expect(root.presentedViewController?.isBeingDismissed == true)
                keyboardMoved()
            }
            #expect(session.accessory.alpha == 1, "the toolbar stayed hidden after the menu closed")
        }

        @Test func a_block_left_with_the_insert_panel_open_gets_its_keyboard_back() throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            session.reduceMotion = { false }
            session.show(.insert)
            #expect(field.textView.inputView != nil)

            field.textViewDidEndEditing(field.textView)

            #expect(session.panel == .none)
            #expect(field.textView.inputView == nil, "the block shows an empty panel when the caret comes back")
        }
    }
}
