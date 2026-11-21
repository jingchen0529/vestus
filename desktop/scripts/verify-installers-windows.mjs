import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertArchitecture, currentBinary, regularFile, requireDisposable, sha256, verifyChromium } from "./verify-installers.mjs";
import { validateTree } from "./chromium-archive.mjs";

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const sids = ["S-1-15-2-1", "S-1-15-2-2", "S-1-5-12"];

function registryScript(metadata) {
  return `
$names = @(${literal(metadata.productName)}, ${literal(metadata.identifier)})
function Get-Installed {
  $roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
  foreach ($root in $roots) {
    if (Test-Path -LiteralPath $root) {
      foreach ($key in Get-ChildItem -LiteralPath $root) {
        $item = Get-ItemProperty -LiteralPath $key.PSPath
        if ($names -contains $item.DisplayName -or $names -contains $key.PSChildName) {
          [PSCustomObject]@{displayName=$item.DisplayName; displayVersion=$item.DisplayVersion; uninstallString=$item.UninstallString; installLocation=$item.InstallLocation}
        }
      }
    }
  }
}`;
}

function shortcutScript(metadata) {
  return `
function Get-ProductShortcuts {
  foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms'))) {
    foreach ($candidate in @((Join-Path $folder ${literal(`${metadata.productName}.lnk`)}), (Join-Path $folder ${literal(metadata.productName)}))) {
      if (Test-Path -LiteralPath $candidate) { $candidate }
    }
  }
}`;
}

