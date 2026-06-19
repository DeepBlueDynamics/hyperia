!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Hyperia" "" "Open &Hyperia here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Hyperia" "Icon" `"$appExe"`
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Hyperia\command" "" `"$appExe" "%V"`

  WriteRegStr HKCU "Software\Classes\Directory\shell\Hyperia" "" "Open &Hyperia here"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Hyperia" "Icon" `"$appExe"`
  WriteRegStr HKCU "Software\Classes\Directory\shell\Hyperia\command" "" `"$appExe" "%V"`

  WriteRegStr HKCU "Software\Classes\Drive\shell\Hyperia" "" "Open &Hyperia here"
  WriteRegStr HKCU "Software\Classes\Drive\shell\Hyperia" "Icon" `"$appExe"`
  WriteRegStr HKCU "Software\Classes\Drive\shell\Hyperia\command" "" `"$appExe" "%V"`
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Hyperia"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Hyperia"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\Hyperia"
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInit
  ; Clean up old Hyper Squirrel installs if upgrading
  IfFileExists $LOCALAPPDATA\Hyper\Update.exe 0 +2
  nsExec::Exec '"$LOCALAPPDATA\Hyper\Update.exe" --uninstall -s'

  ; Wipe any stale Hyperia / Hyperia2 shortcuts before the fresh install creates
  ; new ones. A leftover .lnk carries a cached icon that can pin the OLD icon
  ; onto the taskbar even after a correct reinstall.
  SetShellVarContext current
  Delete "$DESKTOP\Hyperia.lnk"
  Delete "$DESKTOP\Hyperia2.lnk"
  Delete "$SMPROGRAMS\Hyperia.lnk"
  Delete "$SMPROGRAMS\Hyperia2.lnk"
  SetShellVarContext all
  Delete "$DESKTOP\Hyperia.lnk"
  Delete "$DESKTOP\Hyperia2.lnk"
  Delete "$SMPROGRAMS\Hyperia.lnk"
  Delete "$SMPROGRAMS\Hyperia2.lnk"
  SetShellVarContext current
!macroend
