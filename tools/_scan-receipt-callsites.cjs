const fs = require("fs");
const path = require("path");
function walk(d, acc) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
const files = walk("src", []).filter((f) => /\.(ts|tsx)$/.test(f));
const pat = /once:\s*true|printReceiptForPosOrder\(|printReceiptForLedgerOrder\(|ensureKitchenPrintForLedgerOrderOnce\(|printKitchenForLedgerOrder\(|buildReceiptPrintJobs\(/;
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (pat.test(l) && !/^\s*\*/.test(l) && !l.trim().startsWith("//")) {
      console.log(`${f}:${i + 1}  ${l.trim().slice(0, 170)}`);
    }
  });
}
