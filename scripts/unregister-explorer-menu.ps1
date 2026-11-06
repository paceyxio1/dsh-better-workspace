# dsh-better-workspace - remove the Explorer "Open as workspace" context-menu entry.
# Run manually when the plugin is uninstalled or the menu is no longer wanted:
#   powershell -ExecutionPolicy Bypass -File unregister-explorer-menu.ps1
$keys = @(
  'HKCU\Software\Classes\Directory\shell\DSH.BetterWorkspace.Open'
)
foreach ($key in $keys) {
  reg.exe delete $key /f 2>$null | Out-Null
}
Write-Host 'Explorer context-menu entry removed (if it was present).'
