import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// What differs between Linux/macOS and Windows, in one place.
//
// Wake commands (lib/kinds.ts) and the scripts in scripts/ are bash. On Windows
// the room runs them through Git Bash (Git for Windows), which Claude Code
// itself needs there too. The same goes for the CLIs the room calls directly
// (codex, cursor-agent, codebuddy…): npm installs them as .cmd shims that Node
// won't start without a shell, but also as an extensionless shell shim that
// Git Bash starts fine.
//
// Every function takes the platform as an argument (default: this machine's) so
// the Windows branch can be checked from anywhere.

export type Platform = NodeJS.Platform

// Git Bash, where it is usually installed. Not C:\Windows\System32\bash.exe:
// that is WSL, a different machine with its own files.
export function gitBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")]
  const found = roots.filter((root): root is string => Boolean(root)).map((root) => path.win32.join(root, "Git", "bin", "bash.exe"))
  return env.BENCH_BASH ? [env.BENCH_BASH, ...found] : found
}

let bash: string | null | undefined

// The bash that runs wake commands: `sh` where it is native, Git Bash on
// Windows (null if it isn't there).
export function shellProgram(platform: Platform = process.platform): string | null {
  if (platform !== "win32") return "/bin/sh"
  if (bash !== undefined) return bash
  bash = gitBashCandidates().find((file) => existsSync(file)) ?? null
  if (!bash) {
    try {
      const found = execFileSync("where", ["bash"], { encoding: "utf8", timeout: 5000 })
        .split(/\r?\n/)
        .find((line) => line.trim() && !/[\\/]system32[\\/]/i.test(line))
      bash = found?.trim() || null
    } catch {
      bash = null
    }
  }
  return bash
}

export const NO_BASH = "Windows 上要先装 Git for Windows（https://git-scm.com/download/win），房间用它自带的 Git Bash 跑唤起命令和脚本；装在别处的话，把 bash.exe 的完整路径写进环境变量 BENCH_BASH"

// The program and arguments that run `file args…` the way a shell would find
// it: as is, except on Windows where it goes through Git Bash, which finds
// the extensionless shim of an npm-installed CLI. The arguments reach it
// untouched ("$@").
export function cliCommand(file: string, args: string[], platform: Platform = process.platform): [string, string[]] {
  if (platform !== "win32") return [file, args]
  const program = shellProgram(platform)
  if (!program) throw new Error(NO_BASH)
  return [program, ["-c", 'exec "$@"', "bench", file, ...args]]
}

// The program and arguments that run one of the room's own bash scripts
// (scripts/*.sh): directly where it is executable, else through Git Bash.
export function scriptCommand(script: string, args: string[], platform: Platform = process.platform): [string, string[]] {
  if (platform !== "win32") return [script, args]
  const program = shellProgram(platform)
  if (!program) throw new Error(NO_BASH)
  return [program, [script.replace(/\\/g, "/"), ...args]]
}

// The program and arguments for a wake command line (bash syntax).
export function commandLine(command: string, platform: Platform = process.platform): [string, string[]] {
  const program = shellProgram(platform)
  if (!program) throw new Error(NO_BASH)
  return [program, ["-c", command]]
}

// The directories added to a woken command's PATH when the room lacks them:
// where the CLIs usually are (a room started from a desktop icon has a
// shorter PATH than a terminal).
export function extraBins(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  if (platform === "win32") {
    const join = path.win32.join
    return [
      join(home, ".local", "bin"),
      ...(env.APPDATA ? [join(env.APPDATA, "npm")] : []),
      ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")] : []),
    ]
  }
  return [path.posix.join(home, ".local", "bin"), "/usr/local/nodejs/bin", "/usr/local/bin"]
}

export function pathDelimiter(platform: Platform = process.platform) {
  return platform === "win32" ? ";" : ":"
}

// File names a bare command can have on disk: as typed, plus on Windows what
// PATHEXT says (.exe, .cmd…).
export function commandNames(name: string, platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  if (platform !== "win32") return [name]
  if (path.win32.extname(name)) return [name]
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  return [name, ...exts.map((ext) => name + ext.toLowerCase())]
}

// A folder's root-relative name for display: backslashes on Windows too.
export function baseName(file: string) {
  return file.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || file
}

// Stop a run's whole process tree. Unix: its process group (the child was
// started detached). Windows has no groups; taskkill /T walks the tree.
export function killTree(pid: number, platform: Platform = process.platform) {
  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 })
    } catch {}
    return
  }
  process.kill(-pid, "SIGTERM")
}

// Where the room keeps what belongs to the user but not to the repository.
export function dataHome(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  if (env.XDG_DATA_HOME) return env.XDG_DATA_HOME
  if (platform === "win32") return env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local")
  return path.posix.join(home, ".local", "share")
}
