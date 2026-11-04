#ifndef Payload
  #error Payload must point to the tested package payload
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif
[Setup]
AppId=TaboraBrowser
AppName=Tabora Browser
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\TaboraBrowser
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release
OutputBaseFilename=tabora-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\tabora.exe
[Files]
Source: "{#Payload}\*"; DestDir: "{tmp}\TaboraPayload"; Flags: recursesubdirs createallsubdirs deleteafterinstall
[Tasks]
Name: autoupdate; Description: "Automatically install verified updates between tasks"
Name: storeextension; Description: "Use the Chrome Web Store extension (requires a published Store item)"; Flags: unchecked; Check: NewTaboraInstallation
[UninstallRun]
Filename: "{app}\tabora.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated
[UninstallDelete]
Type: filesandordirs; Name: "{app}\versions"
Type: filesandordirs; Name: "{app}\extension-unpacked"
Type: files; Name: "{app}\tabora.exe"
Type: files; Name: "{app}\native-host.json"
Type: files; Name: "{app}\installation.json"
[Code]
function NewTaboraInstallation(): Boolean;
begin
  Result := not FileExists(ExpandConstant('{app}\installation.json'));
end;

function InitializeUninstall(): Boolean;
var ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{app}\tabora.exe'), 'uninstall-check', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := Result and (ResultCode = 0);
  if not Result then MsgBox('Installation is busy or its owned layout could not be verified. Finish Tabora tasks, disable its connected extensions and close MCP clients before retrying. Repair an invalid installation first. No files have been removed.', mbError, MB_OK);
end;
procedure CurStepChanged(CurStep: TSetupStep);
var ResultCode: Integer; Parameters: String;
begin
  if CurStep = ssPostInstall then begin
    Parameters := 'install --root "' + ExpandConstant('{app}') + '"';
    if WizardIsTaskSelected('autoupdate') then Parameters := Parameters + ' --auto-update'
    else Parameters := Parameters + ' --notify-only';
    if NewTaboraInstallation() and WizardIsTaskSelected('storeextension') then Parameters := Parameters + ' --extension-channel store';
    if not Exec(ExpandConstant('{tmp}\TaboraPayload\tabora.exe'), Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      RaiseException('Could not launch Tabora installation.');
    if ResultCode <> 0 then RaiseException('Tabora registration needs attention. Run the packaged CLI repair after resolving any existing registration conflict.');
  end;
end;
