' dsh-better-workspace - Explorer "Open as workspace" launcher (v0.37.1).
'
' wscript.exe is a GUI-subsystem host, so invoking this wrapper from the
' registry verb shows NO console window at all. powershell.exe alone cannot
' achieve that: Explorer starts verb commands with SW_SHOWNORMAL, so the
' console host window appears before -WindowStyle Hidden takes effect (the
' visible popup users saw with v0.37.0).
'
' Arguments: 0 = picked directory (the verb's "%1"), 1 = inbox file path.
Dim shell, ps1, inbox
ps1 = Left(WScript.ScriptFullName, Len(WScript.ScriptFullName) - 4) & ".ps1"
inbox = WScript.Arguments(1)
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ _
  & ps1 & """ -Path """ & WScript.Arguments(0) & """ -Inbox """ & inbox & """", 0, False
Set shell = Nothing
