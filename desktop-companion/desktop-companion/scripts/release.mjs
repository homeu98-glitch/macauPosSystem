#!/usr/bin/env node
// Macau POS Desktop —— 發佈腳本（一鍵 build + 部署產物到 Vercel static）。
//
// 用法：
//   cd desktop-companion
//   npm run release              # 交互式 bump（patch）
//   npm run release -- --patch   # 明確 bump patch
//   npm run release -- --minor   # bump minor
//   npm run release -- --major   # bump major
//   npm run release -- --ver 0.3.0   # 指定版本
//
// 產出：
//   1) electron-builder 產 dist/macau-pos-desktop-setup.exe + dist/latest.yml
//   2) 將 exe 同 latest.yml 複製去 ../public/releases/（Vercel 會 static serve）
//   3) 更新 ../public/releases/manifest.json（俾 POS API / UI 查版本資訊）
//   4) 提示用家：git add public/releases/ + git push → Vercel 部署 → 用家可「檢查更新」
//
// 注意：
//   - 需要先 npm install（裝 electron + electron-builder + iconv-lite）
//   - 首次 build 會下載 Electron binary（~80MB），要網絡
//   - Windows 先有 nsis target；macOS/Linux 唔跑得通

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(COMPANION_DIR, "..");
const RELEASES_DIR = path.join(PROJECT_ROOT, "public", "releases");
const MANIFEST_PATH = path.join(RELEASES_DIR, "manifest.json");

// ---- 解析 CLI args ----
function parseArgs() {
  const args = process.argv.slice(2);
  let bump = "patch";
  let explicit = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--patch") bump = "patch";
    else if (args[i] === "--minor") bump = "minor";
    else if (args[i] === "--major") bump = "major";
    else if (args[i] === "--ver" && args[i + 1]) explicit = args[i + 1];
  }
  return { bump, explicit };
}

// ---- semver bump ----
function bumpVersion(v, type) {
  const parts = v.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return v;
  const [major, minor, patch] = parts;
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// ---- 主流程 ----
function main() {
  const { bump, explicit } = parseArgs();

  // 1) 讀 package.json，bump version
  const pkgPath = path.join(COMPANION_DIR, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const currentVersion = pkg.version;
  const newVersion = explicit || bumpVersion(currentVersion, bump);

  console.log(`\n[release] 版本：${currentVersion} → ${newVersion}\n`);

  if (currentVersion === newVersion) {
    console.log("[release] 版本冇變，跳過。請用 --patch / --minor / --major / --ver x.y.z");
    process.exit(1);
  }

  // 2) 寫新 version 入 package.json
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  console.log("[release] package.json version 已更新");

  // 3) 跑 electron-builder
  console.log("\n[release] 跑 electron-builder --win nsis …\n");
  try {
    execSync("npx electron-builder --win nsis", {
      cwd: COMPANION_DIR,
      stdio: "inherit",
    });
  } catch (e) {
    console.error("\n[release] electron-builder 失敗：", e.message);
    process.exit(1);
  }

  // 4) 搵 dist/ 入面嘅 exe 同 latest.yml
  const distDir = path.join(COMPANION_DIR, "dist");
  if (!fs.existsSync(distDir)) {
    console.error("[release] dist/ 唔存在，electron-builder 可能失敗");
    process.exit(1);
  }

  const distFiles = fs.readdirSync(distDir);
  const exeFile = distFiles.find((f) => f.endsWith(".exe"));
  const ymlFile = distFiles.find((f) => f === "latest.yml");

  if (!exeFile) {
    console.error("[release] 搵唔到 .exe 檔案喺 dist/");
    console.error("[release] dist/ 入面有：", distFiles.join(", "));
    process.exit(1);
  }
  if (!ymlFile) {
    console.error("[release] 搵唔到 latest.yml 喺 dist/（electron-builder 應該自動產生）");
  }

  const exePath = path.join(distDir, exeFile);
  const ymlPath = ymlFile ? path.join(distDir, ymlFile) : null;

  // 5) 計 sha512（電子更新器用嚟做完整性校驗）
  const exeBuf = fs.readFileSync(exePath);
  const sha512 = crypto.createHash("sha512").update(exeBuf).digest("hex");
  const fileSize = exeBuf.length;
  console.log(`[release] exe=${exeFile} (${(fileSize / 1024 / 1024).toFixed(1)}MB) sha512=${sha512.slice(0, 16)}…`);

  // 6. 確保 releases 目錄存在
  if (!fs.existsSync(RELEASES_DIR)) {
    fs.mkdirSync(RELEASES_DIR, { recursive: true });
  }

  // 7. 複製 exe → public/releases/（用固定名，俾 electron-updater download）
  const exeDest = path.join(RELEASES_DIR, exeFile);
  fs.copyFileSync(exePath, exeDest);
  console.log(`[release] exe → ${path.relative(PROJECT_ROOT, exeDest)}`);

  // 8. 複製 latest.yml → public/releases/latest.yml
  if (ymlPath) {
    const ymlDest = path.join(RELEASES_DIR, "latest.yml");
    // 讀 latest.yml，修正 path 字段為檔名（電子更新器用 relative path）
    let ymlContent = fs.readFileSync(ymlPath, "utf-8");
    // electron-builder 產嘅 latest.yml path 字段已經係檔名，一般唔使改
    fs.writeFileSync(ymlDest, ymlContent, "utf-8");
    console.log(`[release] latest.yml → ${path.relative(PROJECT_ROOT, ymlDest)}`);
  }

  // 9. 讀 latest.yml 嘅 releaseNotes（如果有）
  let releaseNotes = "";
  if (ymlPath) {
    const yml = fs.readFileSync(ymlPath, "utf-8");
    const m = yml.match(/releaseNotes:\s*[\|>]*\n([\s\S]*?)(?=\n\w|\n\n|$)/);
    if (m) releaseNotes = m[1].trim();
  }

  // 10. 更新 manifest.json
  const manifest = {
    version: newVersion,
    pubDate: new Date().toISOString(),
    releaseNotes: releaseNotes || `v${newVersion} 更新`,
    fileName: exeFile,
    sha512,
    path: `/releases/${exeFile}`,
    url: "",
    fileSize,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`[release] manifest.json 已更新 → ${path.relative(PROJECT_ROOT, MANIFEST_PATH)}`);

  // 11. 清舊版 exe（只保留當前版）
  for (const f of fs.readdirSync(RELEASES_DIR)) {
    if (f.endsWith(".exe") && f !== exeFile) {
      const oldExe = path.join(RELEASES_DIR, f);
      fs.unlinkSync(oldExe);
      console.log(`[release] 清舊版 ${f}`);
    }
  }

  // 12. 提示
  console.log("\n========================================");
  console.log("[release] 完成！下一步：");
  console.log("  1) git add public/releases/ desktop-companion/package.json");
  console.log("  2) git commit -m \"release: desktop v" + newVersion + "\"");
  console.log("  3) git push → Vercel 自動部署 → 用家 APP 內「檢查更新」可拉到新版");
  console.log("========================================\n");
}

main();
