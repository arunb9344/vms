Set WshShell = CreateObject("WScript.Shell")
' Resolve absolute directory path of the launcher
strScriptPath = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
' Set working directory explicitly to installation folder
WshShell.CurrentDirectory = strScriptPath
' Start node.exe index.js in background with hidden window (0)
WshShell.Run Chr(34) & strScriptPath & "node.exe" & Chr(34) & " index.js", 0, False
' Allow 3 seconds for server startup before opening browser
WScript.Sleep 3000
' Launch default browser to show dashboard UI
WshShell.Run "http://localhost:3000"
