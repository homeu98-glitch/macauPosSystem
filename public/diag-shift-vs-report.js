// 交班 vs 報表「合計對唔上」診斷（唯讀，唔會改任何資料）
//
// 用法 A（免複製、免貼上，最適合觸控裝置）：
//   POS 機開 POS 頁 → F12 / DevTools → Console → 直接打：
//       import("/diag-shift-vs-report.js")
//   再 Enter。（打完要按 Enter；呢句只係「載入並執行」本檔。）
//
// 用法 B：將本檔（或 tools/diag-shift-vs-report.console.js 嘅最後一行）整段複製貼入 Console。
//
// 輸出：① 交班口徑（線下 settled）張數/Σ/支付方式拆 ② 交班會漏（線下 paid 未 settled）
//      ③ 報表會計入（帶 onlineOrderId 且 settled/paid） ④ 退款單 ⑤ 今日逐張本地單表
// 之後 reload 報表頁一次，console 會多印一行 [report] get_merchant_report_summary 原始 avos payload。
//
// 用完可以刪；本檔唔含任何寫入動作。
(()=>{const D=new Date(Date.now()+48e4+new Date().getTimezoneOffset()*6e4).toISOString().slice(0,10),a=Date.parse(D+"T00:00:00+08:00"),b=a+864e5-1,K=Object.keys(localStorage).filter(k=>k==="macau-pos/orders"||/\/orders$/.test(k));if(!K.length){console.warn("搵唔到 orders key，localStorage 全部 key：",Object.keys(localStorage));return}console.log("Macau 當日 =",D,"｜orders keys =",K);for(const k of K){let A=[];try{A=JSON.parse(localStorage.getItem(k)||"[]")}catch(e){console.error(k,"解析失敗",e);continue}if(!Array.isArray(A)){console.warn(k,"唔係陣列，跳過");continue}const t=o=>o.originalSettledAt||o.updatedAt||o.createdAt||"",inD=A.filter(o=>{const x=Date.parse(t(o));return Number.isFinite(x)&&x>=a&&x<=b}),offS=inD.filter(o=>!o.onlineOrderId&&o.status==="settled"),offP=inD.filter(o=>!o.onlineOrderId&&o.status==="paid"),onl=inD.filter(o=>o.onlineOrderId&&(o.status==="settled"||o.status==="paid")),ref=inD.filter(o=>!o.onlineOrderId&&/refund/.test(o.status)),s=z=>Math.round(z.reduce((q,o)=>q+(+o.total||0),0)*100)/100,mix={};offS.forEach(o=>{const m=o.paymentMethod||"未記錄";mix[m]=Math.round(((mix[m]||0)+(+o.total||0))*100)/100});console.log("=== "+k+" === 當日單數 "+inD.length+"（本機總單數 "+A.length+"）");console.log("①【交班口徑】線下 settled（無 onlineOrderId）:",offS.length,"張, Σ 實收 =",s(offS),mix);console.log("②【交班會漏】線下 paid 未 settled（快餐已收未完成）:",offP.length,"張, Σ =",s(offP));console.log("③【帶 onlineOrderId 嘅本地單】(交班兩邊都唔計；報表金額已改用 RPC，只列明細):",onl.length,"張, Σ =",s(onl));console.log("④【退款單】（交班照計全額、報表排除）:",ref.length,"張, Σ =",s(ref));console.table(inD.map(o=>({no:o.localOrderNo,status:o.status,method:o.paymentMethod||"",table:o.tableName||o.tableId||"",total:o.total,prepaid:o.prepaidAmount||0,refunded:o.refundedAmount||0,online:o.onlineOrderId?"Y":"",ts:t(o)})))}console.log("下一步：reload 報表頁一次 → console 會多一行 [report] get_merchant_report_summary 原始 avos payload → 睇 order_count / order_paid_avos / order_balance_paid_avos / order_in_store_paid_avos")})()
