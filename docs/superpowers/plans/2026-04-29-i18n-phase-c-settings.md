# i18n Phase C — Settings Namespace Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the full Settings UI to the `settings.json` namespace so every settings panel, tab, dialog, toast, option label, empty state, and aria/title string renders through i18n while Turkish and Arabic settings namespaces fall back to English.

**Architecture:** This is a feature-namespace migration on top of Phase A/B infrastructure. Populate `packages/i18n/src/locales/en/settings.json`, reset `packages/i18n/src/locales/{tr,ar}/settings.json` to literal `{}`, and update settings-owned renderer components to call `useT('settings')`; use `useT('common')` only for Phase B common verbs/states that already exist. Keep dynamic user/content/service names untranslated, and keep errors from service/runtime payloads as-is until Phase D.

**Tech Stack:** TypeScript, React 19, `react-i18next`, `@memry/i18n`, Vitest, Testing Library, Playwright/Electron smoke where already available.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Depends on:** Phase A and Phase B merged or rebased underneath this work:
- Phase A: `packages/i18n`, renderer `I18nProvider`, `useT`, `settings.json`, locale IPC, Settings language picker.
- Phase B: populated `common.json` universal strings such as `common:button.save`, `common:button.cancel`, `common:button.close`, `common:button.copy`, `common:button.retry`, `common:state.loading`.

**Out of scope:**
- Phase D `errors.json`, native menu migration, main-process errors, Electron menu labels.
- Phase E i18n lint rule, AST checker, codemod, pseudo-locale.
- Translating TR/AR settings content. `packages/i18n/src/locales/tr/settings.json` and `packages/i18n/src/locales/ar/settings.json` must be literal `{}` in this phase.
- Migrating non-settings feature folders unless they are account/setup components used exclusively by Settings.
- Refactoring Settings layout, storage behavior, sync behavior, shortcut registry behavior, or Google Calendar logic beyond replacing user-visible strings.

---

## Work Scope

Only settings-owned UI strings are in scope. Do not edit other agents' Phase C plans.

### Files to inspect before editing

- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- `packages/i18n/src/locales/en/settings.json`
- `packages/i18n/src/locales/tr/settings.json`
- `packages/i18n/src/locales/ar/settings.json`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/renderer/use-t.ts`
- `apps/desktop/src/renderer/src/components/settings-modal.tsx`
- `apps/desktop/src/renderer/src/pages/settings.tsx`
- `apps/desktop/src/renderer/src/pages/settings/*.tsx`
- `apps/desktop/src/renderer/src/components/settings/*.tsx`
- `apps/desktop/src/renderer/src/components/sync/{email-entry-form,otp-input,otp-verification,oauth-buttons,recovery-phrase-display,recovery-phrase-confirm,recovery-phrase-input,linking-code-entry,linking-pending,qr-linking,linking-approval-dialog,device-list,key-rotation-wizard}.tsx`
- `apps/desktop/src/renderer/src/lib/integration-registry.ts`
- `apps/desktop/src/renderer/src/lib/shortcut-registry.ts`
- `apps/desktop/src/renderer/src/hooks/use-sync-status.ts`
- `apps/desktop/tests/utils/render.tsx`

### Files to modify

- `packages/i18n/src/locales/en/settings.json`
- `packages/i18n/src/locales/tr/settings.json`
- `packages/i18n/src/locales/ar/settings.json`
- `apps/desktop/src/renderer/src/components/settings-modal.tsx`
- `apps/desktop/src/renderer/src/pages/settings.tsx`
- `apps/desktop/src/renderer/src/pages/settings/account-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/ai-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/appearance-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/calendar-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/editor-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/integrations-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/journal-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/properties-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/setup-wizard.tsx`
- `apps/desktop/src/renderer/src/pages/settings/shortcuts-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/tags-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/tasks-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/templates-section.tsx`
- `apps/desktop/src/renderer/src/pages/settings/vault-section.tsx`
- `apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.tsx`
- `apps/desktop/src/renderer/src/components/settings/google-calendar-source-picker.tsx`
- `apps/desktop/src/renderer/src/components/settings/integration-list.tsx`
- `apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx`
- `apps/desktop/src/renderer/src/components/settings/settings-primitives.tsx`
- `apps/desktop/src/renderer/src/components/settings/storage-usage-bar.tsx`
- `apps/desktop/src/renderer/src/components/settings/tag-manager.tsx`
- `apps/desktop/src/renderer/src/components/sync/email-entry-form.tsx`
- `apps/desktop/src/renderer/src/components/sync/otp-input.tsx`
- `apps/desktop/src/renderer/src/components/sync/otp-verification.tsx`
- `apps/desktop/src/renderer/src/components/sync/oauth-buttons.tsx`
- `apps/desktop/src/renderer/src/components/sync/recovery-phrase-display.tsx`
- `apps/desktop/src/renderer/src/components/sync/recovery-phrase-confirm.tsx`
- `apps/desktop/src/renderer/src/components/sync/recovery-phrase-input.tsx`
- `apps/desktop/src/renderer/src/components/sync/linking-code-entry.tsx`
- `apps/desktop/src/renderer/src/components/sync/linking-pending.tsx`
- `apps/desktop/src/renderer/src/components/sync/qr-linking.tsx`
- `apps/desktop/src/renderer/src/components/sync/linking-approval-dialog.tsx`
- `apps/desktop/src/renderer/src/components/sync/device-list.tsx`
- `apps/desktop/src/renderer/src/components/sync/key-rotation-wizard.tsx`
- `apps/desktop/src/renderer/src/lib/integration-registry.ts`
- `apps/desktop/src/renderer/src/hooks/use-sync-status.ts`
- `apps/desktop/src/renderer/src/pages/settings/tasks-section.test.tsx`
- `apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.test.tsx`

### Files to create

- `apps/desktop/src/renderer/src/pages/settings/settings-page.i18n.test.tsx`
- `apps/desktop/src/renderer/src/pages/settings/general-section.i18n.test.tsx`
- `apps/desktop/src/renderer/src/pages/settings/shortcut-registry-i18n.test.tsx`

Do not create helper abstractions unless the repeated pattern is already obvious after migration. Prefer plain local key maps in each component.

---

## Translation Key Rules

- Settings components use `const { t } = useT('settings')`.
- Components that need common verbs can also call `const { t: tCommon } = useT('common')`.
- Use `settings.json` for setting-specific labels, descriptions, groups, tabs, statuses, toasts, placeholders, aria labels, dialog titles, dialog descriptions, option labels, shortcut labels/descriptions/categories used inside Settings, integration descriptions, sync setup copy, and account/security copy.
- Use `common` only for already-supplied Phase B keys such as `button.cancel`, `button.copy`, `button.retry`, `button.save`, `button.close`, `state.loading`.
- Do not put `LOCALE_DISPLAY_NAMES` values into `settings.json`; language names remain native-script constants.
- Keep user-provided names untranslated: email addresses, device names, tag names, property names, template names, project names, calendar names, account emails, provider model names, API key provider names.
- Keep low-level runtime/service error payloads as-is. Only fallback strings passed to `extractErrorMessage` may move into `settings.json` if they are settings-owned.
- Replace plural string concatenation with ICU keys in `settings.json`, for example `tags.summary`, `properties.summary`, `devices.more`, `storage.used`, `shortcuts.conflict`.
- TR/AR feature namespace files remain `{}` exactly:

```json
{}
```

---

## English `settings.json` Shape

Populate English only. Use this shape as the migration checklist; add keys only when a concrete migrated string needs them.

```json
{
  "page": {
    "title": "Settings",
    "nav": {
      "groups": {
        "workspace": "Workspace",
        "preferences": "Preferences",
        "services": "Services",
        "data": "Data"
      },
      "items": {
        "account": "Account",
        "general": "General",
        "templates": "Templates",
        "editor": "Editor",
        "journal": "Journal",
        "tasks": "Tasks",
        "calendar": "Calendar",
        "appearance": "Appearance",
        "shortcuts": "Shortcuts",
        "ai": "AI Assistant",
        "integrations": "Integrations",
        "vault": "Vault",
        "tags": "Tags",
        "properties": "Properties"
      }
    }
  },
  "general": {
    "header": { "title": "General", "subtitle": "Application startup and tab behavior" },
    "groups": {
      "startup": "Startup",
      "updates": "Updates",
      "languageRegion": "Language & Region",
      "tabBehavior": "Tab Behavior",
      "fileCreation": "File Creation"
    },
    "startup": {
      "launchAtLogin": {
        "label": "Launch at Login",
        "description": "Start Memry when you log in",
        "error": "Failed to update start on boot"
      }
    },
    "updates": {
      "appUpdates": "App Updates",
      "installedVersion": "Installed version {version}",
      "availableVersion": "Available version {version}",
      "unsupported": "Packaged builds can check, download, and install updates from GitHub Releases",
      "available": "Memry {version} is available to download",
      "downloadingLatest": "Downloading the latest release",
      "downloadingLatestPercent": "Downloading the latest release ({percent}%)",
      "downloaded": "Memry {version} is ready to install",
      "upToDate": "This installation is on the latest published release",
      "checking": "Checking GitHub Releases for a newer version",
      "idle": "Check for new releases and install them without leaving the app",
      "unsupportedToast": "Auto-updates are available in packaged releases only",
      "upToDateToast": "Memry {version} is up to date",
      "actionFailed": "Update action failed",
      "actions": {
        "checking": "Checking...",
        "available": "Download Update",
        "downloading": "Downloading...",
        "downloadingPercent": "Downloading {percent}%",
        "downloaded": "Restart to Install",
        "idle": "Check for Updates"
      }
    },
    "language": {
      "label": "Language",
      "helper": "Most of the app updates immediately. Some system-level text — already-shown notifications, dock label, window title bar — refreshes after the next launch.",
      "changed": "Language changed to {nativeName}",
      "failed": "Failed to change language. Please try again."
    },
    "clockFormat": {
      "label": "Time Format",
      "description": "12-hour or 24-hour clock",
      "options": { "12h": "12-hour", "24h": "24-hour" },
      "error": "Failed to update time format"
    },
    "tabs": {
      "previewMode": {
        "label": "Preview Mode",
        "description": "Single-click opens preview, double-click keeps open"
      },
      "restoreSession": {
        "label": "Restore Session on Start",
        "description": "Reopen tabs from your last session"
      },
      "closeButton": {
        "label": "Tab Close Button",
        "description": "When to show the close button",
        "options": {
          "always": "Always visible",
          "hover": "Show on hover",
          "active": "Only on active tab"
        }
      },
      "error": "Failed to update setting"
    },
    "fileCreation": {
      "createInSelectedFolder": {
        "label": "Create in Selected Folder",
        "description": "New notes and folders are created inside the currently selected folder. When off, items are always created at root."
      }
    }
  },
  "appearance": {
    "header": { "title": "Appearance", "subtitle": "Customize the look and feel" },
    "groups": { "theme": "Theme", "accentColor": "Accent Color", "typography": "Typography" },
    "theme": {
      "colorMode": { "label": "Color Mode", "description": "Choose your preferred theme", "aria": "Color mode" },
      "options": { "light": "Warm", "white": "White", "dark": "Dark", "system": "System" },
      "error": "Failed to update theme"
    },
    "accent": {
      "pick": "Pick an accent color",
      "custom": { "label": "Custom Color", "description": "Enter a hex value", "placeholder": "#000000" },
      "presets": {
        "indigo": "Indigo",
        "amber": "Amber",
        "emerald": "Emerald",
        "red": "Red",
        "violet": "Violet",
        "cyan": "Cyan",
        "pink": "Pink",
        "orange": "Orange"
      },
      "error": "Failed to update accent color"
    },
    "typography": {
      "fontSize": { "label": "Font Size", "description": "Adjust the base text size", "aria": "Font size" },
      "fontFamily": {
        "label": "Font Family",
        "description": "Primary typeface for the interface",
        "options": {
          "system": "System Default",
          "sansSerif": "Sans-serif",
          "serif": "Serif (Crimson Pro)",
          "gelasio": "Gelasio",
          "geist": "Geist",
          "inter": "Inter",
          "monospace": "Monospace"
        }
      },
      "fontSizeError": "Failed to update font size",
      "fontFamilyError": "Failed to update font family"
    }
  },
  "editor": {
    "header": { "title": "Editor", "subtitle": "Note editor settings and preferences" },
    "groups": { "layout": "Layout", "toolbar": "Toolbar", "writing": "Writing" },
    "width": {
      "label": "Editor Width",
      "description": "Maximum width of the writing area",
      "options": { "narrow": "Narrow", "medium": "Medium", "wide": "Wide" },
      "error": "Failed to update editor width"
    },
    "toolbarMode": {
      "label": "Sticky Formatting Toolbar",
      "description": "Always show toolbar above the editor",
      "error": "Failed to update toolbar mode"
    },
    "spellCheck": {
      "label": "Spell Check",
      "description": "Underline misspelled words while typing",
      "error": "Failed to update spell check"
    },
    "autoSaveDelay": {
      "label": "Auto-Save Delay",
      "description": "Wait time after typing stops before saving",
      "seconds": "{seconds}s",
      "error": "Failed to update auto-save delay"
    },
    "wordCount": {
      "label": "Word Count",
      "description": "Show word count in the editor footer",
      "error": "Failed to update word count display"
    }
  },
  "templates": {
    "header": { "title": "Templates", "subtitle": "Manage note templates for quick creation" },
    "actions": { "new": "New Template", "edit": "Edit", "duplicate": "Duplicate", "delete": "Delete" },
    "groups": { "builtIn": "Built-in", "myTemplates": "My Templates" },
    "loading": "Loading templates...",
    "newTemplateTitle": "New Template",
    "copySuffix": "{name} (Copy)",
    "empty": { "title": "No custom templates yet", "description": "Create a template to get started" },
    "toasts": {
      "deleted": "Template deleted",
      "deleteFailed": "Failed to delete template",
      "duplicated": "Template duplicated",
      "duplicateFailed": "Failed to duplicate template"
    },
    "dialogs": {
      "delete": {
        "title": "Delete Template",
        "description": "Are you sure you want to delete this template? This action cannot be undone. Notes created from this template will not be affected."
      },
      "duplicate": {
        "title": "Duplicate Template",
        "description": "Enter a name for the new template copy.",
        "placeholder": "Template name"
      }
    }
  },
  "journal": {
    "header": { "title": "Journal", "subtitle": "Journal settings and preferences" },
    "groups": { "defaultTemplate": "Default Template", "sidebarVisibility": "Sidebar Visibility", "footer": "Footer" },
    "template": {
      "label": "Template",
      "description": "New entries start with this template",
      "placeholder": "Select a template",
      "unknown": "Unknown template",
      "none": "None",
      "noneAsk": "None (ask each time)",
      "updated": "Default template updated",
      "cleared": "Default template cleared",
      "error": "Failed to update default template"
    },
    "showSchedule": { "label": "Show Schedule", "description": "Display today's events and calendar" },
    "showTasks": { "label": "Show Tasks", "description": "Display tasks due on the selected day" },
    "showAIConnections": { "label": "Show AI Connections", "description": "Display AI-powered connections to related entries" },
    "showStatsFooter": { "label": "Show Stats Footer", "description": "Word count, reading time, timestamps" },
    "updateError": "Failed to update setting"
  },
  "tasks": {
    "header": { "title": "Tasks", "subtitle": "Configure task defaults and behavior" },
    "groups": { "defaults": "Defaults", "calendar": "Calendar", "inbox": "Inbox" },
    "defaultProject": {
      "label": "Default Project",
      "description": "Assigned when no project is selected",
      "placeholder": "No default project",
      "none": "No default (use Personal)",
      "error": "Failed to update default project"
    },
    "sortOrder": {
      "label": "Default Sort Order",
      "description": "How tasks are ordered in list view",
      "options": {
        "manual": "Manual (drag & drop)",
        "dueDate": "Due Date",
        "priority": "Priority",
        "createdAt": "Date Created"
      },
      "error": "Failed to update sort order"
    },
    "weekStart": {
      "label": "Week Starts On",
      "description": "First day of the week in calendar views",
      "options": { "sunday": "Sunday", "monday": "Monday" },
      "error": "Failed to update week start"
    },
    "staleInbox": {
      "label": "Stale Inbox Threshold",
      "description": "Tasks older than this are highlighted as stale",
      "unit": "days",
      "error": "Failed to update stale inbox threshold"
    }
  },
  "calendar": {
    "header": { "title": "Calendar", "subtitle": "Configure day-cell behavior in the Day Panel" },
    "groups": { "dayCellClick": "Day Cell Click" },
    "defaultBehavior": {
      "label": "Default behavior",
      "description": "When clicking a day in the Day Panel calendar from any non-calendar tab",
      "error": "Failed to update day click behavior"
    },
    "pageOverride": {
      "label": "Calendar page override",
      "description": "Behavior when the Calendar tab is active (defaults to Open Calendar)",
      "error": "Failed to update calendar page override"
    },
    "options": {
      "openJournal": "Open Journal",
      "openCalendar": "Open Calendar",
      "useGlobal": "Use global setting"
    }
  },
  "account": {
    "header": { "title": "Account", "subtitle": "Your account, sync, and security" },
    "groups": { "identity": "Identity", "sync": "Sync", "storage": "Storage", "devices": "Devices", "security": "Security" },
    "identity": { "unknown": "Unknown", "plan": "Pro plan" },
    "sync": {
      "lastSynced": "Last synced {time}",
      "pending": "{count, plural, one {# pending} other {# pending}}",
      "statuses": {
        "synced": "Synced",
        "syncing": "Syncing...",
        "paused": "Paused",
        "syncError": "Sync Error",
        "offline": "Offline",
        "connecting": "Connecting...",
        "pushedPulled": "{parts}",
        "changesPending": "{count, plural, one {# change pending} other {# changes pending}}",
        "offlinePending": "Offline ({count, plural, one {# change pending} other {# changes pending}})",
        "never": "Never"
      }
    },
    "storage": {
      "used": "{used} of {limit} used",
      "categories": { "notes": "Notes", "attachments": "Attachments", "crdt": "CRDT", "other": "Other", "available": "Available" }
    },
    "security": {
      "recoveryKey": { "label": "Recovery Key", "description": "View your recovery key for data access", "action": "View Key" },
      "rotateKeys": { "label": "Rotate Encryption Keys", "description": "Generate new keys and re-encrypt all data", "action": "Rotate" },
      "signOut": { "label": "Sign Out", "description": "Disconnect this device from sync", "action": "Sign Out" }
    },
    "signOutDialog": {
      "title": "Sign out of sync?",
      "description": "Sync will stop and encryption keys will be removed from this device. Your notes will remain on this device. You'll need your recovery phrase to set up sync again.",
      "confirm": "Sign out",
      "signingOut": "Signing out..."
    },
    "toasts": {
      "signedOut": "Signed out successfully",
      "signOutFailed": "Failed to sign out",
      "deviceLinked": "Device linked successfully"
    }
  },
  "setup": {
    "steps": { "signIn": "Sign In", "verify": "Verify", "link": "Link" },
    "progress": "Step {current} of {total}: {label}",
    "signIn": {
      "title": "Set up Sync",
      "description": "Create an account to sync your data across devices with end-to-end encryption.",
      "or": "or",
      "errors": { "sendCode": "Failed to send code", "googleStart": "Failed to start Google sign-in" }
    },
    "email": {
      "label": "Email address",
      "placeholder": "Enter your email address...",
      "invalid": "Please enter a valid email address",
      "sending": "Sending code..."
    },
    "oauth": { "google": "Continue with Google" },
    "otp": {
      "title": "Enter verification code",
      "sentTo": "We sent a 6-digit code to ",
      "aria": "6-digit verification code",
      "verifying": "Verifying...",
      "resending": "Resending...",
      "resend": "Resend code",
      "resendIn": "Resend in {time}",
      "differentEmail": "Use a different email",
      "error": "Verification failed",
      "resendError": "Failed to resend"
    },
    "recovery": {
      "displayTitle": "Save your recovery phrase",
      "displayDescription": "This is the only way to recover your encrypted data if you lose access to all your devices.",
      "warning": "Write this down and store it somewhere safe. You will not see it again.",
      "wordsAria": "Recovery phrase words",
      "wordAria": "Word {index}: {word}",
      "copyAria": "Copy recovery phrase to clipboard",
      "copiedAria": "Recovery phrase copied",
      "copied": "Copied",
      "saved": "I've saved my recovery phrase",
      "confirmTitle": "Confirm your recovery phrase",
      "confirmDescription": "Enter the requested words to verify you've saved it correctly.",
      "wordPlaceholder": "Enter word #{index}",
      "verify": "Verify",
      "mustMatch": "All 3 words must match to continue",
      "inputTitle": "Enter recovery phrase",
      "inputDescription": "Enter your 24-word recovery phrase to restore access to your encrypted data.",
      "inputLabel": "Recovery phrase",
      "count": "{count} / {total} words",
      "inputPlaceholder": "Enter your 24-word recovery phrase separated by spaces...",
      "lengthHint": "Enter all 24 words to enable the restore button",
      "restore": "Restore access",
      "progress": {
        "deriving": "Deriving encryption keys...",
        "validating": "Validating recovery phrase...",
        "registering": "Registering device..."
      },
      "failed": "Recovery failed",
      "confirmationFailed": "Confirmation failed"
    },
    "linking": {
      "choiceTitle": "Link this device",
      "choiceDescription": "Transfer encryption keys from another device or restore from your recovery phrase.",
      "qrChoice": "Link via QR code",
      "qrChoiceDescription": "Scan the code shown on your other device",
      "recoveryChoice": "Recovery phrase",
      "recoveryChoiceDescription": "Enter your 24-word recovery phrase",
      "codeTitle": "Enter linking code",
      "codeDescription": "Paste the linking code from your other device to securely transfer your encryption keys.",
      "codeLabel": "Linking code",
      "valid": "Valid",
      "invalid": "Invalid format",
      "codePlaceholder": "Paste the code from your other device...",
      "formatHint": "Paste the JSON linking code from your other device",
      "linking": "Linking...",
      "linkDevice": "Link device",
      "failed": "Linking failed",
      "deviceFailed": "Failed to link device",
      "pendingSuccess": "Device linked successfully",
      "goBack": "Go back",
      "waitingTitle": "Waiting for approval",
      "waitingDescription": "Open Memry on your other device and approve the linking request.",
      "verificationCode": "Verification code",
      "confirmCode": "Confirm this matches the code on your other device"
    }
  },
  "devices": {
    "loading": "Loading devices...",
    "loadingAria": "Loading devices",
    "none": "No devices linked yet",
    "linkNew": "Link new device",
    "thisDevice": "This device",
    "lastSeen": "Last seen {time} ago",
    "linked": "Linked {time} ago",
    "renameAria": "Rename {name}",
    "rename": "Rename",
    "revoke": "Revoke",
    "showLess": "Show less",
    "showMore": "{count, plural, one {# more device} other {# more devices}}",
    "showMoreAria": "Show {count, plural, one {# more device} other {# more devices}}",
    "dialogs": {
      "revokeTitle": "Revoke “{name}”?",
      "revokeDescription": "This device will lose access to your synced data. It will need to be linked again to restore sync. Local data on that device will remain.",
      "revokeDevice": "Revoke device",
      "revoking": "Revoking...",
      "renameTitle": "Rename device",
      "renameDescription": "Choose a name to identify this device.",
      "namePlaceholder": "Device name",
      "renaming": "Renaming..."
    },
    "toasts": {
      "loadFailed": "Failed to load devices",
      "removed": "Removed \"{name}\"",
      "removeFailed": "Failed to remove device",
      "renamed": "Renamed to \"{name}\"",
      "renameFailed": "Failed to rename device"
    }
  },
  "qrLinking": {
    "title": "Link new device",
    "description": "Scan this QR code from the device you want to link to transfer your encryption keys securely.",
    "encrypted": "End-to-end encrypted",
    "generating": "Generating linking code...",
    "generatingAria": "Generating linking code",
    "generateFailed": "Failed to generate linking code",
    "tryAgain": "Try again",
    "expired": "Linking code expired",
    "generateNew": "Generate new code",
    "qrAria": "QR code for device linking",
    "qrImageAria": "Device linking QR code",
    "expiresIn": "Expires in {time}",
    "or": "or",
    "codeLabel": "Linking code",
    "copyAria": "Copy linking code",
    "copiedAria": "Copied",
    "copied": "Copied!"
  },
  "linkingApproval": {
    "title": "New device wants to link",
    "description": "A device is requesting access to your encrypted data. Only approve if you initiated this request.",
    "unknownDevice": "Unknown device",
    "unknownPlatform": "Unknown platform",
    "verificationCode": "Verification code",
    "computing": "Computing...",
    "unavailable": "Unavailable",
    "confirmCode": "Confirm this code matches the one shown on the new device",
    "reject": "Reject",
    "approve": "Approve",
    "approving": "Approving...",
    "approvalFailed": "Approval failed",
    "failedToApprove": "Failed to approve device"
  },
  "recoveryKey": {
    "title": "Recovery Key",
    "description": "Store this key securely. It can restore your vault if you lose access to all devices.",
    "retrieveFailed": "Failed to retrieve recovery key",
    "copied": "Recovery key copied to clipboard",
    "copyFailed": "Failed to copy to clipboard",
    "clickToReveal": "Click to reveal",
    "hide": "Hide",
    "reveal": "Reveal",
    "copy": "Copy",
    "sessionHint": "This key is shown once per session. Close this dialog to clear it from memory."
  },
  "keyRotation": {
    "title": "Rotate Encryption Keys",
    "descriptions": {
      "confirm": "Generate new encryption keys for your vault.",
      "rotating": "Re-encrypting your data with new keys...",
      "phrase": "Save your new recovery phrase.",
      "complete": "Key rotation complete.",
      "error": "Key rotation encountered an error."
    },
    "warningTitle": "This action will:",
    "warningItems": {
      "keyPair": "Generate a new encryption key pair",
      "rewrap": "Re-wrap all synced items with the new key",
      "phrase": "Produce a new recovery phrase (old one becomes invalid)",
      "pause": "Temporarily pause sync during the process"
    },
    "explanation": "Your data content is never re-encrypted — only the key envelopes change. This is a fast, safe operation.",
    "start": "Start Key Rotation",
    "starting": "Starting...",
    "phases": {
      "preparing": "Preparing...",
      "reencrypting": "Re-wrapping keys ({processed}/{total})",
      "finalizing": "Finalizing...",
      "working": "Working..."
    },
    "progressAria": "Key rotation: {phaseLabel} {pct}%",
    "progressLabel": "Key rotation progress",
    "doNotClose": "Do not close the application during this process.",
    "complete": "All encryption keys have been rotated. Your new recovery phrase has been saved. Sync will resume automatically.",
    "unknownError": "An unknown error occurred during key rotation.",
    "errorHint": "Your existing keys remain valid. Sync has been resumed. You can retry at any time.",
    "closeConfirm": {
      "title": "Rotation in progress",
      "description": "Key rotation is still running. Closing this dialog will not stop the process, but you won't see your new recovery phrase until it completes.",
      "stay": "Stay",
      "closeAnyway": "Close anyway"
    },
    "failed": "Key rotation failed"
  },
  "ai": {
    "header": {
      "title": "AI Assistant",
      "subtitle": "Embeddings run locally. Voice memos can use Whisper Small or your OpenAI key."
    },
    "enable": {
      "label": "Enable AI Features",
      "description": "Smart filing suggestions and note connections",
      "enabled": "AI features enabled",
      "disabled": "AI features disabled",
      "error": "Failed to update setting"
    },
    "groups": { "voice": "Voice Transcription", "embeddingModel": "Local Embedding Model", "embeddingIndex": "Embedding Index", "inline": "Inline AI Editing" },
    "voice": {
      "provider": "Provider",
      "providerDescription": "Speech-to-text provider for voice memos",
      "providers": { "local": "Local (default)", "openai": "OpenAI (BYOK)" },
      "localModel": "Local Model",
      "localModelDescription": "Whisper Small downloads on demand and stays cached locally",
      "status": { "ready": "Ready", "downloading": "Downloading", "downloaded": "Downloaded", "notDownloaded": "Not downloaded" },
      "cacheHint": "Not bundled with the app · Downloaded from Settings · Cached on this device",
      "preparing": "Preparing Whisper Small...",
      "download": "Download Whisper Small",
      "apiKey": "OpenAI API Key",
      "apiKeyDescription": "Stored in your OS keychain and used only for voice transcription",
      "replaceKey": "Replace saved OpenAI key",
      "enterKey": "Enter OpenAI API key",
      "saveKey": "Save Key",
      "keySaved": "API key saved in keychain",
      "providerError": "Failed to update voice provider",
      "downloadedToast": "Whisper Small downloaded",
      "downloadError": "Failed to download Whisper Small",
      "keySavedToast": "OpenAI key saved",
      "keySaveError": "Failed to save OpenAI key"
    },
    "embedding": {
      "loaded": "Loaded",
      "loading": "Loading",
      "cacheHint": "~23MB · Cached locally · All on-device",
      "dimensions": "Dimensions",
      "embeddings": "Embeddings",
      "downloadLoad": "Download & Load Model",
      "downloadingModel": "Downloading model...",
      "loadingModel": "Loading model...",
      "loadSuccess": "Model loaded successfully",
      "loadFailed": "Failed to load model",
      "rebuildIndex": "Rebuild Index",
      "rebuildDescription": "Regenerate embeddings for all notes",
      "rebuild": "Rebuild",
      "scanning": "Scanning notes...",
      "generating": "Generating embeddings...",
      "complete": "Complete!",
      "reindexed": "Embeddings reindexed: {computed} computed, {skipped} skipped",
      "reindexFailed": "Failed to reindex embeddings"
    },
    "inline": {
      "title": "Inline AI Editing",
      "enable": "Enable Inline AI",
      "enableDescription": "Show AI menu when editing notes",
      "enabled": "Inline AI editing enabled",
      "disabled": "Inline AI editing disabled",
      "provider": "Provider",
      "providerDescription": "AI service for text operations",
      "model": "Model",
      "modelDescription": "Language model for rewrite and summarize",
      "selectModel": "Select a model",
      "apiKey": "API Key",
      "apiKeyDescription": "Stored locally, sent only to the provider",
      "apiKeyPlaceholder": "Enter {provider} API key",
      "ollamaUrl": "Ollama URL",
      "ollamaUrlDescription": "Local server address",
      "connection": "Connection",
      "activePort": "Active on port {port}",
      "notConnected": "Not connected",
      "test": "Test",
      "stopFailed": "Failed to stop existing server",
      "connected": "Connected! Server running on port {port}",
      "connectFailed": "Failed to connect",
      "testFailed": "Connection test failed",
      "updateFailed": "Failed to update setting"
    }
  },
  "integrations": {
    "header": { "title": "Integrations", "subtitle": "Connect external services to enrich your workflow" },
    "auth": { "oauth2": "OAuth 2.0", "apiKey": "API Key", "none": "System" },
    "comingSoon": "Coming Soon",
    "connect": "Connect",
    "googleCalendar": {
      "name": "Google Calendar",
      "description": "Two-way sync for Memry events and imported Google calendars.",
      "statuses": { "connected": "Connected", "notConnected": "Not Connected", "reconnectRequired": "Reconnect Required" },
      "accountReconnect": "Reconnect Google",
      "importedCalendars": "Imported Calendars",
      "selected": "{count} selected",
      "syncNow": "Sync Now",
      "disconnect": "Disconnect",
      "reconnect": "Reconnect Google",
      "syncFailed": "Something went wrong"
    },
    "sourcePicker": {
      "empty": "No imported Google calendars are available on this device yet.",
      "statuses": { "synced": "Synced", "error": "Error", "pending": "Pending", "idle": "Idle" },
      "retrying": "Retrying…",
      "retryNow": "Retry now"
    },
    "registry": {
      "appleCalendar": { "name": "Apple Calendar", "description": "Local calendar integration via system APIs" },
      "notion": { "name": "Notion", "description": "One-time page import into your vault" },
      "readwise": { "name": "Readwise", "description": "Sync highlights into your vault" },
      "todoist": { "name": "Todoist", "description": "Two-way task sync" }
    }
  },
  "vault": {
    "header": { "title": "Vault", "subtitle": "Vault configuration and storage" },
    "groups": { "storageUsage": "Storage Usage", "location": "Location" },
    "loadingStorage": "Loading storage info...",
    "signInStorage": "Sign in to view storage usage",
    "vaultPath": "Vault Path",
    "reveal": "Reveal"
  },
  "tags": {
    "header": { "title": "Tags", "subtitle": "Manage tags across notes, journals, and tasks" },
    "loading": "Loading tags...",
    "empty": "No tags yet. Tags will appear here as you add them to notes and tasks.",
    "filterPlaceholder": "Filter tags...",
    "noMatch": "No tags matching “{query}”",
    "summary": "{count, plural, one {# tag} other {# tags}} across notes and tasks",
    "actions": { "rename": "Rename", "changeColor": "Change color", "mergeInto": "Merge into...", "delete": "Delete" },
    "dialogs": {
      "deleteTitle": "Delete tag",
      "deleteDescription": "Remove “{name}” from {count, plural, one {# item} other {# items}}? This cannot be undone.",
      "mergeTitle": "Merge tag",
      "mergeDescription": "All items tagged with “{source}” will be re-tagged with the target tag. The source tag will be deleted.",
      "targetPlaceholder": "Select target tag...",
      "colorTitle": "Change color for “{name}”"
    },
    "toasts": {
      "renamed": "Renamed \"{oldName}\" to \"{newName}\"",
      "renameFailed": "Failed to rename tag",
      "deleteFailed": "Failed to delete tag",
      "deleted": "Deleted \"{name}\" from {count, plural, one {# item} other {# items}}",
      "mergeFailed": "Failed to merge tags",
      "merged": "Merged \"{source}\" into \"{target}\" ({count, plural, one {# item} other {# items}})",
      "colorUpdated": "Updated color for \"{name}\"",
      "colorFailed": "Failed to update color"
    }
  },
  "properties": {
    "header": { "title": "Properties", "subtitle": "Manage property definitions across all notes" },
    "loading": "Loading properties...",
    "empty": "No property definitions yet. Add a Status, Select, or Multiselect property to any note to get started.",
    "filterPlaceholder": "Filter properties...",
    "noMatch": "No properties matching “{query}”",
    "summary": "{count, plural, one {# property definition} other {# property definitions}}",
    "optionCount": "{count, plural, one {# option} other {# options}}",
    "optionNamePlaceholder": "Option name",
    "addOption": "Add option",
    "changeColorTitle": "Change color",
    "renameTitle": "Rename",
    "removeTitle": "Remove",
    "actions": { "deleteProperty": "Delete property" },
    "types": { "status": "Status", "select": "Select", "multiselect": "Multiselect", "text": "Text", "number": "Number", "date": "Date", "checkbox": "Checkbox", "url": "URL" },
    "dialogs": {
      "deleteTitle": "Delete property",
      "deleteDescription": "Remove the “{name}” property definition? Notes using this property will keep their values as plain text.",
      "colorTitle": "Change color for “{name}”"
    },
    "toasts": {
      "renamed": "Renamed \"{oldValue}\" to \"{newValue}\"",
      "renameFailed": "Failed to rename option",
      "removed": "Removed \"{value}\"",
      "removeFailed": "Failed to remove option",
      "colorFailed": "Failed to update color",
      "deleteFailed": "Failed to delete property",
      "deleted": "Deleted property \"{name}\"",
      "addFailed": "Failed to add option"
    }
  },
  "shortcuts": {
    "header": { "title": "Keyboard Shortcuts", "subtitle": "Click any shortcut to rebind it" },
    "searchPlaceholder": "Search shortcuts...",
    "resetAll": "Reset All",
    "custom": "Custom",
    "pressShortcut": "Press shortcut…",
    "cancelTitle": "Cancel",
    "rebindTitle": "Click to rebind",
    "resetTitle": "Reset to default",
    "clearTitle": "Clear shortcut",
    "clickToSet": "Click to set",
    "noMatch": "No shortcuts match your search",
    "conflict": "Conflicts with: {labels}",
    "globalCapture": {
      "title": "Global Capture",
      "description": "Capture a note from anywhere",
      "permissionNeeded": "Permission needed",
      "active": "Active",
      "permissionHint": "Global shortcuts require Accessibility permission. Go to System Settings → Privacy → Accessibility and enable memry."
    },
    "toasts": {
      "saveGlobalFailed": "Failed to save global capture shortcut",
      "saveFailed": "Failed to save shortcut",
      "resetFailed": "Failed to reset shortcut",
      "resetAllSuccess": "All shortcuts reset to defaults",
      "resetAllFailed": "Failed to reset shortcuts"
    },
    "categories": { "navigation": "Navigation", "tabs": "Tabs", "editor": "Editor", "view": "View" },
    "entries": {
      "nav.newNote": { "label": "New Note", "description": "Create a new note" },
      "nav.newTask": { "label": "New Task", "description": "Create a new task" },
      "nav.inbox": { "label": "Go to Inbox", "description": "Navigate to the inbox" },
      "nav.notes": { "label": "Go to Notes", "description": "Navigate to notes" },
      "nav.tasks": { "label": "Go to Tasks", "description": "Navigate to tasks" },
      "nav.search": { "label": "Search", "description": "Open global search" },
      "nav.settings": { "label": "Open Settings", "description": "Open the settings panel" },
      "tabs.close": { "label": "Close Tab", "description": "Close the current tab" },
      "tabs.next": { "label": "Next Tab", "description": "Switch to the next tab" },
      "tabs.previous": { "label": "Previous Tab", "description": "Switch to the previous tab" },
      "tabs.reopen": { "label": "Reopen Last Tab", "description": "Reopen the most recently closed tab" },
      "editor.save": { "label": "Save", "description": "Save the current note" },
      "editor.bold": { "label": "Bold", "description": "Toggle bold formatting" },
      "editor.italic": { "label": "Italic", "description": "Toggle italic formatting" },
      "editor.underline": { "label": "Underline", "description": "Toggle underline formatting" },
      "view.toggleSidebar": { "label": "Toggle Sidebar", "description": "Show or hide the sidebar" },
      "view.shortcuts": { "label": "Keyboard Shortcuts Help", "description": "Show keyboard shortcuts reference" }
    }
  }
}
```

If implementation finds additional literal strings in settings-owned files, add them under the nearest section above.

---

## Task 1: Replace Settings Locale Files

**Files:**
- Modify: `packages/i18n/src/locales/en/settings.json`
- Modify: `packages/i18n/src/locales/tr/settings.json`
- Modify: `packages/i18n/src/locales/ar/settings.json`

- [ ] **Step 1: Write the English settings namespace**

Replace `packages/i18n/src/locales/en/settings.json` with the key shape above, preserving valid JSON and using ICU syntax for counts.

- [ ] **Step 2: Reset Turkish and Arabic to fallback stubs**

Replace both files with literal empty objects:

```json
{}
```

Expected: this removes Phase A/B seed translations from `tr/settings.json` and `ar/settings.json` intentionally. Missing keys fall back to English.

- [ ] **Step 3: Validate JSON**

Run:

```bash
node -e "for (const f of ['packages/i18n/src/locales/en/settings.json','packages/i18n/src/locales/tr/settings.json','packages/i18n/src/locales/ar/settings.json']) JSON.parse(require('fs').readFileSync(f, 'utf8')); console.log('OK')"
```

Expected:

```text
OK
```

- [ ] **Step 4: Verify i18n package types**

Run:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: exits 0. If bad key shape breaks `CustomTypeOptions`, fix the JSON before editing components.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/locales/en/settings.json packages/i18n/src/locales/tr/settings.json packages/i18n/src/locales/ar/settings.json
git commit -m "feat(i18n): populate settings namespace"
```

---

## Task 2: Migrate Settings Shell and Shared Primitives

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/settings-modal.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/settings-primitives.tsx`
- Create: `apps/desktop/src/renderer/src/pages/settings/settings-page.i18n.test.tsx`

- [ ] **Step 1: Add a failing test for shell labels**

Create `settings-page.i18n.test.tsx`. Render `SettingsPage` inside `SettingsModalProvider` and `I18nextProvider` from `createRendererI18n({ locale: 'en' })`. Assert the visible shell text includes `Settings`, nav group labels, and all 14 nav items.

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/pages/settings/settings-page.i18n.test.tsx
```

Expected before implementation: fails because the test file does not compile or the component still hardcodes strings without provider wiring.

- [ ] **Step 2: Migrate the shell**

In `settings-modal.tsx`, add `useT('settings')` and change the sr-only dialog title to `t('page.title')`.

In `settings.tsx`:
- Add `useT('settings')`.
- Replace sidebar title with `t('page.title')`.
- Replace group labels with `t('page.nav.groups.*')`.
- Replace item labels with `t('page.nav.items.*')`.
- Keep icons and section ids unchanged.
- When touching classes in this file, convert newly touched physical Tailwind classes to logical equivalents: `border-r` → `border-e`, `px` can stay symmetric, `pl-2` → `ps-2`, `left-0` → `start-0`, `rounded-r-sm` → `rounded-e-sm`.

- [ ] **Step 3: Keep primitives props as strings**

Do not make `SettingsHeader`, `SettingsGroup`, or `SettingRow` call `useT`. They are dumb primitives and should receive translated strings from callers. If editing `settings-primitives.tsx`, only convert physical classes touched by this migration (`ml-4` → `ms-4`) and avoid behavior changes.

- [ ] **Step 4: Run focused test**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/pages/settings/settings-page.i18n.test.tsx
```

Expected: test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings-modal.tsx apps/desktop/src/renderer/src/pages/settings.tsx apps/desktop/src/renderer/src/components/settings/settings-primitives.tsx apps/desktop/src/renderer/src/pages/settings/settings-page.i18n.test.tsx
git commit -m "feat(i18n): migrate settings shell strings"
```

---

## Task 3: Migrate General and Appearance Panels

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/appearance-section.tsx`
- Create: `apps/desktop/src/renderer/src/pages/settings/general-section.i18n.test.tsx`

- [ ] **Step 1: Add a failing General test**

Create `general-section.i18n.test.tsx`. Render `GeneralSettings` with an English i18n instance and mocked `window.api.settings`, `window.api.locale`, updater hooks, and tab settings. Assert:
- `Language & Region`, `Language`, helper text, and `Time Format` render from settings keys.
- 12-hour/24-hour options render from settings keys.
- Failed locale change uses `general.language.failed`.

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/pages/settings/general-section.i18n.test.tsx
```

Expected before implementation: fails on hardcoded labels or missing mocks.

- [ ] **Step 2: Migrate General**

Use `const { t, i18n } = useT('settings')` already present. Replace all remaining literals:
- Header loading/loaded subtitles.
- Group labels.
- Startup, Updates, Language, Clock Format, Tab Behavior, File Creation labels/descriptions/options.
- Toast fallback strings.
- `getUpdateActionLabel` and `getUpdateDescription`: pass `t` into helpers or make them local computed values inside the component.
- Keep `LOCALE_DISPLAY_NAMES` for language option names.

Use `t('general.updates.downloadingPercent', { percent })`, `t('general.updates.installedVersion', { version })`, etc.

- [ ] **Step 3: Migrate Appearance**

Add `useT('settings')`. Replace:
- Header loading/loaded strings.
- Group labels.
- Theme option labels and aria labels.
- Accent preset titles.
- Custom color placeholder.
- Font size/family labels and option labels.
- Toast fallback strings.

Keep font family values and hex colors unchanged.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/pages/settings/general-section.i18n.test.tsx
```

Expected: passes.

- [ ] **Step 5: Run typecheck for touched renderer code**

Run:

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: exits 0. If unrelated pre-existing type errors appear, document exact files and continue only after confirming they are unrelated.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/general-section.tsx apps/desktop/src/renderer/src/pages/settings/appearance-section.tsx apps/desktop/src/renderer/src/pages/settings/general-section.i18n.test.tsx
git commit -m "feat(i18n): migrate general and appearance settings"
```

---

## Task 4: Migrate Editor, Templates, Journal, Tasks, and Calendar Panels

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/settings/editor-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/templates-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/journal-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/tasks-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/calendar-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/tasks-section.test.tsx`

- [ ] **Step 1: Update Tasks test to run under i18n**

Wrap `TasksSettings` tests with `I18nextProvider` and `createRendererI18n({ locale: 'en' })`, or with the app `I18nProvider` if local test helper already supports it.

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/pages/settings/tasks-section.test.tsx
```

Expected before component migration: existing test still passes if labels remain English. After this step, the test harness is ready for `useT('settings')`.

- [ ] **Step 2: Migrate Editor**

Add `useT('settings')`. Replace header, group labels, row labels/descriptions, select options, slider seconds suffix, and toast fallback strings with `editor.*` keys.

- [ ] **Step 3: Migrate Templates**

Add `useT('settings')` and `useT('common')` where useful. Replace:
- Header, New Template action, loading state, group labels, empty state.
- Template duplicate suffix with `t('templates.copySuffix', { name: template.name })`.
- Toasts.
- Delete/Duplicate dialogs, placeholders, dropdown items.

Use common for Cancel/Delete only if Phase B supplied those keys. Otherwise use `settings.templates.actions.delete`.

- [ ] **Step 4: Migrate Journal**

Add `useT('settings')`. Replace:
- Header/loading subtitles.
- Default Template group and select placeholders/options.
- Sidebar Visibility and Footer labels/descriptions.
- Toasts.

Keep actual template names/icons untranslated.

- [ ] **Step 5: Migrate Tasks**

Add `useT('settings')`. Replace:
- `SORT_OPTIONS` labels with keys or map values to `t('tasks.sortOrder.options.*')`.
- Header/loading, groups, row labels/descriptions, placeholders, Sunday/Monday labels/aria labels, `days` unit, toast fallback strings.

Keep project names untranslated.

- [ ] **Step 6: Migrate Calendar**

Add `useT('settings')`. Replace:
- Header/loading, group labels, row labels/descriptions.
- Global and override select option labels.
- Toast fallback strings.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/pages/settings/tasks-section.test.tsx
```

Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/editor-section.tsx apps/desktop/src/renderer/src/pages/settings/templates-section.tsx apps/desktop/src/renderer/src/pages/settings/journal-section.tsx apps/desktop/src/renderer/src/pages/settings/tasks-section.tsx apps/desktop/src/renderer/src/pages/settings/calendar-section.tsx apps/desktop/src/renderer/src/pages/settings/tasks-section.test.tsx
git commit -m "feat(i18n): migrate workspace settings panels"
```

---

## Task 5: Migrate Account, Sync Setup, Devices, Recovery, and Key Rotation

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/settings/account-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/setup-wizard.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/email-entry-form.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/otp-input.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/otp-verification.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/oauth-buttons.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/recovery-phrase-display.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/recovery-phrase-confirm.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/recovery-phrase-input.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/linking-code-entry.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/linking-pending.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/qr-linking.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/linking-approval-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/device-list.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/key-rotation-wizard.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/hooks/use-sync-status.ts`

- [ ] **Step 1: Migrate `use-sync-status` carefully**

This hook is used outside Settings. Either:
- Return stable status ids plus translated display fields only after adding `useT('settings')` in the hook, or
- Leave hook labels as-is and translate account-section-only surrounding text.

Recommended minimal path: add `useT('settings')` in `useSyncStatus`, replace the hook's own user-visible labels with `settings.account.sync.statuses.*`, and verify `components/sync/sync-status.tsx` still works. This is acceptable because sync status is settings/account-adjacent and already user-facing.

- [ ] **Step 2: Migrate Account section**

Use `useT('settings')`, plus `useT('common')` for loading/cancel where already supplied. Replace:
- Account header/loading.
- Identity/Sync/Storage/Devices/Security group labels.
- Pro plan, Unknown, Last synced, pending count.
- Storage usage labels.
- Recovery Key, Rotate Encryption Keys, Sign Out rows/actions.
- Sign-out dialog title/description/actions.
- Toast fallback strings.

Keep email, storage bytes, device names, and runtime sync labels dynamic.

- [ ] **Step 3: Migrate Setup Wizard and sync setup child components**

Add `useT('settings')` to each setup-owned component. Replace:
- Wizard step labels and `aria-label`.
- Sign-in title/description/or.
- Email labels/placeholders/validation message/loading.
- OAuth button.
- OTP headings, resend/counter/verifying strings.
- Recovery phrase display/confirm/input strings and aria labels.
- Linking choice/code/pending strings.

Do not translate recovery phrase words or linking JSON contents.

- [ ] **Step 4: Migrate QR/linking approval/device/key rotation dialogs**

Replace all visible copy, aria labels, dialog text, toasts, and button labels in:
- `qr-linking.tsx`
- `linking-approval-dialog.tsx`
- `device-list.tsx`
- `key-rotation-wizard.tsx`

Use ICU for counts and interpolation for device names.

- [ ] **Step 5: Migrate RecoveryKeyDialog**

Switch from `useT('common')` only to `useT('settings')` plus common where needed. Replace title, description, fallback errors, toasts, reveal/copy/hide labels, and session hint.

- [ ] **Step 6: Run focused renderer tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/contexts/sync-context.test.tsx src/services/device-service.test.ts
```

Expected: passes. If no settings component test covers setup components, add one smoke test before committing.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/account-section.tsx apps/desktop/src/renderer/src/pages/settings/setup-wizard.tsx apps/desktop/src/renderer/src/components/sync apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx apps/desktop/src/renderer/src/hooks/use-sync-status.ts
git commit -m "feat(i18n): migrate account and sync settings"
```

---

## Task 6: Migrate AI, Integrations, Vault, Tags, Properties, and Shortcuts

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/settings/ai-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/integrations-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/vault-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/tags-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/properties-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/shortcuts-section.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/integration-list.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/google-calendar-source-picker.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/storage-usage-bar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/tag-manager.tsx`
- Modify: `apps/desktop/src/renderer/src/lib/integration-registry.ts`
- Create: `apps/desktop/src/renderer/src/pages/settings/shortcut-registry-i18n.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.test.tsx`

- [ ] **Step 1: Migrate AI Assistant**

Add `useT('settings')` to `ai-section.tsx` and `ai-inline-section.tsx`. Replace all labels, group names, status badges, placeholders, progress labels, model action strings, connection statuses, and toast fallback strings.

Keep provider names, model names, ports, counts, API key values, and model error payloads dynamic.

- [ ] **Step 2: Migrate Integrations**

In `integration-list.tsx`, add `useT('settings')` and replace:
- Auth labels.
- Coming Soon and Connect.
- Generic integration names/descriptions from `integration-registry`.

Recommended minimal registry change:
- Change `IntegrationDefinition` to store `nameKey` and `descriptionKey` for generic integrations, while preserving `id`, `icon`, `authFlow`, `comingSoon`.
- Translate in `IntegrationList`, not inside the registry.
- Keep Google Calendar row custom because it has richer state.

- [ ] **Step 3: Migrate Google Calendar settings row**

In `google-calendar-integration-row.tsx` and `google-calendar-source-picker.tsx`, replace:
- Google Calendar description.
- OAuth/status badges.
- Account status detail labels.
- Imported Calendars and selected count.
- Sync Now, Disconnect, Connect, Reconnect.
- Picker empty/status/retry labels.
- Mutation error fallbacks.

Do not migrate `GoogleCalendarOnboardingDialog` in this phase unless the implementer decides it is settings-owned by import path. If migrated, use `settings.integrations.googleCalendar.onboarding.*` keys and update its existing test.

- [ ] **Step 4: Migrate Vault and StorageUsageBar**

Replace Vault header/group/empty/loading/location strings and storage category labels. If `storage-usage-bar.tsx` is still used only under Settings, migrate it to `settings.vault`/`settings.account.storage`. If it is used elsewhere, keep labels generic but still source from `settings` only if settings-owned by import path.

- [ ] **Step 5: Migrate Tags and Properties**

Add `useT('settings')` in `tags-section.tsx`, `tag-manager.tsx`, and `properties-section.tsx`. Replace:
- Headers.
- Loading/empty/no-match/search placeholders.
- Dropdown action labels and title attributes.
- Dialog titles/descriptions/actions.
- Toast success/failure strings.
- Count summaries with ICU.
- Property type labels shown in Settings.

Keep tag names, property names, option values, and colors dynamic/untranslated.

- [ ] **Step 6: Migrate Shortcuts**

Add `useT('settings')` in `shortcuts-section.tsx`.

Do not mutate `SHORTCUT_REGISTRY` behavior for command execution. For display:
- Map registry ids to `shortcuts.entries.<id>.label/description`.
- Map category names to `shortcuts.categories.*`.
- Search should match translated label/description.
- Conflict labels should use translated labels.
- Keep `formatBinding` unchanged.

Create `shortcut-registry-i18n.test.tsx` to assert every `SHORTCUT_REGISTRY` id has a matching `settings.shortcuts.entries.<id>.label` and `.description` key, and every `CATEGORY_ORDER` category has a matching `settings.shortcuts.categories.*` key.

- [ ] **Step 7: Update Google Calendar tests**

Update `google-calendar-integration-row.test.tsx` to wrap with i18n provider and assert English strings still render:
- Google Calendar
- OAuth 2.0
- Connected / Not Connected / Reconnect Required
- Imported Calendars
- Retry now / Retrying…

- [ ] **Step 8: Run focused tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/components/settings/google-calendar-integration-row.test.tsx src/pages/settings/shortcut-registry-i18n.test.tsx
```

Expected: passes.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/ai-section.tsx apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx apps/desktop/src/renderer/src/pages/settings/integrations-section.tsx apps/desktop/src/renderer/src/pages/settings/vault-section.tsx apps/desktop/src/renderer/src/pages/settings/tags-section.tsx apps/desktop/src/renderer/src/pages/settings/properties-section.tsx apps/desktop/src/renderer/src/pages/settings/shortcuts-section.tsx apps/desktop/src/renderer/src/components/settings/integration-list.tsx apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.tsx apps/desktop/src/renderer/src/components/settings/google-calendar-source-picker.tsx apps/desktop/src/renderer/src/components/settings/storage-usage-bar.tsx apps/desktop/src/renderer/src/components/settings/tag-manager.tsx apps/desktop/src/renderer/src/lib/integration-registry.ts apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.test.tsx apps/desktop/src/renderer/src/pages/settings/shortcut-registry-i18n.test.tsx
git commit -m "feat(i18n): migrate service and data settings panels"
```

---

## Task 7: Static Sweep for Settings-Owned Literals

**Files:**
- Inspect only settings-owned files listed in Work Scope.
- Modify only settings-owned files with missed user-visible strings.

- [ ] **Step 1: Search for remaining quoted UI strings**

Run:

```bash
rg -n "\"[A-Z][^\"]{2,}\"|'[A-Z][^']{2,}'|>[A-Z][^<]+<" apps/desktop/src/renderer/src/pages/settings apps/desktop/src/renderer/src/components/settings apps/desktop/src/renderer/src/components/sync -g '*.{ts,tsx}'
```

Expected: remaining hits are either:
- Translation keys.
- Type literals / ids / provider names.
- User-content placeholders intentionally dynamic.
- Runtime error payloads out of Phase C scope.

For every real UI literal, add an English key to `settings.json` and replace it with `t(...)`.

- [ ] **Step 2: Search for settings namespace misuse**

Run:

```bash
rg -n "useT\\('common'\\)|tCommon\\(" apps/desktop/src/renderer/src/pages/settings apps/desktop/src/renderer/src/components/settings apps/desktop/src/renderer/src/components/sync -g '*.{ts,tsx}'
```

Expected: common usage is limited to Phase B universal verbs/states. If a settings-specific phrase uses common, move it to `settings.json`.

- [ ] **Step 3: Confirm TR/AR stubs**

Run:

```bash
node -e "const fs=require('fs'); for (const f of ['packages/i18n/src/locales/tr/settings.json','packages/i18n/src/locales/ar/settings.json']) { const raw=fs.readFileSync(f,'utf8').trim(); if (raw !== '{}') throw new Error(`${f} must be {}`); } console.log('OK')"
```

Expected:

```text
OK
```

- [ ] **Step 4: Commit missed-string cleanup**

```bash
git add packages/i18n/src/locales/en/settings.json apps/desktop/src/renderer/src/pages/settings apps/desktop/src/renderer/src/components/settings apps/desktop/src/renderer/src/components/sync
git commit -m "chore(i18n): clean up remaining settings literals"
```

If no changes, skip commit.

---

## Task 8: Final Verification

**Files:**
- All modified files from previous tasks.

- [ ] **Step 1: Run i18n package checks**

Run:

```bash
pnpm --filter @memry/i18n typecheck
pnpm --filter @memry/i18n test
```

Expected: both pass.

- [ ] **Step 2: Run focused renderer tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/pages/settings src/components/settings
```

Expected: all settings tests pass. If this glob is not accepted by Vitest in this repo, run the exact files created/modified:

```bash
pnpm --filter @memry/desktop test:renderer -- src/pages/settings/settings-page.i18n.test.tsx src/pages/settings/general-section.i18n.test.tsx src/pages/settings/tasks-section.test.tsx src/pages/settings/shortcut-registry-i18n.test.tsx src/components/settings/google-calendar-integration-row.test.tsx
```

- [ ] **Step 3: Run desktop typecheck**

Run:

```bash
pnpm --filter @memry/desktop typecheck
```

Expected: exits 0, except for documented pre-existing test-file type errors if they still exist on this branch. If failures are from migrated files, fix before continuing.

- [ ] **Step 4: Run full required gate**

Run:

```bash
pnpm lint && pnpm typecheck && pnpm ipc:check && pnpm test
```

Expected: exits 0. `pnpm i18n:check` is Phase E and must not be added or required here.

- [ ] **Step 5: Manual smoke**

Run:

```bash
pnpm dev
```

Expected manual checks:
- Open Settings.
- Visit Account, General, Templates, Editor, Journal, Tasks, Calendar, Appearance, Shortcuts, AI Assistant, Integrations, Vault, Tags, Properties.
- No visible raw translation keys such as `general.language.label`.
- Switch language to Türkçe and Arabic; settings UI remains readable through English fallback except Phase B common strings that already translate.
- Arabic switch sets `<html dir="rtl">`; no newly touched settings layout has obvious broken alignment.
- Language picker still works and persists through existing locale IPC.

- [ ] **Step 6: Final commit if verification-only fixes were needed**

```bash
git add <only-files-fixed-during-verification>
git commit -m "fix(i18n): stabilize settings namespace migration"
```

Skip if no changes.

---

## Acceptance Criteria

- `packages/i18n/src/locales/en/settings.json` contains all Settings UI strings migrated in this phase.
- `packages/i18n/src/locales/tr/settings.json` is exactly `{}`.
- `packages/i18n/src/locales/ar/settings.json` is exactly `{}`.
- Every settings panel/tab/string is migrated, including Account setup, Sync devices, Recovery Key, Key Rotation, AI, Integrations, Vault, Tags, Properties, Shortcuts, and Google Calendar settings rows.
- `useT('settings')` is used for settings-specific copy.
- `common` is used only for Phase B universal verbs/states already supplied there.
- Dynamic user data, provider/model names, device names, tags, property names, template names, project names, and service error payloads are not translated.
- No Phase D `errors.json`/menu work and no Phase E lint/codemod work is included.
- Focused tests pass and the full repo gate is attempted with exact results recorded in the implementation closeout.