async function powershell(ctx, cwd, stage, source) {
  const script = `$ErrorActionPreference = 'Stop'\n# installer:${stage}\n${source}`;
  const result = await ctx.command("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], cwd, [0], 360_000);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

function waitScript(executable, args) {
  return `
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = ${literal(executable)}
$start.Arguments = ${args}
$start.UseShellExecute = $false
$process = [System.Diagnostics.Process]::Start($start)
if (!$process.WaitForExit(300000)) { throw 'Owned NSIS process timed out; no global process termination attempted' }
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw 'Owned NSIS process returned nonzero exit code' }
`;
}

function validUninstaller(path) {
  regularFile(path);
  const bytes = readFileSync(path), offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
  if (bytes.toString("ascii", 0, 2) !== "MZ" || offset < 64 || offset + 26 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 || ![0x14c, 0x8664].includes(bytes.readUInt16LE(offset + 4))) throw new Error("Owned uninstaller is not a valid NSIS PE executable");
}

export async function verifyWindows(ctx) {
  const parent = ctx.temp(requireDisposable(ctx.env, ctx.target)), commands = ctx.temp(ctx.env.RUNNER_TEMP);
  const install = join(parent, "Installer path with spaces"), uninstaller = join(install, "uninstall.exe");
  const registry = registryScript(ctx.metadata);
  ctx.report.sideEffects = { installMode: "currentUser", registry: "NSIS creates current-user uninstall metadata", shortcuts: "NSIS creates current-user Start Menu/desktop shortcuts; removed only by own NSIS uninstaller", webview2: "preflight-only; not installed by verifier" };
  const preflight = await powershell(ctx, commands, "preflight", `${registry}
${shortcutScript(ctx.metadata)}
$shortcuts = @(Get-ProductShortcuts)
$webview2 = $false
foreach ($root in @('HKLM:\\Software\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients', 'HKLM:\\Software\\Microsoft\\EdgeUpdate\\Clients', 'HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients')) {
  if (Test-Path -LiteralPath $root) {
    foreach ($key in Get-ChildItem -LiteralPath $root) {
      $item = Get-ItemProperty -LiteralPath $key.PSPath
      if ($item.name -eq 'Microsoft Edge WebView2 Runtime' -and $item.pv -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' -and $item.pv -ne '0.0.0.0') { $webview2 = $true }
    }
  }
}
@{installed=@(Get-Installed); shortcuts=@($shortcuts); webview2=$webview2} | ConvertTo-Json -Depth 6 -Compress`);
  if (!Array.isArray(preflight.installed) || preflight.installed.length || !Array.isArray(preflight.shortcuts) || preflight.shortcuts.length) throw new Error("Existing installation/shortcut detected; refusing automatic uninstall or overwrite");
  // CI runner 不预装 WebView2 运行时：仅记录缺失，不阻断安装结构与文件校验
  // （NSIS /S 安装不依赖运行时；应用运行时才需要，GUI 验证本就 not-run）。
  ctx.report.checks.push({ name: "webview2", status: preflight.webview2 === true ? "present" : "absent" });
  currentBinary(ctx);
  let launched = false, verified = false, uninstallerHash;
  try {
    launched = true;
    const outcome = await powershell(ctx, commands, "install", `$install = ${literal(install)}
${waitScript(ctx.assets[0], "('/S /D=' + $install)")}
@{exited=$process.HasExited; exitCode=$process.ExitCode} | ConvertTo-Json -Compress`);
    if (outcome.exited !== true || outcome.exitCode !== 0) throw new Error("Installer exit was not confirmed");
    validateTree(install);
    const executable = regularFile(join(install, `${ctx.metadata.binary}.exe`));
    assertArchitecture(executable, ctx.target);
    const installedHash = sha256(executable), currentHash = sha256(currentBinary(ctx));
    if (installedHash !== currentHash) {
      // 同尺寸不同内容的 PE：定位首个差异偏移与差异量，识别改写区域（签名表/
      // 时间戳/追加节等）。计数用二分遍历，避免大文件 O(n) 也够用。
      const packaged = readFileSync(executable), current = readFileSync(currentBinary(ctx));
      let firstDiff = -1, diffCount = 0;
      const length = Math.min(packaged.length, current.length);
      for (let index = 0; index < length; index += 1) {
        if (packaged[index] !== current[index]) {
          diffCount += 1;
          if (firstDiff < 0) firstDiff = index;
        }
      }
      throw new Error(
        `Installed main executable hash differs from current build: installed ${installedHash} (${packaged.length} bytes), current ${currentHash} (${current.length} bytes), firstDiffOffset ${firstDiff} (0x${(firstDiff >>> 0).toString(16)}), diffBytes ${diffCount}${packaged.length !== current.length ? `, sizeDelta ${current.length - packaged.length}` : ""}`,
      );
    }
    validUninstaller(uninstaller);
    uninstallerHash = sha256(uninstaller);
    const info = await powershell(ctx, commands, "inspect", `${registry}
$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo(${literal(executable)})
@{installed=@(Get-Installed); fileVersion=$version.FileVersion; productVersion=$version.ProductVersion; productName=$version.ProductName; uninstallerSha256=(Get-FileHash -LiteralPath ${literal(uninstaller)} -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Depth 6 -Compress`);
    const item = info.installed?.length === 1 ? info.installed[0] : null;
    if (!item || item.displayName !== ctx.metadata.productName || item.displayVersion !== ctx.metadata.version || (item.installLocation && resolve(item.installLocation) !== install) || item.uninstallString !== `"${uninstaller}"` || info.uninstallerSha256 !== uninstallerHash) throw new Error("Owned uninstall registry metadata/path/hash mismatch; refusing unknown uninstall command");
    verified = true;
    if (![ctx.metadata.version, `${ctx.metadata.version}.0`].includes(info.fileVersion) || ![ctx.metadata.version, `${ctx.metadata.version}.0`].includes(info.productVersion) || info.productName !== ctx.metadata.productName) throw new Error("Installed PE product/version mismatch");
    ctx.report.checks.push({ name: "app-metadata", status: "passed", fileVersion: info.fileVersion, productVersion: info.productVersion, executableSha256: sha256(executable) });
    await verifyChromium(ctx, join(install, "chromium"));
    const acl = await powershell(ctx, commands, "acl", `
$root = ${literal(join(install, "chromium"))}
$sids = @(${sids.map(literal).join(", ")})
$violations = @(); $checked = 0
foreach ($path in @($root) + @(Get-ChildItem -LiteralPath $root -Recurse -Force | ForEach-Object { $_.FullName })) {
  $checked++
  $rules = (Get-Acl -LiteralPath $path).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  foreach ($sid in $sids) {
    $allow = 0; $deny = 0
    foreach ($rule in $rules) {
      if ($rule.IdentityReference.Value -eq $sid -and (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0)) {
        if ($rule.AccessControlType -eq 'Allow') { $allow = $allow -bor [int]$rule.FileSystemRights } else { $deny = $deny -bor [int]$rule.FileSystemRights }
      }
    }
    $rx = [int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    if (($allow -band $rx) -ne $rx -or ($deny -band $rx) -ne 0) { $violations += @{path=$path; sid=$sid} }
  }
}
@{checked=$checked; violations=@($violations)} | ConvertTo-Json -Depth 6 -Compress`);
    if (!Number.isInteger(acl.checked) || acl.checked < 2 || !Array.isArray(acl.violations) || acl.violations.length) throw new Error("Chromium sandbox ACL missing RX for required three SIDs");
    ctx.report.checks.push({ name: "sandbox-acl", status: "passed", sids, checked: acl.checked });
  } finally {
    if (launched && verified) {
      try {
        // NSIS documented _?= keeps the process waitable. Run an owned verified copy
        // outside INSTDIR so the template can delete its original uninstall.exe.
        const copy = join(commands, "owned-uninstall.exe");
        if (sha256(uninstaller) !== uninstallerHash) throw new Error("Owned uninstaller identity changed");
        copyFileSync(uninstaller, copy, 1);
        if (sha256(copy) !== uninstallerHash) throw new Error("Owned uninstaller copy hash mismatch");
        const outcome = await powershell(ctx, commands, "uninstall", `${registry}
${shortcutScript(ctx.metadata)}
$install = ${literal(install)}
if ((Get-FileHash -LiteralPath ${literal(copy)} -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${literal(uninstallerHash)}) { throw 'Owned uninstaller copy changed' }
${waitScript(copy, "('/S _?=' + $install)")}
@{exited=$process.HasExited; exitCode=$process.ExitCode; directoryAbsent=!(Test-Path -LiteralPath $install); installed=@(Get-Installed); shortcuts=@(Get-ProductShortcuts)} | ConvertTo-Json -Depth 6 -Compress`);
        if (outcome.exited !== true || outcome.exitCode !== 0 || !Array.isArray(outcome.installed) || outcome.installed.length) throw new Error("Owned uninstall did not remove registration or did not exit");
        if (!Array.isArray(outcome.shortcuts) || outcome.shortcuts.length) throw new Error("Owned uninstall shortcut cleanup failed");
        if (existsSync(install)) {
          const stat = lstatSync(install);
          if (!stat.isDirectory() || stat.isSymbolicLink() || JSON.stringify(readdirSync(install)) !== '["uninstall.exe"]' || sha256(regularFile(uninstaller)) !== uninstallerHash) throw new Error("Owned uninstall left unexpected payload or unverified residue");
          unlinkSync(uninstaller);
        }
        ctx.report.cleanup.push({ path: install, status: "passed", method: "verified-own-NSIS-uninstall" });
      } catch (error) { ctx.retain(parent); ctx.retain(commands); throw error; }
    } else if (launched) {
      ctx.retain(parent); ctx.retain(commands);
      ctx.report.errors.push("Native installation not validated; retained owned tree rather than executing an unverified uninstaller");
    }
  }
}
