#!/usr/bin/env node
/**
 * 把 Tauri 打包产物拷到仓库根目录 release/，方便直接取用。
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const dest = join(root, "release")
const target = join(root, "src-tauri", "target")

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

function asciiName(name) {
  const lower = name.toLowerCase()
  const ver = name.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "0.0.0"
  const ext = name.endsWith(".dmg") ? ".dmg" : name.endsWith(".tar.gz") ? ".tar.gz" : ""
  if (!ext) return null
  if (lower.includes("aarch64") || lower.includes("arm64")) return `pi-auto_${ver}_aarch64${ext}`
  if (lower.includes("x64") || lower.includes("x86_64") || lower.includes("intel")) {
    return `pi-auto_${ver}_x64${ext}`
  }
  return `pi-auto_${ver}${ext}`
}

mkdirSync(dest, { recursive: true })

const files = walk(target).filter((path) => {
  const n = basename(path).toLowerCase()
  if (!n.endsWith(".dmg") && !n.endsWith(".tar.gz")) return false
  return path.includes(`${join("release", "bundle")}`) || path.includes("/release/bundle/")
})

const apps = []
function findApps(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (name.endsWith(".app") && st.isDirectory() && path.includes("bundle")) {
      apps.push(path)
      continue
    }
    if (st.isDirectory() && name !== "node_modules") findApps(path)
  }
}
findApps(target)

if (files.length === 0 && apps.length === 0) {
  console.error("未找到打包产物。请先运行 npm run tauri:build:mac")
  process.exit(1)
}

for (const file of files) {
  const name = basename(file)
  copyFileSync(file, join(dest, name))
  const alias = asciiName(name)
  if (alias && alias !== name) copyFileSync(file, join(dest, alias))
  console.log(`release/${name}`)
}

for (const app of apps) {
  const name = basename(app)
  const to = join(dest, name)
  cpSync(app, to, { recursive: true })
  console.log(`release/${name}`)
}

console.log(`已复制到 ${dest}`)
