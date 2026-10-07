// 等 dev server 就緒（唔用固定 sleep）
const BASE = "http://localhost:3017";
let ok = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(BASE + "/login");
    if (r.ok) { ok = true; console.log("ready after", i * 2, "s"); break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
}
if (!ok) { console.log("TIMEOUT"); process.exit(1); }