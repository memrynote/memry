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
# The one case still worth aborting for is the app binary itself: if that cannot
# be removed the app is genuinely still running, and letting the installer
# extract over a live executable trades a clean failure (old version intact) for
# a half-written install. That abort keeps stock behaviour for the case where
# stock behaviour is right.
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

  # Do NOT schedule leftovers with /REBOOTOK here: the installer is about to
  # extract the new version into this very directory, and a pending reboot-time
  # delete would take the fresh install with it.
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "$INSTDIR\${APP_EXECUTABLE_FILENAME} is still in use."
    Abort `Can't remove "$INSTDIR\${APP_EXECUTABLE_FILENAME}".`
  ${endif}
!macroend
