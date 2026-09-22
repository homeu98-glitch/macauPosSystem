# Admin「強制關閉」後工作階段卡在列表（2026-09-22 21:15）

> 商家：「第二條，我強制關掉後，一直都是卡在那邊。」
> 畫面：`/admin/sessions` → 表嫂美食 → 第 2 行 `已強制關閉`（Windows · 182.93.6.133）＋ 操作欄只剩一個灰色「已下達」。

---

## 1 根因：**後端准清、前端冇入口**

`session-record.ts` 嘅判準本身係對嘅：

```ts
export function canClearPosSession(row, nowMs): boolean {
  const state = classifyPosSession(row, nowMs);   // rev 狀態：只要 revoked_at 有值就係 "rev"
  return state === "off" || state === "rev";      // ⇒ 已強制關閉**准清**
}
```

但 `admin/sessions/page.tsx` 嘅**列表行**寫成咁（修改前）：

```tsx
{state === "rev" ? (
  <span>已下達</span>            // ← 只有一個 badge，冇任何掣
) : canClear ? (
  <button onClick={onClear}>清除</button>
) : (
  <button onClick={onRevoke}>強制關閉</button>
)}
```

`classifyPosSession()` 只有要 `revoked_at` 有值就**永遠**回 `"rev"` ⇒
**所有已強制關閉嘅行永遠行第一條分支** ⇒ 「清除」掣永遠唔會出現。
詳情 drawer 亦一樣（只出「已下達強制關閉，等該分頁下次連線確認」，冇清除）。

⇒ **被軟踢（soft kick）嘅工作階段可以永遠停留喺列表**，商家無從收拾。

### 附帶：KPI「已下達待生效」都會永遠卡住

```ts
// 修改前
revokedPending: rows.filter((r) => Boolean(r.revoked_at) && classifyPosSession(r, nowMs) === "rev").length,
```

同理 ⇒ 只要有**任何一個歷史 revoke 紀錄**，呢個 KPI 就永遠 ≥ 1，
睇落好似「下達咗但一直未生效」。呢個正正就係「卡住」嘅觀感來源之一。

### 仲有一層（設計取捨，唔係 bug）
「管理操作紀錄」係**由已撤銷嘅 row 反推**（`auditRows`，冇另開 audit 表），
所以呢啲 row **刻意長期保留**（頁面亦寫「只保留最近 30 日 · 唔可以刪除」）。
⇒ 「佢一直喺度」本身係有意嘅審計保留；問題係**冇俾管理員收拾／區分「已完結」**。

---

## 2 已修（4 處，全部前端，零額外請求）

| # | 檔案 | 改動 |
|---|---|---|
| 1 | `admin/sessions/page.tsx`（列表行） | `state === "rev"` 分支改為「已下達 badge **＋** 清除掣」（`canClear` 時） |
| 2 | `admin/sessions/page.tsx`（detail drawer） | 新增「清除紀錄」掣（drawer 加 `onClear` prop，呼叫點 `submitAction("clear", [id])`） |
| 3 | `lib/pos/session-record.ts` | 🆕 `isRevokePending(row, nowMs)`：**「已下達但未確認生效」**新口徑，`revokedPending` 改用它 |
| 4 | `lib/pos/session-record.test.ts` | 新增 8 條測試（含 admin 頁原始碼契約：rev 行一定要有清除入口） |

### 新口徑（`isRevokePending`）

| 情況 | 算唔算「待生效」 | 理由 |
|---|---|---|
| 下達**之後**仲有上報（`last_seen_at > revoked_at`） | ❌ | 該分頁已連過線 ⇒ 一定收到軟踢 header |
| 下達之後冇上報，但**仍在離線門檻內**（≤ 30 分） | ✅ | 可能只係未到下一個輪詢週期（輪詢閘上限 5 分鐘） |
| 下達之後一直冇上報、**已過離線門檻** | ❌ | 部機根本唔喺度 ⇒ 屬「可清除」，唔係「等生效」 |

⇒ KPI 會自然歸零，唔會再長期卡住。

### 清除掣嘅文案（避免誤解）
`title="移除紀錄（該分頁若仍然開住，下次連線會重新建立一個新工作階段）"`

🔴 **刻意唔做自動清除**：刪咗 revoked row ＝ 該 `session_key` 嘅撤銷狀態一齊消失 ⇒
一個仲開住嘅舊分頁會「復活」繼續輪詢（＝今次 egress 事故嘅成因）。
所以清除一定要**人手、明確**（同 `canClearPosSession()` 原本嘅設計一致）。

---

## 3 即時操作（商家）

1. 部署新版之後，`/admin/sessions` → 撳「重新載入」。
2. 嗰一行（Windows · 182.93.6.133）而家會見到 **已下達 ＋ 清除** → 撳「清除」即走。
3. KPI「已下達待生效」亦應該變 **0**（該行下達已超過離線門檻）。
4. 若果仲想留紀錄：唔撳都可以，佢只係歷史；不過「已離線」嘅行本身都有「清除」掣。

---

## 4 驗證

```
tsc --noEmit        → 0 error
eslint（改動檔）      → clean
node --test         → 1211 pass / 0 fail
```
