import { execFileSync } from "node:child_process"
import { accessSync, constants, existsSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Finds the Codex CLI executable or the copy bundled inside the Codex desktop
// app (Linux deb, macOS Codex.app, Windows standalone or Microsoft Store MSIX).
// Windows Store packages live under %ProgramFiles%\WindowsApps, which denies
// directory listing (EPERM) to normal users, so we resolve PackageRootFolder
// via the AppModel registry instead of readdirSync.

let cachedWinPath = null

function isRunnable(file) {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function versionParts(key) {
  const match = /OpenAI\.Codex_([0-9.]+)_/i.exec(key)
  return match ? match[1].split(".").map((part) => Number.parseInt(part, 10) || 0) : []
}

function compareVersionsDesc(a, b) {
  const va = versionParts(a)
  const vb = versionParts(b)
  const len = Math.max(va.length, vb.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (vb[i] ?? 0) - (va[i] ?? 0)
    if (diff !== 0) return diff
  }
  return b.localeCompare(a)
}

function checkPackageRoot(root) {
  if (!root) return null
  for (const rel of [
    ["app", "resources", "codex.exe"],
    ["resources", "codex.exe"],
  ]) {
    const candidate = path.win32.join(root, ...rel)
    if (isRunnable(candidate)) return candidate
  }
  return null
}

function regBinary() {
  const full = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe")
  return existsSync(full) ? full : "reg"
}

function findWindowsBundledCodex() {
  if (cachedWinPath && isRunnable(cachedWinPath)) return cachedWinPath

  const directRoots = [
    process.env.LOCALAPPDATA && path.win32.join(process.env.LOCALAPPDATA, "Programs", "OpenAI Codex"),
    process.env.LOCALAPPDATA && path.win32.join(process.env.LOCALAPPDATA, "Programs", "Codex"),
    process.env.ProgramFiles && path.win32.join(process.env.ProgramFiles, "OpenAI Codex"),
    process.env.ProgramFiles && path.win32.join(process.env.ProgramFiles, "Codex"),
  ].filter(Boolean)

  for (const dir of directRoots) {
    const hit = checkPackageRoot(dir)
    if (hit) {
      cachedWinPath = hit
      return hit
    }
  }

  const reg = regBinary()
  const packagesKey = "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages"
  try {
    const out = execFileSync(reg, ["query", packagesKey, "/k", "/f", "OpenAI.Codex_"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    })
    const keys = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^HKEY_/i.test(line) && /OpenAI\.Codex_/i.test(line))
      .sort(compareVersionsDesc)

    for (const key of keys) {
      try {
        const val = execFileSync(reg, ["query", key, "/v", "PackageRootFolder"], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        const match = val.match(/^\s*PackageRootFolder\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im)
        const hit = checkPackageRoot(match?.[1]?.trim())
        if (hit) {
          cachedWinPath = hit
          return hit
        }
      } catch {}
    }
  } catch {}

  try {
    const ps = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
      ],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    ).trim()
    const hit = checkPackageRoot(ps)
    if (hit) {
      cachedWinPath = hit
      return hit
    }
  } catch {}

  return null
}

export function findBundledCodex() {
  for (const file of ["/usr/lib/chatgpt/resources/codex", "/Applications/Codex.app/Contents/Resources/codex"]) {
    if (isRunnable(file)) return file
  }
  if (process.platform === "win32") return findWindowsBundledCodex()
  return null
}

export function findCodex(env = process.env) {
  const win = process.platform === "win32"
  const envBin = env.CODEX_BIN
  if (envBin) {
    if (win && !/\.(exe|cmd|bat)$/i.test(envBin)) {
      if (isRunnable(`${envBin}.exe`)) return `${envBin}.exe`
      if (isRunnable(`${envBin}.cmd`)) return `${envBin}.cmd`
    }
    if (isRunnable(envBin)) return envBin
  }
  const names = win ? ["codex.exe", "codex.cmd", "codex"] : ["codex"]
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (isRunnable(candidate)) return candidate
    }
  }
  return findBundledCodex()
}

try {
  if (
    process.argv[1] &&
    path.basename(process.argv[1]) === "codex-bin.mjs" &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  ) {
    const found = process.argv.includes("--bundled") ? findBundledCodex() : findCodex()
    if (!found) process.exit(1)
    process.stdout.write(`${found}\n`)
  }
} catch {}
