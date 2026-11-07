"use client";

/**
 * 客人自助訂位 H5 —— 單頁四步：選時段 →（可選）預點菜 → 填資料 → 成功／QR。
 * 另附「查訂位」與「我嘅訂位」兩個入口。
 *
 * ## 設計取向
 *
 * 呢頁係由 **Macau-Ledger 會員通**跳過嚟（`/book?storeId=…&from=ledger`），
 * 所以視覺沿用會員通嘅奶油底 + 琥珀主色，唔係 POS 嘅靛藍。
 * 風格寫喺本檔 scoped `<style>`，唔改 `globals.css`，唔影響 POS 其他頁。
 *
 * ## 🔴 三條鐵律
 *
 * 1. **唔信自己計嘅價**。畫面用 `previewNetPrice()` 顯示，同 server
 *    `priceReservationItems()` 共用 `itemNetPrice()`；提交只送
 *    `menuItemId / qty / specs`，金額一律由 server 重算。
 * 2. **唔自己做配額判斷**。`full` / `past` 全部嚟自 `/api/public/reservations/slots`，
 *    提交後 server 仍會用 advisory lock 再驗一次（客人可以放住page幾個鐘先撳）。
 * 3. **客人唔可以自己取消**。全頁冇取消按鈕，只有「致電商家」。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { encodeQrMatrix } from "@/lib/qrcode";
import { previewNetPrice } from "@/lib/pos/reservation/pricing";
import { shiftYmdDays } from "@/lib/pos/reservation/slots";
import { formatBizDate, formatSlotTime } from "@/lib/pos/reservation/labels";

type Phase = "loading" | "error" | "closed" | "choose" | "items" | "info" | "done" | "lookup" | "list";

type PublicSettings = {
  enabled: boolean;
  notice: string;
  leadDaysMax: number;
  leadMinutesMin: number;
  minPartySize: number;
  maxPartySize: number;
  largePartyThreshold: number;
  slotIntervalMinutes: number;
  slotQuota: number;
  turnMinutes: number;
  autoConfirm: boolean;
  cancelCutoffMinutes: number;
};

type Slot = {
  slotAt: string;
  label: string;
  used: number;
  remaining: number;
  full: boolean;
  past: boolean;
};

type MenuItemLite = {
  id: string;
  name: string;
  price: number;
  categoryId?: string;
  memberPrice?: number | null;
  isMarketPrice?: boolean;
  soldOut?: boolean;
  active?: boolean;
  customerOrderable?: boolean;
  description?: string;
};

type PublicReservation = {
  code: string;
  status: string;
  bizDate: string;
  slotAt: string;
  partySize: number;
  guestName: string;
  guestPhoneMasked: string;
  guestNote: string;
  tableName: string | null;
  items: Array<{ name: string; specText: string; qty: number; unitPrice: number; memberPrice: number | null }>;
  itemsSubtotal: number;
  discountAmount: number;
  payableAmount: number;
  paidAmount: number;
};

type StoreInfo = {
  storeName: string;
  currency: string;
  storePhone: string;
  today: string;
  settings: PublicSettings;
  notice: string;
};

const STATUS: Record<string, { text: string; color: string; bg: string }> = {
  pending: { text: "待商家確認", color: "#92400e", bg: "#fef3c7" },
  confirmed: { text: "已確認", color: "#1f7a52", bg: "#d9f2e3" },
  arrived: { text: "已到店", color: "#1d4ed8", bg: "#dbeafe" },
  seated: { text: "已入座", color: "#1d4ed8", bg: "#dbeafe" },
  completed: { text: "已完成", color: "#475569", bg: "#e2e8f0" },
  canceled: { text: "已取消", color: "#991b1b", bg: "#fee2e2" },
  no_show: { text: "未到", color: "#991b1b", bg: "#fee2e2" },
  waitlist: { text: "候補", color: "#92400e", bg: "#fef3c7" },
};

function money(value: number): string {
  return `$${Number(value || 0).toFixed(2)}`;
}

const LAST_BOOK_KEY = "macau-pos/book/last";

type LastBook = { storeId: string; phone: string; code: string };

/**
 * 記低「上次喺呢部機訂過位」嘅店同電話。
 *
 * 會員通訂單列表嘅「訂位記錄」入口唔知客人訂咗邊間店（嗰頁係全店混合），
 * 所以佢跳去 `/book?mode=list` 唔帶 storeId。呢度用本機記錄補返，
 * 同機一撳就自動列出自己張訂位 —— 唔使客人再揀店、再打電話。
 *
 * ⚠️ 只存店 ID / 電話 / 訂位碼，**唔存姓名備註**，亦唔係身份憑證。
 *    真正查單仍然要完整電話打去 server 驗（見 public API）。
 */
