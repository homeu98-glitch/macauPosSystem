import fs from 'fs';
const path = 'C:\\dev\\macauPos\\macauPosSystem\\src\\components\\shift-page.tsx';
const content = fs.readFileSync(path, 'utf8');

// Replace header columns
const oldHeader = `                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2">交班時間</th>
                    <th className="border-b border-slate-200 px-3 py-2">員工</th>
                    <th className="border-b border-slate-200 px-3 py-2">營業額</th>
                    <th className="border-b border-slate-200 px-3 py-2">退款</th>
                    <th className="border-b border-slate-200 px-3 py-2">應收/實收現金</th>
                    <th className="border-b border-slate-200 px-3 py-2">差額</th>
                    <th className="border-b border-slate-200 px-3 py-2">待同步</th>
                    <th className="border-b border-slate-200 px-3 py-2">備註</th>
                    <th className="border-b border-slate-200 px-3 py-2">操作</th>
                  </tr>`;
const newHeader = `                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2">交班時間</th>
                    <th className="border-b border-slate-200 px-3 py-2">員工</th>
                    <th className="border-b border-slate-200 px-3 py-2">營業額</th>
                    <th className="border-b border-slate-200 px-3 py-2">應收金額合計</th>
                    <th className="border-b border-slate-200 px-3 py-2">實收金額合計</th>
                    <th className="border-b border-slate-200 px-3 py-2">線上線下合計</th>
                    <th className="border-b border-slate-200 px-3 py-2">退款</th>
                    <th className="border-b border-slate-200 px-3 py-2">應收/實收現金</th>
                    <th className="border-b border-slate-200 px-3 py-2">差額</th>
                    <th className="border-b border-slate-200 px-3 py-2">待同步</th>
                    <th className="border-b border-slate-200 px-3 py-2">備註</th>
                    <th className="border-b border-slate-200 px-3 py-2">操作</th>
                  </tr>`;

const content1 = content.replace(oldHeader, newHeader);
if (content1 === content) { console.error('header replacement failed'); process.exit(1); }

// Update colspan
const content2 = content1.replace(
  '<td className="px-3 py-4 text-slate-500" colSpan={9}>\n                        目前沒有符合條件的交班歷史。',
  '<td className="px-3 py-4 text-slate-500" colSpan={12}>\n                        目前沒有符合條件的交班歷史。',
);

// Insert new columns in body row before 退款 column
const oldBodyRow = `                        <td className="px-3 py-3 font-semibold text-slate-900">{formatMoney(row.revenue)}</td>
                        <td className="px-3 py-3 text-slate-700">
                          {row.refundCount} / {formatMoney(row.refundAmount)}
                        </td>`;
const newBodyRow = `                        <td className="px-3 py-3 font-semibold text-slate-900">{formatMoney(row.revenue)}</td>
                        <td className="px-3 py-3 text-slate-700">
                          {row.receivableTotal != null ? formatMoney(row.receivableTotal) : "--"}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {row.paidTotal != null ? formatMoney(row.paidTotal) : "--"}
                        </td>
                        <td className="px-3 py-3 font-semibold text-orange-700">
                          {formatMoney((row.paidTotal ?? 0) + (row.onlinePaidMop ?? 0))}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {row.refundCount} / {formatMoney(row.refundAmount)}
                        </td>`;

const content3 = content2.replace(oldBodyRow, newBodyRow);
if (content3 === content2) { console.error('body row replacement failed'); process.exit(1); }

fs.writeFileSync(path, content3, 'utf8');
console.log('history table updated');