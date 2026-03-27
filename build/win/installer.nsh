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
!macroend
