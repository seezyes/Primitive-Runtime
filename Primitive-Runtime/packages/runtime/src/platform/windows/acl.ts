import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, win32 } from "node:path";
import { RuntimeError } from "../../errors.js";

/**
 * Synchronous Windows state ACL gate. The only granted principals are the
 * current owner and LocalSystem. An already existing, USER-owned directory
 * is repaired idempotently rather than rejected because of inherited ACEs.
 *
 * We cache a successful check by file identity/metadata within one process:
 * after the DACL is made private an unrelated account cannot modify it.
 * This is not a defense against other processes running as this same user.
 */
const verified = new Map<string, string>();

export function requireLocalWindowsPath(value: string): void {
  if (process.platform !== "win32") return;
  if (
    !/^[A-Za-z]:[\\/]/u.test(value) ||
    value.includes("\0") ||
    win32.normalize(value).startsWith("\\\\")
  ) {
    throw new RuntimeError(
      "CONFIG_REQUIRED",
      "Private runtime files must use a local drive-absolute Windows path.",
    );
  }
}

const WINDOWS_ACL = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$p = $env:PRIMITIVE_ACL_PATH
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')

# Reject junctions and other reparse points in the entire ancestry, not just
# the final leaf. Never modify the DACL of an unexpected redirection target.
$full = [System.IO.Path]::GetFullPath($p)
$cursor = [System.IO.Path]::GetPathRoot($full)
foreach ($part in $full.Substring($cursor.Length).Split([char]'\')) {
  if (-not $part) { continue }
  $cursor = [System.IO.Path]::Combine($cursor, $part)
  $node = Get-Item -LiteralPath $cursor -Force
  if (($node.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw ('Reparse point in private path: ' + $cursor)
  }
}
$node = Get-Item -LiteralPath $full -Force
$acl = Get-Acl -LiteralPath $full
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $me.Value) {
  throw ('Private path has different owner SID: ' + $owner.Value)
}
if ($env:PRIMITIVE_ACL_REPAIR -eq '1') {
  if (-not $node.PSIsContainer) {
    throw 'Refusing to rewrite the ACL of an arbitrary file'
  }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRuleSpecific($rule)
  }
  $flags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
           [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  foreach ($sid in @($me, $system)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $flags,
      [System.Security.AccessControl.PropagationFlags]::None,
      $allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $full -AclObject $acl -ErrorAction Stop
  $acl = Get-Acl -LiteralPath $full
}
if ($node.PSIsContainer -and -not $acl.AreAccessRulesProtected) {
  throw 'Private directory still inherits ACL grants'
}
$allowed = @($me.Value, $system.Value)
foreach ($rule in $acl.Access) {
  try {
    $sid = $rule.IdentityReference.Translate(
      [System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    $sid = $rule.IdentityReference.Value
  }
  if ($allowed -notcontains $sid) {
    throw ('Unexpected ACL entry for SID/account: ' + $sid)
  }
  if ($rule.AccessControlType -ne 'Allow') {
    throw ('Unexpected ACL deny rule for SID/account: ' + $sid)
  }
}
`;

export function requirePrivateWindowsAcl(path: string, repairDirectory = false): void {
  if (process.platform !== "win32") return;
  requireLocalWindowsPath(path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink())
    throw new RuntimeError("ACCESS_DENIED", "Private path cannot be a link.");
  if (repairDirectory && !stat.isDirectory())
    throw new RuntimeError("CONFIG_REQUIRED", "Private state path must be a directory.");
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !/^[A-Za-z]:[\\/]/u.test(systemRoot))
    throw new RuntimeError("ACCESS_DENIED", "Windows SystemRoot is unavailable.");
  const stamp = [stat.dev, stat.ino, stat.ctimeMs, stat.mode, repairDirectory].join(":");
  const key = win32.normalize(path).toLowerCase();
  if (verified.get(key) === stamp) return;

  // PS7 injects its module tree through PSModulePath. Windows PowerShell 5.1
  // then imports a PS7-only Microsoft.PowerShell.Security module and fails.
  // Pin the system module tree instead of inheriting any caller module paths.
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.toLowerCase() === "psmodulepath") delete env[name];
  env.PSModulePath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  env.PRIMITIVE_ACL_PATH = path;
  env.PRIMITIVE_ACL_REPAIR = repairDirectory ? "1" : "0";
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL],
    { windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024, env },
  );
  if (result.status !== 0 || result.error) {
    const detail = ((result.stderr || result.stdout || result.error?.message || "")
      .replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 650);
    throw new RuntimeError(
      "ACCESS_DENIED",
      "Windows owner-only ACL verification/repair failed" + (detail ? ": " + detail : "."),
    );
  }
  const after = lstatSync(path);
  verified.set(key, [after.dev, after.ino, after.ctimeMs, after.mode, repairDirectory].join(":"));
}