function readLastBook(): LastBook | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_BOOK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastBook>;
    return typeof parsed.storeId === "string" && parsed.storeId ? {
      storeId: parsed.storeId,
      phone: typeof parsed.phone === "string" ? parsed.phone : "",
      code: typeof parsed.code === "string" ? parsed.code : "",
    } : null;
  } catch {
    return null;
  }
}

function saveLastBook(data: LastBook): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_BOOK_KEY, JSON.stringify(data));
  } catch {
    /* 私隱模式：靜靜跳過，唔影響訂位 */
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !json) {
    throw new Error(json?.error ?? `請求失敗（${res.status}）`);
  }
  return json;
}

/** 用現成 `encodeQrMatrix()` 出 SVG，同收據 QR 用同一個 encoder。 */
function QrSvg({ text, size = 168 }: { text: string; size?: number }) {
  const matrix = useMemo(() => encodeQrMatrix(text), [text]);
  if (!matrix) return <div className="bk-qrfail">二維碼產生失敗，請記低訂位碼</div>;
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  return (
    <svg
      aria-label="訂位二維碼"
      className="bk-qr"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
    >
      <rect width={total} height={total} fill="#fff" />
      {matrix.modules.map((row, r) =>
        row.map((on, c) =>
          on ? (
            <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width="1" height="1" fill="#1c1917" />
          ) : null,
        ),
      )}
    </svg>
  );
}

