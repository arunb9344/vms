Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Resolve absolute directory path of the launcher
strScriptPath = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
WshShell.CurrentDirectory = strScriptPath

' Start node.exe index.js in background with hidden window (0)
WshShell.Run Chr(34) & strScriptPath & "node.exe" & Chr(34) & " index.js", 0, False

targetUrl = "http://localhost:3000"

' Poll localhost:3000 until web server is online and listening (up to 15 seconds)
For i = 1 To 15
    WScript.Sleep 1000
    On Error Resume Next
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", targetUrl, False
    http.Send
    If Err.Number = 0 Then
        If http.Status = 200 Or http.Status = 403 Or http.Status = 302 Then
            Exit For
        End If
    End If
    On Error GoTo 0
Next

' 1. Check Windows Registry App Paths for Chrome
chromeExe = ""
On Error Resume Next
chromeExe = WshShell.RegRead("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe\")
If chromeExe = "" Then
    chromeExe = WshShell.RegRead("HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe\")
End If
On Error GoTo 0

' 2. Check hardcoded standard Windows installation paths for Chrome (bypassing 32-bit WOW64 redirection)
If chromeExe = "" Or Not fso.FileExists(chromeExe) Then
    sysDrive = WshShell.ExpandEnvironmentStrings("%SystemDrive%")
    cPath1 = sysDrive & "\Program Files\Google\Chrome\Application\chrome.exe"
    cPath2 = sysDrive & "\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    cPath3 = WshShell.ExpandEnvironmentStrings("%LocalAppData%") & "\Google\Chrome\Application\chrome.exe"
    cPath4 = WshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"
    
    If fso.FileExists(cPath1) Then
        chromeExe = cPath1
    ElseIf fso.FileExists(cPath2) Then
        chromeExe = cPath2
    ElseIf fso.FileExists(cPath3) Then
        chromeExe = cPath3
    ElseIf fso.FileExists(cPath4) Then
        chromeExe = cPath4
    End If
End If

' Launch Google Chrome if executable path is resolved, otherwise invoke Windows shell "start chrome"
If chromeExe <> "" And fso.FileExists(chromeExe) Then
    WshShell.Run Chr(34) & chromeExe & Chr(34) & " " & targetUrl
Else
    On Error Resume Next
    WshShell.Run "cmd /c start chrome " & targetUrl, 0, False
    If Err.Number <> 0 Then
        WshShell.Run targetUrl
    End If
    On Error GoTo 0
End If
