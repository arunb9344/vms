; Inno Setup Script for EyeTech Video Management System (VMS)
; Compile this script using the Inno Setup Compiler (https://jrsoftware.org)

[Setup]
AppName=EyeTech Video Management System
AppVersion=1.0
AppPublisher=EyeTech Securities
AppPublisherURL=https://eyetechsecurities.com
DefaultDirName={commonpf}\EyeTech VMS
DefaultGroupName=EyeTech VMS
OutputDir=.\installer_output
OutputBaseFilename=EyeTech_VMS_Setup
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=admin
UninstallDisplayIcon={app}\vms_launcher.vbs

[Files]
; Copy all files compiled inside the dist/ folder to target PC installation path
Source: "dist\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
; Shortcut to silently run the background server and show dashboard
Name: "{group}\EyeTech VMS"; Filename: "{app}\vms_launcher.vbs"; WorkingDir: "{app}"
; Shortcut to stop VMS background server
Name: "{group}\Stop VMS Server"; Filename: "{app}\stop_vms.bat"; WorkingDir: "{app}"
; Desktop shortcut to run dashboard
Name: "{commondesktop}\EyeTech VMS"; Filename: "{app}\vms_launcher.vbs"; WorkingDir: "{app}"

[Run]
; Auto-start VMS dashboard after installation completes successfully
Filename: "{app}\vms_launcher.vbs"; Description: "Launch EyeTech VMS now"; Flags: postinstall shellexec
