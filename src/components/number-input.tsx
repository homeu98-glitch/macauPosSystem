"use client";
import { useEffect, useRef, useState } from "react";

interface NumberInputProps {
  /** 當前值（number 或 undefined）。外部改變時會 sync 到 input，但只喺冇 focus 時。 */
  value: number | undefined;
  /** blur 時若 parse + 驗證通過就呼叫。非法 / 空值會 revert 到當前 value。 */
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  /** decimal = 帶小數金額；numeric = 整數（quantity / 庫存 / 效期天 等）。 */
  inputMode?: "decimal" | "numeric";
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

/**
 * 金額 / 數量 input —— 解決「onChange 即刻 `Number() || 0` 會食掉小數點」嘅 bug。
 *
 * 行為：
 * - typing 期間 DOM free-form（包含中間狀態如 `1.` / `.` / `19.8`）。
 * - blur 先 parse + 驗證（min/max），合法就 onCommit，非法 / 空就 revert 到當前 value。
 * - 外部 `value` 改變（例如 server push）會 sync，但只喺 input 冇 focus 時先做，避免覆蓋用戶打到一半嘅輸入。
 * - 用 `type="text"` + `inputMode="decimal"` 而唔係 `type="number"`，因為 `type=number`
 *   嘅 `input.value` 會食掉尾隨 `.`，onBlur 攞唔到用戶真正打嘅字串。
 */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  inputMode = "decimal",
  className,
  placeholder,
  ariaLabel,
  title,
  disabled,
}: NumberInputProps) {
  const [text, setText] = useState<string>(() => (value !== undefined ? String(value) : ""));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(value !== undefined ? String(value) : "");
    }
  }, [value]);

  const revert = () => setText(value !== undefined ? String(value) : "");

  return (
    <input
      aria-label={ariaLabel}
      className={className}
      disabled={disabled}
      inputMode={inputMode}
      placeholder={placeholder}
      title={title}
      type="text"
      value={text}
      onBlur={(e) => {
        focusedRef.current = false;
        const raw = e.target.value.trim();
        if (raw === "") {
          revert();
          return;
        }
        const n = Number(raw);
        if (
          Number.isFinite(n) &&
          (min === undefined || n >= min) &&
          (max === undefined || n <= max)
        ) {
          setText(String(n));
          if (n !== value) onCommit(n);
        } else {
          revert();
        }
      }}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
    />
  );
}
