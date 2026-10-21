import { spawnSync } from "node:child_process";
import { join, win32 } from "node:path";
import { RuntimeError } from "../errors.js";

export function requireLocalWindowsPath(value: string): void {
  if (process.platform !== "win32") return;
  // Named devices, UNC shares, WSL mounts and extended paths are not local
  // private NTFS storage. Only normal drive-absolute paths are admitted.
  if (!/^[A-Za-z]:[\\/]/u.test(value) || value.includes("\0")) {
    throw new RuntimeError(
      "CONFIG_REQUIRED",
      "Private runtime files must use a local drive-absolute Windows path.",
    );
  }
  if (win32.normalize(value).startsWith("\\\\"))
    throw new RuntimeError("CONFIG_REQUIRED", "Windows device paths are unsupported.");
}

const WINDOWS_ACL = `
$ErrorActionPreference = "Stop"
$p = $env:PRIMITIVE_ACL_PATH
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
if ($env:PRIMITIVE_ACL_CREATE -eq "1") {
  $acl = Get-Acl -LiteralPath $p
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  foreach ($sid in @($me, $system)) {
    $access = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagate, $allow
    )
    [void]$acl.AddAccessRule($access)
  }
  Set-Acl -LiteralPath $p -AclObject $acl
}
$acl = Get-Acl -LiteralPath $p
$allowed = @($me.Value, $system.Value, "S-1-5-32-544")
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -ne "Allow") { continue }
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($allowed -notcontains $sid) { throw "Untrusted ACL read/write grant: $sid" }
}
`;

export function requirePrivateWindowsAcl(path: string, newlyCreated = false): void {
  if (process.platform !== "win32") return;
  requireLocalWindowsPath(path);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !/^[A-Za-z]:[\\/]/u.test(systemRoot))
    throw new RuntimeError("ACCESS_DENIED", "Windows SystemRoot is unavailable.");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 12000,
      maxBuffer: 16 * 1024,
      env: {
        ...process.env,
        PRIMITIVE_ACL_PATH: path,
        PRIMITIVE_ACL_CREATE: newlyCreated ? "1" : "0",
      },
    },
  );
  if (result.status !== 0 || result.error)
    throw new RuntimeError(
      "ACCESS_DENIED",
      "Windows state/credential ACL could not be verified as owner-only.",
    );
}