export function BookFlow() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [storeId, setStoreId] = useState("");
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [error, setError] = useState("");

  const [date, setDate] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotAt, setSlotAt] = useState("");

  const [menu, setMenu] = useState<MenuItemLite[]>([]);
  const [discountRate, setDiscountRate] = useState<number | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});

  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestNote, setGuestNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [result, setResult] = useState<PublicReservation | null>(null);
  const [lookupCode, setLookupCode] = useState("");
  const [lookupTail, setLookupTail] = useState("");
  const [listPhone, setListPhone] = useState("");
  const [list, setList] = useState<PublicReservation[]>([]);

  // ── 初始化：讀 URL → 設定 → 菜單 ────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(window.location.search);
    const remembered = readLastBook();
    const sid = params.get("storeId")?.trim() || remembered?.storeId || "";
    if (!sid) {
      setError("缺少店鋪識別碼。請由商家頁的「訂位」按鈕進入，或掃描店內 QR。");
      setPhase("error");
      return () => { alive = false; };
    }
    setStoreId(sid);
    const preCode = params.get("code")?.trim() ?? "";
    const mode = params.get("mode");
    setLookupCode(preCode || remembered?.code || "");
    if (remembered?.phone) setListPhone(remembered.phone);

    void (async () => {
      try {
        const info = await getJson<{
          ok: boolean;
          enabled: boolean;
          tableReady: boolean;
          storeName: string;
          currency: string;
          storePhone: string;
          today: string;
          settings: PublicSettings;
        }>(`/api/public/reservations/settings?storeId=${encodeURIComponent(sid)}`);
        if (!alive) return;
        setStore({
          storeName: info.storeName,
          currency: info.currency,
          storePhone: info.storePhone,
          today: info.today,
          settings: info.settings,
          notice: info.settings.notice,
        });
        setDate(info.today);
        setPartySize(Math.max(2, info.settings.minPartySize));
        if (!info.tableReady || !info.enabled) {
          setPhase("closed");
          return;
        }
        setPhase(mode === "lookup" || preCode ? "lookup" : mode === "list" ? "list" : "choose");

        // 由會員通訂單列表「訂位記錄」跳入：唔帶 storeId，但本機有上次電話 → 自動列單
        if (mode === "list" && remembered?.phone) {
          void getJson<{ ok: boolean; reservations: PublicReservation[] }>(
            `/api/public/reservations?storeId=${encodeURIComponent(sid)}&phone=${encodeURIComponent(remembered.phone.replace(/\D/g, ""))}`,
          )
            .then((json) => { if (alive) setList(json.reservations ?? []); })
            .catch(() => { /* 靜默：客人仍可手動搜尋 */ });
        }

        // 菜單：預點菜用。失敗唔擋訂位流程（預點菜係選填）。
        try {
          // 用公開白名單餐牌，唔打 `/api/pos/bootstrap`（嗰支會回 tables / printerGroups）
          const boot = await getJson<{
            menuItems?: MenuItemLite[];
            memberDiscountRate?: number | null;
          }>(`/api/public/reservations/menu?storeId=${encodeURIComponent(sid)}`);
          if (!alive) return;
          const rate = boot.memberDiscountRate;
          setDiscountRate(typeof rate === "number" && rate > 0 && rate < 100 ? rate : null);
          setMenu(boot.menuItems ?? []);
        } catch {
          /* 預點菜選填，靜默降級 */
        }
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "載入失敗");
        setPhase("error");
      }
    })();

    return () => { alive = false; };
  }, []);

  // ── 換日期就重拉時段 ────────────────────────────────────────────────
  useEffect(() => {
    if (!storeId || !date || phase === "loading" || phase === "error" || phase === "closed") return;
    let alive = true;
    setSlotsLoading(true);
    setSlotAt("");
    void getJson<{ ok: boolean; slots: Slot[] }>(
      `/api/public/reservations/slots?storeId=${encodeURIComponent(storeId)}&date=${encodeURIComponent(date)}`,
    )
      .then((json) => {
        if (alive) setSlots(json.slots ?? []);
      })
      .catch(() => {
        if (alive) setSlots([]);
      })
      .finally(() => {
        if (alive) setSlotsLoading(false);
      });
    return () => { alive = false; };
  }, [storeId, date, phase]);

  const dates = useMemo(() => {
    if (!store) return [];
    const n = Math.min(Math.max(1, store.settings.leadDaysMax), 30);
    return Array.from({ length: n }, (_, i) => shiftYmdDays(store.today, i));
  }, [store]);

  const cartLines = useMemo(() => {
    return menu
      .filter((m) => (cart[m.id] ?? 0) > 0)
      .map((m) => {
        const net = previewNetPrice({
          unitPrice: m.price,
          memberPrice: m.memberPrice ?? null,
          discountRate,
        });
        return { item: m, qty: cart[m.id], net, was: m.price > net };
      });
  }, [menu, cart, discountRate]);

  const cartTotal = cartLines.reduce((sum, line) => sum + line.net * line.qty, 0);
  const selectedSlot = slots.find((s) => s.slotAt === slotAt) ?? null;

  const addItem = useCallback((id: string, delta: number) => {
    setCart((current) => {
      const next = Math.max(0, (current[id] ?? 0) + delta);
      const copy = { ...current };
      if (next === 0) delete copy[id];
      else copy[id] = next;
      return copy;
    });
  }, []);

  const submit = useCallback(async () => {
    if (!selectedSlot || !store) return;
    const phone = guestPhone.replace(/[^\d+]/g, "");
    if (!guestName.trim()) { setError("請填寫稱呼。"); return; }
    if (phone.replace(/\D/g, "").length < 6) { setError("請填寫可聯絡的電話號碼。"); return; }
    setError("");
    setSubmitting(true);
    try {
      const json = await getJson<{ ok: boolean; reservation: PublicReservation }>(
        "/api/public/reservations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storeId,
            slotAt: selectedSlot.slotAt,
            partySize,
            guestName: guestName.trim(),
            guestPhone: phone,
            guestNote: guestNote.trim(),
            items: cartLines.map((line) => ({
              menuItemId: line.item.id,
              qty: line.qty,
              specs: {},
              specText: "",
            })),
          }),
        },
      );
      setResult(json.reservation);
      setListPhone(phone);
      saveLastBook({ storeId, phone, code: json.reservation.code });
      setPhase("done");
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失敗，請稍後再試或致電商家。");
    } finally {
      setSubmitting(false);
    }
  }, [selectedSlot, store, guestName, guestPhone, guestNote, storeId, partySize, cartLines]);

  const doLookup = useCallback(async () => {
    if (!lookupCode.trim() || lookupTail.replace(/\D/g, "").length !== 4) {
      setError("請輸入訂位碼及電話尾 4 位。");
      return;
    }
    setError("");
    try {
      const json = await getJson<{ ok: boolean; reservation: PublicReservation }>(
        `/api/public/reservations/${encodeURIComponent(lookupCode.trim().toUpperCase())}?storeId=${encodeURIComponent(storeId)}&tail=${lookupTail.replace(/\D/g, "").slice(-4)}`,
      );
      setResult(json.reservation);
      setPhase("done");
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "查不到這張訂位。");
    }
  }, [lookupCode, lookupTail, storeId]);

  const doList = useCallback(async () => {
    const digits = listPhone.replace(/\D/g, "");
    if (digits.length < 6) { setError("請輸入完整聯絡電話。"); return; }
    setError("");
    try {
      const json = await getJson<{ ok: boolean; reservations: PublicReservation[] }>(
        `/api/public/reservations?storeId=${encodeURIComponent(storeId)}&phone=${encodeURIComponent(digits)}`,
      );
      setList(json.reservations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取失敗。");
    }
  }, [listPhone, storeId]);

  const telHref = store?.storePhone ? `tel:${store.storePhone.replace(/[^\d+]/g, "")}` : null;
  const qrText =
    result && typeof window !== "undefined"
      ? `${window.location.origin}/book?storeId=${encodeURIComponent(storeId)}&mode=lookup&code=${encodeURIComponent(result.code)}`
      : "";

  return (
    <div className="bk-root">
      <style>{CSS}</style>
      <div className="bk-shell">
        <header className="bk-head">
          <div className="bk-brand">訂位 · Reservation</div>
          <h1 className="bk-title">{store?.storeName || "訂位"}</h1>
          <p className="bk-sub">揀好時間同人數，幾步就訂好位。</p>
        </header>

        {error ? <div className="bk-err">{error}</div> : null}

        {phase === "loading" ? <div className="bk-center">載入中…</div> : null}
        {phase === "error" ? <div className="bk-center">{error}</div> : null}
        {phase === "closed" ? (
          <div className="bk-card bk-center">
            <div className="bk-big">本店暫未開放網上訂位</div>
            <p className="bk-muted">歡迎致電查詢。</p>
            {telHref ? <a className="bk-btn" href={telHref}>致電商家</a> : null}
          </div>
        ) : null}

        {/* ── ① 選日期 / 人數 / 時段 ── */}
        {phase === "choose" && store ? (
          <>
            <div className="bk-card">
              <div className="bk-label">揀日期</div>
              <div className="bk-scroll">
                {dates.map((d) => (
                  <button
                    key={d}
                    className={`bk-date ${d === date ? "on" : ""}`}
                    onClick={() => setDate(d)}
                    type="button"
                  >
                    <b>{d.slice(5).replace("-", "/")}</b>
                    <span>{d === store.today ? "今天" : formatBizDate(d).replace(/^\d+年/, "")}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="bk-card">
              <div className="bk-label">幾多位</div>
              <div className="bk-stepper">
                <button
                  className="bk-sq"
                  disabled={partySize <= store.settings.minPartySize}
                  onClick={() => setPartySize((n) => Math.max(store.settings.minPartySize, n - 1))}
                  type="button"
                >−</button>
                <div className="bk-stepval">{partySize} <small>位</small></div>
                <button
                  className="bk-sq"
                  disabled={partySize >= store.settings.maxPartySize}
                  onClick={() => setPartySize((n) => Math.min(store.settings.maxPartySize, n + 1))}
                  type="button"
                >＋</button>
              </div>
              {partySize >= store.settings.largePartyThreshold ? (
                <div className="bk-tip">大枱訂位需要商家確認，提交後會顯示「待商家確認」。</div>
              ) : null}
            </div>

            <div className="bk-card">
              <div className="bk-rowbt">
                <div className="bk-label">揀時間</div>
                <span className="bk-muted">{slotsLoading ? "更新中…" : `每時段 ${store.settings.slotQuota} 組`}</span>
              </div>
              {slotsLoading ? (
                <div className="bk-center bk-small">讀取時段中…</div>
              ) : slots.length === 0 ? (
                <div className="bk-empty">呢日暫無可訂時段，請揀第二日。</div>
              ) : (
                <div className="bk-grid">
                  {slots.map((s) => {
                    const off = s.full || s.past;
                    return (
                      <button
                        key={s.slotAt}
                        className={`bk-slot ${s.slotAt === slotAt ? "on" : ""} ${off ? "off" : ""}`}
                        disabled={off}
                        onClick={() => setSlotAt(s.slotAt)}
                        type="button"
                      >
                        <b>{s.label}</b>
                        <span>{s.full ? "已滿" : s.past ? "已過" : `餘 ${s.remaining} 組`}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="bk-tip">用餐時間約 {store.settings.turnMinutes} 分鐘，請準時到店。</div>
            </div>

            {store.notice ? <div className="bk-notice"><b>訂位須知</b><br />{store.notice}</div> : null}
          </>
        ) : null}

        {/* ── ② 預點菜（選填）── */}
        {phase === "items" && store ? (
          <div className="bk-card">
            <div className="bk-rowbt">
              <div className="bk-label">想唔想先點定菜？（可選）</div>
              <button className="bk-link" onClick={() => setCart({})} type="button">清空</button>
            </div>
            <div className="bk-tip">
              {formatBizDate(date)} {selectedSlot?.label ?? formatSlotTime(slotAt)} · {partySize} 位。
              金額只作參考，以到店當日菜牌為準。
            </div>
            {menu.length === 0 ? (
              <div className="bk-empty">餐牌暫未提供，可以直接跳過，到店先點。</div>
            ) : (
              <div className="bk-dishes">
                {menu.slice(0, 40).map((m) => {
                  const net = previewNetPrice({ unitPrice: m.price, memberPrice: m.memberPrice ?? null, discountRate });
                  const qty = cart[m.id] ?? 0;
                  return (
                    <div className="bk-dish" key={m.id}>
                      <div className="bk-thumb">{m.name.slice(0, 1)}</div>
                      <div className="bk-dishin">
                        <b>{m.name}</b>
                        <div className="bk-price">
                          <span className="bk-now">${net.toFixed(2)}</span>
                          {net < m.price ? <span className="bk-was">${m.price.toFixed(2)}</span> : null}
                          {net < m.price ? <span className="bk-vip">會員價</span> : null}
                        </div>
                      </div>
                      {qty === 0 ? (
                        <button className="bk-add" onClick={() => addItem(m.id, 1)} type="button">＋</button>
                      ) : (
                        <div className="bk-qty">
                          <button className="bk-sq sm" onClick={() => addItem(m.id, -1)} type="button">−</button>
                          <b>{qty}</b>
                          <button className="bk-sq sm" onClick={() => addItem(m.id, 1)} type="button">＋</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="bk-total">
              <span>已選 {cartLines.reduce((n, l) => n + l.qty, 0)} 道 · 參考金額</span>
              <b>{money(cartTotal)}</b>
            </div>
          </div>
        ) : null}

        {/* ── ③ 填資料 ── */}
        {phase === "info" && store ? (
          <>
            <div className="bk-card">
              <div className="bk-label">訂位資料</div>
              <div className="bk-frow"><span>日期時間</span><b>{formatBizDate(date)} {selectedSlot?.label}</b></div>
              <div className="bk-frow"><span>人數</span><b>{partySize} 位</b></div>
              {cartLines.length > 0 ? (
                <div className="bk-frow"><span>預點菜</span><b>{cartLines.length} 道 · {money(cartTotal)}</b></div>
              ) : null}
              <label className="bk-fld">
                <span>稱呼 *</span>
                <input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="例如 陳先生" />
              </label>
              <label className="bk-fld">
                <span>聯絡電話 *</span>
                <input
                  value={guestPhone}
                  onChange={(e) => setGuestPhone(e.target.value)}
                  inputMode="tel"
                  placeholder="6612 3456"
                />
              </label>
              <label className="bk-fld">
                <span>備註／忌口</span>
                <textarea
                  value={guestNote}
                  onChange={(e) => setGuestNote(e.target.value)}
                  placeholder="例如：有小朋友、需要安靜位"
                />
              </label>
            </div>
            <div className="bk-notice warn">
              提交後商家會確認。如需取消或更改人數，請直接致電商家
              {telHref ? <a href={telHref}> {store.storePhone}</a> : null}。
              本頁不設自行取消。
            </div>
          </>
        ) : null}

        {/* ── ④ 成功 / 查單結果 ── */}
        {phase === "done" && result && store ? (
          <>
            <div className="bk-card bk-done">
              <div className="bk-ok">✓</div>
              <div className="bk-big">{result.status === "pending" ? "已收到你的訂位" : "訂位資料"}</div>
              <div className="bk-muted">{result.status === "pending" ? "商家確認後會更新狀態" : ""}</div>
              <div className="bk-qrbox">
                {qrText ? <QrSvg text={qrText} /> : null}
                <div className="bk-code">
                  <small>訂位碼 RESERVATION CODE</small>
                  <b>{result.code}</b>
                  <span>到店請出示此碼，店員掃一下即可核對</span>
                </div>
              </div>
              <span
                className="bk-pill"
                style={{ color: STATUS[result.status]?.color, background: STATUS[result.status]?.bg }}
              >
                {STATUS[result.status]?.text ?? result.status}
              </span>
              <div className="bk-sum">
                <div><span>日期時間</span><b>{formatBizDate(result.bizDate)} {formatSlotTime(result.slotAt)}</b></div>
                <div><span>人數</span><b>{result.partySize} 位</b></div>
                <div><span>客人</span><b>{result.guestName} · {result.guestPhoneMasked}</b></div>
                {result.tableName ? <div><span>枱位</span><b>{result.tableName}</b></div> : null}
                {result.items.length > 0 ? (
                  <div><span>預點菜</span><b>{result.items.length} 道 · {money(result.payableAmount)}</b></div>
                ) : null}
              </div>
              {result.items.length > 0 ? (
                <div className="bk-items">
                  {result.items.map((it, i) => (
                    <div key={i}>{it.name}{it.specText ? `（${it.specText}）` : ""} × {it.qty}</div>
                  ))}
                  <small>金額為訂位時參考價，以到店當日菜牌為準</small>
                </div>
              ) : null}
            </div>
            <div className="bk-notice warn">
              如需取消或更改人數，請致電商家{telHref ? <a href={telHref}> {store.storePhone}</a> : null}。
              本訂位不設手機自行取消。
            </div>
          </>
        ) : null}

        {/* ── 查單 ── */}
        {phase === "lookup" && store ? (
          <div className="bk-card">
            <div className="bk-label">查返張訂位</div>
            <p className="bk-muted">輸入訂位碼同落單時填嘅電話尾 4 位。</p>
            <label className="bk-fld"><span>訂位碼</span>
              <input value={lookupCode} onChange={(e) => setLookupCode(e.target.value.toUpperCase())} placeholder="R1106-018" />
            </label>
            <label className="bk-fld"><span>電話尾 4 位</span>
              <input value={lookupTail} onChange={(e) => setLookupTail(e.target.value)} inputMode="numeric" maxLength={4} placeholder="3456" />
            </label>
            <button className="bk-btn wide" onClick={() => void doLookup()} type="button">查訂位</button>
          </div>
        ) : null}

        {/* ── 我嘅訂位 ── */}
        {phase === "list" && store ? (
          <>
            <div className="bk-card">
              <div className="bk-label">我嘅訂位</div>
              <p className="bk-muted">輸入完整聯絡電話，列出呢間店嘅訂位記錄。</p>
              <label className="bk-fld"><span>聯絡電話</span>
                <input value={listPhone} onChange={(e) => setListPhone(e.target.value)} inputMode="tel" placeholder="6612 3456" />
              </label>
              <button className="bk-btn wide" onClick={() => void doList()} type="button">搜尋</button>
            </div>
            {list.length === 0 ? (
              <div className="bk-empty">未有訂位記錄。</div>
            ) : (
              list.map((r) => (
                <button
                  className="bk-card bk-listcard"
                  key={r.code}
                  onClick={() => { setResult(r); setPhase("done"); window.scrollTo({ top: 0 }); }}
                  type="button"
                >
                  <div className="bk-rowbt">
                    <b>{formatBizDate(r.bizDate)} · {formatSlotTime(r.slotAt)}</b>
                    <span className="bk-pill" style={{ color: STATUS[r.status]?.color, background: STATUS[r.status]?.bg }}>
                      {STATUS[r.status]?.text ?? r.status}
                    </span>
                  </div>
                  <div className="bk-muted">{r.partySize} 位 · {r.guestName} · 訂位碼 {r.code}</div>
                  {r.items.length > 0 ? <div className="bk-muted">預點 {r.items.length} 道 · {money(r.payableAmount)}</div> : null}
                </button>
              ))
            )}
          </>
        ) : null}

        {/* ── 底部動作條 ── */}
        <div className="bk-foot">
          {phase === "choose" && store ? (
            <button
              className="bk-btn"
              disabled={!slotAt}
              onClick={() => { setPhase("items"); window.scrollTo({ top: 0 }); }}
              type="button"
            >
              下一步：預點菜（可選）
            </button>
          ) : null}
          {phase === "items" && store ? (
            <div className="bk-footrow">
              <button className="bk-btn ghost" onClick={() => setPhase("choose")} type="button">返回</button>
              <button className="bk-btn" onClick={() => { setPhase("info"); window.scrollTo({ top: 0 }); }} type="button">
                下一步：填資料
              </button>
            </div>
          ) : null}
          {phase === "info" && store ? (
            <div className="bk-footrow">
              <button className="bk-btn ghost" onClick={() => setPhase("items")} type="button">返回</button>
              <button className="bk-btn" disabled={submitting} onClick={() => void submit()} type="button">
                {submitting ? "提交中…" : "提交訂位"}
              </button>
            </div>
          ) : null}
          {phase === "done" && store ? (
            <div className="bk-footrow">
              {telHref ? <a className="bk-btn ghost" href={telHref}>致電商家</a> : <span />}
              <button className="bk-btn" onClick={() => { setPhase("list"); setList([]); setError(""); }} type="button">
                我嘅訂位
              </button>
            </div>
          ) : null}
          {phase === "lookup" || phase === "list" ? (
            <button
              className="bk-btn ghost wide"
              onClick={() => { setPhase("choose"); setError(""); window.scrollTo({ top: 0 }); }}
              type="button"
            >
              返回訂位
            </button>
          ) : null}
          {phase !== "loading" && phase !== "error" && phase !== "closed" ? (
            <div className="bk-nav">
              <button onClick={() => { setPhase("lookup"); setError(""); }} type="button">查訂位</button>
              <span>·</span>
              <button onClick={() => { setPhase("list"); setError(""); }} type="button">我嘅訂位</button>
              {telHref ? <><span>·</span><a href={telHref}>致電商家</a></> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const CSS = `
.bk-root{min-height:100dvh;background:#f7f2e8;color:#2b2318;font-family:-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
.bk-shell{max-width:430px;margin:0 auto;padding:0 14px 132px}
.bk-head{padding:22px 4px 14px}
.bk-brand{font-size:11px;font-weight:800;letter-spacing:.12em;color:#b4741a;text-transform:uppercase}
.bk-title{font-size:25px;font-weight:800;margin:6px 0 3px;letter-spacing:.02em}
.bk-sub{font-size:12.5px;color:#8a7c66;margin:0}
.bk-card{background:#fff;border:1px solid #ece2d0;border-radius:18px;padding:15px;margin-bottom:12px;box-shadow:0 6px 18px -16px rgba(90,45,10,.5)}
.bk-label{font-size:13.5px;font-weight:800;margin-bottom:10px}
.bk-muted{font-size:11.5px;color:#8a7c66;margin:3px 0 0;line-height:1.6}
.bk-rowbt{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bk-rowbt .bk-label{margin-bottom:0}
.bk-scroll{display:flex;gap:7px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch}
.bk-date{flex:0 0 62px;min-height:58px;border:1px solid #eadfc9;border-radius:13px;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer}
.bk-date b{font-size:14px;font-weight:800}
.bk-date span{font-size:9.5px;color:#8a7c66;white-space:nowrap}
.bk-date.on{background:linear-gradient(140deg,#f3a33c,#d97706);border-color:#d97706;color:#fff}
.bk-date.on span{color:#fff5e6}
.bk-stepper{display:flex;align-items:center;justify-content:center;gap:20px}
.bk-sq{width:46px;height:46px;border-radius:14px;border:1px solid #eadfc9;background:#fff;font-size:22px;font-weight:700;color:#b4741a;display:grid;place-items:center;cursor:pointer}
.bk-sq:disabled{opacity:.35;cursor:not-allowed}
.bk-sq.sm{width:32px;height:32px;border-radius:10px;font-size:17px}
.bk-stepval{font-size:30px;font-weight:800;min-width:82px;text-align:center}
.bk-stepval small{font-size:13px;font-weight:600;color:#8a7c66}
.bk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:11px}
.bk-slot{min-height:56px;border:1px solid #eadfc9;border-radius:13px;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer}
.bk-slot b{font-size:14.5px;font-weight:800}
.bk-slot span{font-size:10px;color:#8a7c66}
.bk-slot.on{background:#fff4e2;border-color:#d97706;box-shadow:inset 0 0 0 1px #d97706}
.bk-slot.on b{color:#b45309}
.bk-slot.off{background:#f6f4ef;opacity:.6;cursor:not-allowed}
.bk-slot.off b{text-decoration:line-through;color:#a8a29e}
.bk-tip{font-size:11px;color:#8a7c66;line-height:1.65;background:#fbf6ec;border-radius:10px;padding:9px 11px;margin-top:11px}
.bk-notice{font-size:11.5px;color:#6b5b42;line-height:1.7;background:#fff9ec;border:1px solid #f0e0bd;border-radius:14px;padding:12px 14px;margin-bottom:12px;white-space:pre-wrap}
.bk-notice.warn{background:#fff7ed;border-color:#fed7aa;color:#9a3412}
.bk-notice a,.bk-nav a{color:#b45309;font-weight:800;text-decoration:none}
.bk-err{background:#fee2e2;color:#991b1b;border-radius:12px;padding:10px 13px;font-size:12px;margin-bottom:12px}
.bk-center{text-align:center;padding:40px 12px;color:#8a7c66;font-size:13px}
.bk-center.bk-small{padding:18px 0;font-size:11.5px}
.bk-big{font-size:16px;font-weight:800;line-height:1.5}
.bk-empty{text-align:center;padding:22px 8px;font-size:12px;color:#a8a29e}
.bk-dishes{margin-top:10px}
.bk-dish{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px dashed #f0e8d8}
.bk-thumb{flex:0 0 46px;height:46px;border-radius:12px;background:linear-gradient(140deg,#f4c77d,#b4741a);color:#fff;display:grid;place-items:center;font-size:19px;font-weight:800}
.bk-dishin{flex:1;min-width:0}
.bk-dishin b{font-size:13px;font-weight:700;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bk-price{display:flex;align-items:baseline;gap:6px;margin-top:4px;flex-wrap:wrap}
.bk-now{font-size:13.5px;font-weight:800;color:#b45309}
.bk-was{font-size:10.5px;color:#a8a29e;text-decoration:line-through}
.bk-vip{font-size:9px;font-weight:800;color:#1f7a52;background:#d9f2e3;border-radius:5px;padding:1px 4px}
.bk-add{width:36px;height:36px;border-radius:12px;border:0;background:#d97706;color:#fff;font-size:20px;display:grid;place-items:center;cursor:pointer;flex:0 0 auto}
.bk-qty{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.bk-qty b{font-size:13px;min-width:14px;text-align:center}
.bk-total{display:flex;justify-content:space-between;align-items:baseline;margin-top:12px;padding-top:11px;border-top:1px dashed #e8ddc7;font-size:12px;color:#6b5b42}
.bk-total b{font-size:18px;color:#b45309}
.bk-frow{display:flex;justify-content:space-between;padding:7px 0;font-size:12.5px;border-bottom:1px dashed #f2eadb}
.bk-frow span{color:#8a7c66}
.bk-fld{display:block;margin-top:11px}
.bk-fld span{display:block;font-size:11.5px;font-weight:700;color:#6b5b42;margin-bottom:5px}
.bk-fld input,.bk-fld textarea{width:100%;min-height:46px;border:1px solid #e6dac2;border-radius:12px;padding:10px 12px;font-size:14px;background:#fffdf8;color:#2b2318;box-sizing:border-box;font-family:inherit}
.bk-fld textarea{min-height:70px;resize:vertical}
.bk-fld input:focus,.bk-fld textarea:focus{outline:2px solid #f0b45c;outline-offset:1px}
.bk-link{background:none;border:0;color:#b45309;font-size:11.5px;font-weight:800;cursor:pointer}
.bk-done{text-align:center}
.bk-ok{width:48px;height:48px;border-radius:50%;background:#d9f2e3;color:#1f7a52;font-size:24px;display:grid;place-items:center;margin:0 auto 8px}
.bk-qrbox{display:flex;align-items:center;gap:13px;text-align:left;background:#fffdf8;border:1px dashed #e6dac2;border-radius:14px;padding:12px;margin:14px 0 10px}
.bk-qr{flex:0 0 auto;border:5px solid #fff;border-radius:8px}
.bk-qrfail{font-size:11px;color:#991b1b}
.bk-code{min-width:0}
.bk-code small{display:block;font-size:9px;letter-spacing:.08em;color:#8a7c66;font-weight:800}
.bk-code b{display:block;font-size:19px;letter-spacing:.06em;margin:3px 0 6px;color:#2b2318}
.bk-code span{display:block;font-size:10px;color:#8a7c66;line-height:1.6}
.bk-pill{display:inline-block;font-size:10.5px;font-weight:800;border-radius:20px;padding:4px 10px}
.bk-sum{text-align:left;margin-top:12px;border-top:1px dashed #e8ddc7}
.bk-sum div{display:flex;justify-content:space-between;gap:10px;padding:7px 0;font-size:12px;border-bottom:1px dashed #f2eadb}
.bk-sum span{color:#8a7c66;flex:0 0 auto}
.bk-sum b{font-weight:700;text-align:right}
.bk-items{text-align:left;font-size:11.5px;color:#6b5b42;line-height:1.8;margin-top:10px}
.bk-items small{display:block;font-size:10px;color:#a8a29e;margin-top:4px}
.bk-listcard{display:block;width:100%;text-align:left;cursor:pointer;font-family:inherit}
.bk-foot{position:fixed;bottom:0;left:0;right:0;background:rgba(255,253,248,.97);border-top:1px solid #ece2d0;padding:11px 14px 14px;backdrop-filter:blur(8px)}
.bk-foot>*{max-width:402px;margin-left:auto;margin-right:auto}
.bk-footrow{display:flex;gap:9px}
.bk-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;width:100%;border:0;border-radius:14px;background:linear-gradient(140deg,#f3a33c,#d97706);color:#fff;font-size:14px;font-weight:800;text-decoration:none;cursor:pointer;font-family:inherit}
.bk-btn:disabled{opacity:.45;cursor:not-allowed}
.bk-btn.ghost{background:#fff;color:#8a5a12;border:1px solid #e6dac2}
.bk-btn.wide{margin-top:12px}
.bk-nav{display:flex;justify-content:center;gap:10px;margin-top:10px;font-size:11px;color:#a8a29e}
.bk-nav button{background:none;border:0;color:#b45309;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;padding:0}
.bk-nav a{font-size:11px}
@media (max-width:360px){.bk-grid{grid-template-columns:repeat(2,1fr)}.bk-qr{width:130px;height:130px}}
`;
