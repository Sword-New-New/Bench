// Lets a plain `node` script import the room's TypeScript modules that use
// the "@/…" alias and extensionless imports (lib/digest.ts and what it
// pulls in). Node 22.13+ strips the types itself. Used by test-digest.mjs:
//   import { register } from "node:module"; register("./ts-alias.mjs", import.meta.url)
import { existsSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export async function resolve(specifier, context, next) {
  let target = null
  if (specifier.startsWith("@/")) target = path.join(root, specifier.slice(2))
  else if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
  if (target && !path.extname(target)) {
    for (const candidate of [`${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")]) {
      if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context)
    }
  }
  if (target) return next(pathToFileURL(target).href, context)
  return next(specifier, context)
}

// Say up front that the room's .ts files are ES modules (no package "type"),
// so Node doesn't try CommonJS first and warn about it.
export async function load(url, context, next) {
  if (url.endsWith(".ts") && url.startsWith(pathToFileURL(root).href)) return next(url, { ...context, format: "module-typescript" })
  return next(url, context)
}
