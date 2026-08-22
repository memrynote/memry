# Custom NSIS include, picked up automatically from directories.buildResources.
#
# Why this exists — stock electron-builder makes a Windows update all-or-nothing.
# templates/nsis/uninstaller.nsh runs two different removal paths:
#
#   ${if} ${isUpdated}                 # update: every file in $INSTDIR is
#     un.atomicRMDir                   # Rename'd into $PLUGINSDIR\old-install,
#     ${if} $R0 != 0                   # and ONE unrenameable file (AV holding a
#       un.restoreFiles                # handle, a stray process, an ACL) rolls
#       Abort                          # the whole thing back and aborts.
#   ${endif}
#   RMDir /r $INSTDIR                  # plain uninstall: best-effort, tolerant
#
# The Abort exits the uninstaller with code 2, and include/installUtil.nsh's
# handleUninstallResult turns that into "Failed to uninstall old application
# files. Please try running the installer again.: 2" and quits the installer.
# Nothing is installed. Since the installer always passes --updated when it
# removes the old version, BOTH the in-app updater and manually running the new
# setup.exe over an existing install take the strict path and fail — while
# uninstalling from Control Panel first takes the tolerant RMDir path and works.
# That is exactly the "the only way I can update is to uninstall and reinstall"
# report from Windows users.
#
# customRemoveFiles replaces that whole block (see the !ifmacrodef in
# uninstaller.nsh), so this macro owns both paths. It keeps the atomic rename as
# the happy path — it is the safest way to remove files, and on success nothing
# changes — but a busy file now falls back to the same tolerant sweep a manual
# uninstall would have done instead of making the update impossible.
#
# The last obstacle is the app binary itself. It cannot be DELETED while a
# process still has it mapped — but Windows will happily RENAME it, because the
# loader opens an image with FILE_SHARE_DELETE. That asymmetry is the whole
# reason electron-builder's happy path is rename-based, and it is the escape
# hatch here too: move the live binary aside and the installer has a clean
# $INSTDIR to extract into, with the running process still pointing at the
# renamed inode until it exits.
#
# Aborting instead — as this macro used to, and as stock still does — is what
# strands a user forever: the failure is not transient, so every future update
# hits the same wall and the only way out is uninstall-then-reinstall. Renaming
# is strictly better; we abort only if even the rename fails, which is the same
# outcome as before, so this can never be worse than what it replaces.
# Why customInstall exists — the Start menu entry must survive every path.
#
# electron-builder's keep-shortcuts handshake preserves shortcuts (and thus
# Start/taskbar pins) across silent auto-updates, but it has two holes that
# real Windows users fell into:
#
#   1. templates/nsis/include/installer.nsh's addStartMenuLink, on the
#      keepShortcuts=true path, only RENAMES an existing link — a MISSING
#      Start menu link is never recreated ("the user deleted it" is assumed).
#      Any one-time loss becomes permanent: every later update keeps the
#      shortcut missing, the app vanishes from Start search, and pinning
#      looks broken to the user.
#   2. include/installUtil.nsh's setIsTryToKeepShortcuts disables the keep
#      mechanism entirely when allowToChangeInstallationDirectory is defined
#      and the run is not an auto-update (--updated). Manually running a
#      downloaded setup.exe over an existing install — the exact workaround
#      users learned while in-place updates were broken (see
#      customRemoveFiles below) — therefore wipes shortcuts and unregisters
#      the AppUserModelID, killing Start menu and taskbar pins.
#
# Both holes end in the same state: no "$SMPROGRAMS\MemryNote.lnk". This
# macro runs at the end of every install (fresh, auto-update, manual rerun)
# and recreates the Start menu link only when it is missing, with the AUMID
# stamped so Windows groups/pins it as com.memrynote.memry. When the link
# exists it is left untouched, so a live pin is never disturbed. The pin
# itself cannot be restored programmatically (Windows offers no API), but
# with the link and AUMID back the user can re-pin — and with in-place
# updates fixed, the keep path preserves that pin from then on.
!macro customInstall
  ${ifNot} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    # refresh the shell so Start search picks the entry up immediately
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${endIf}
!macroend

!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy: $R0"
      DetailPrint "Atomic removal failed; falling back to in-place removal."

      # Move back whatever was already relocated, so the sweep below deletes
      # from one place instead of leaving half the old install in $PLUGINSDIR.
      Push ""
      Call un.restoreFiles
      Pop $R9
    ${endif}
  ${endif}

  # Move out of $INSTDIR so it can be removed. Tolerant by design: RMDir /r
  # deletes what it can and skips what it cannot, leaving only genuinely locked
  # files behind for the installer to overwrite.
  SetOutPath $TEMP
  RMDir /r $INSTDIR

  # Do NOT schedule the sweep's leftovers with /REBOOTOK: the installer is about
  # to extract the new version into this very directory, and a pending
  # reboot-time delete would take the fresh install with it. The single file
  # below is the exception, and only because its name is one the installer never
  # writes.
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "$INSTDIR\${APP_EXECUTABLE_FILENAME} is still in use; renaming it aside."

    # A leftover from an earlier pass that was never rebooted away. Rename fails
    # if the destination exists, so clear it first — best-effort, because if it
    # is still mapped the rename below fails and we abort exactly as before.
    Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}.old-update"

    ClearErrors
    Rename "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}.old-update"

    ${if} ${errors}
      DetailPrint "Could not rename $INSTDIR\${APP_EXECUTABLE_FILENAME}; aborting."
      Abort `Can't remove "$INSTDIR\${APP_EXECUTABLE_FILENAME}".`
    ${else}
      # Safe to schedule: nothing the installer extracts is ever called
      # "<app>.exe.old-update", so this pending delete cannot reach the new
      # install. SetRebootFlag false because the user has nothing to do — the
      # update is complete either way and the leftover goes at the next reboot
      # (or is deleted by the block above on the next update, whichever is
      # first). Prompting to restart Windows over a stale file would be noise.
      Delete /REBOOTOK "$INSTDIR\${APP_EXECUTABLE_FILENAME}.old-update"
      SetRebootFlag false
      DetailPrint "Renamed the in-use binary aside; continuing with the update."
    ${endif}
  ${endif}
!macroend
