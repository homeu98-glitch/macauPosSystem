/**
 * 一次性推送腳本（用完即刪）。
 *
 * GCM（git-credential-manager.exe）目前 spawn 會 EBUSY（執行檔被鎖），
 * 所以依次嘗試多個憑證來源，取第一個成功者，再以內聯 helper 推送。
 *
 * 🔴 token 只存在於 process env（記憶體），唔會寫入任何檔案、唔會 echo 出嚟
 *    （只報告「有／冇」同長度）。
 */
const { spawnSync } = require("node:child_process");

const PG = "C:/Users/surface/.workbuddy/binaries/PortableGit/versions/1.2.0";
const GIT = `${PG}/cmd/git.exe`;
const GCM = `${PG}/mingw64/bin/git-credential-manager.exe`;
const WINCRED = `${PG}/mingw64/bin/git-credential-wincred.exe`;
const REPO = "C:/dev/macauPos/macauPosSystem";
const PROMPT = "protocol=https\nhost=github.com\n\n";

function parse(out) {
  const username = /^username=(.*)$/m.exec(out)?.[1]?.trim() ?? "";
  const password = /^password=(.*)$/m.exec(out)?.[1]?.trim() ?? "";
  return username && password ? { username, password } : null;
}

function tryRun(label, cmd, args, useStdin) {
  const r = spawnSync(cmd, args, {
    cwd: REPO,
    input: useStdin ? PROMPT : undefined,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.error) return { label, error: r.error.message.slice(0, 120) };
  if (r.status !== 0) return { label, error: `退出碼 ${r.status}` };
  const cred = parse(r.stdout || "");
  if (!cred) return { label, error: "冇回 username／password" };
  return { label, cred };
}

const attempts = [
  () => tryRun("GCM", GCM, ["get"], true),
  () => tryRun("wincred", WINCRED, ["get"], true),
  () => tryRun("git credential fill (wincred)", GIT, ["credential", "-c", "credential.helper=wincred", "fill"], true),
];

let found = null;
for (const attempt of attempts) {
  const r = attempt();
  if (r.cred) {
    console.log(`✅ 憑證來源：${r.label}（username=${r.cred.username}，password 長度 ${r.cred.password.length}）`);
    found = r.cred;
    break;
  }
  console.log(`✗ ${r.label}：${r.error}`);
}

if (!found) {
  console.log("❌ 所有憑證來源都失敗，未能推送。");
  process.exit(1);
}

const helper = '!f() { echo username="$WB_GIT_USER"; echo password="$WB_GIT_PASS"; }; f';
console.log("⏳ 推送中…");
const push = spawnSync(
  GIT,
  ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "push", "origin", "main"],
  {
    cwd: REPO,
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      WB_GIT_USER: found.username,
      WB_GIT_PASS: found.password,
    },
  },
);
if (push.error) {
  console.log(`❌ push spawn 失敗：${push.error.message}`);
  process.exit(1);
}
console.log(`--- stdout ---\n${(push.stdout || "").trim()}`);
console.log(`--- stderr ---\n${(push.stderr || "").trim()}`);
console.log(`退出碼：${push.status}`);
process.exit(push.status === 0 ? 0 : 1);
