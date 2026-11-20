#!/usr/bin/env node
// Ensure dependencies match dependency fields in package.json / package-lock.json
// before starting. Installs when node_modules is missing, incomplete, or its
// saved dependency fingerprint no longer matches; recomputes the fingerprint
// after install and exits non-zero on failure.
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  let root = process.cwd()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = path.resolve(argv[++i])
  }
  return { root }
}

function depFieldsJson(pkgPath) {
  const raw = readFileSync(pkgPath, "utf8")
  try {
    const pkg = JSON.parse(raw)
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return raw
    return JSON.stringify({
      dependencies: pkg.dependencies ?? null,
      devDependencies: pkg.devDependencies ?? null,
      optionalDependencies: pkg.optionalDependencies ?? null,
      overrides: pkg.overrides ?? null,
    })
  } catch {
    return raw
  }
}

function hashManifests(pkgPath, lockPath) {
  const hash = createHash("sha256")
  hash.update(depFieldsJson(pkgPath))
  hash.update("\0")
  if (existsSync(lockPath)) hash.update(readFileSync(lockPath))
  return hash.digest("hex")
}

function maxMtime(paths) {
  let latest = 0
  for (const file of paths) {
    if (!existsSync(file)) continue
    const ms = statSync(file).mtimeMs
    if (ms > latest) latest = ms
  }
  return latest
}

const { root } = parseArgs(process.argv.slice(2))
const pkgPath = path.join(root, "package.json")
const lockPath = path.join(root, "package-lock.json")
if (!existsSync(pkgPath)) {
  console.error(`找不到 ${pkgPath}`)
  process.exit(1)
}

const nodeModulesDir = path.join(root, "node_modules")
const npmLockFile = path.join(nodeModulesDir, ".package-lock.json")
const stampFile = path.join(nodeModulesDir, ".bench-deps-stamp")

const manifestHash = hashManifests(pkgPath, lockPath)

let needInstall = false
let reason = ""

if (!existsSync(nodeModulesDir) || !existsSync(npmLockFile)) {
  needInstall = true
  reason = "还没有安装依赖，正在执行 npm install…"
} else if (existsSync(stampFile)) {
  const savedHash = readFileSync(stampFile, "utf8").trim()
  if (savedHash !== manifestHash) {
    needInstall = true
    reason = "检测到依赖清单有更新，正在执行 npm install…"
  }
} else {
  const manifestMtimeMs = maxMtime([pkgPath, lockPath])
  const npmLockMtimeMs = statSync(npmLockFile).mtimeMs
  if (manifestMtimeMs > npmLockMtimeMs) {
    needInstall = true
    reason = "检测到依赖清单比上次安装新，正在执行 npm install…"
  } else {
    try {
      writeFileSync(stampFile, `${manifestHash}\n`, "utf8")
    } catch {}
  }
}

if (!needInstall) process.exit(0)

console.log(reason)
const npmBin = process.env.BENCH_NPM_BIN || "npm"
const result = spawnSync(npmBin, ["install"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32" && !process.env.BENCH_NPM_BIN,
})

if (result.error || result.status !== 0) {
  const detail = result.error ? result.error.message : `退出码 ${result.status ?? 1}`
  console.error(`依赖安装失败（${detail}）。请先处理上面的报错再启动，不会带着旧依赖继续运行。`)
  process.exit(result.status && result.status > 0 ? result.status : 1)
}

if (existsSync(nodeModulesDir)) {
  writeFileSync(stampFile, `${hashManifests(pkgPath, lockPath)}\n`, "utf8")
}
