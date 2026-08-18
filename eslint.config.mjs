import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // 離線優先架構：以下 react-hooks 規則會誤報本專案嘅有效用法，故關閉。
  // - set-state-in-effect：localStorage / 外部儲存初始化喺 mount effect 內 setState 屬正常用法（SSR 安全，且只跑一次）。
  // - purity：套票到期、即將到期清單等需 Date.now() 做到期判斷，屬預期 impurity。
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
    },
  },
]);

export default eslintConfig;
