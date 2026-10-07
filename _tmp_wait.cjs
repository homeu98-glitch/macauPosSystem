/* 臨時：等 dev server 起好（唔用固定 sleep） */
const BASE = "http://localhost:3017";
(async () => {
  for (let i = 0; i < 45; i++) {
    try {
      const r = await fetch(BASE + "/login");
      if (r.ok) { console.log("ready after", i * 2, "s"); return; }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("TIMEOUT");
  process.exit(1);
})();
