# dsh-better-workspace - Explorer "Open as workspace" bridge (v0.37.0; the
# registry verb routes through scripts/open-in-dsh.vbs since v0.37.1).
#
# Appends the picked directory as one line to the plugin inbox, then focuses
# (or launches) the DeepSeek Harness desktop app through its registered
# dsh:// protocol. The host half watches the inbox and adopts each line
# through the same services the GUI "add workspace" flow uses.
#
# Registered command (HKCU\Software\Classes\Directory\shell\DSH.BetterWorkspace.Open):
#   wscript.exe "...\open-in-dsh.vbs" "%1" "<DSH_HOME>\better-workspace-open-inbox.txt"
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Inbox
)
$ErrorActionPreference = 'SilentlyContinue'
$line = ($Path -replace "`r?`n", ' ').Trim()
if ($line.Length -gt 0) {
  Add-Content -LiteralPath $Inbox -Value $line -Encoding utf8
}
try { [void][System.Diagnostics.Process]::Start('dsh://open') } catch { }
