import PDFDocument from "pdfkit";
import { db, many, one, type Q } from "../config/db.js";
import { addDays, formatKsh, nairobiDate, nairobiInstant } from "../lib/kenya.js";
import { onJob } from "./jobs.js";
import { sendEmail } from "./messaging.js";
import { getSetting } from "./settings.js";

// Statements and reports: CSV for everything (UTC ISO times, as the spec asks for exports),
// a PDF statement for owners, and the operator's daily close.

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const cell = (v: unknown) => {
    if (v == null) return "";
    const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    // Neutralise spreadsheet formulas in exported text.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

export const shillings = (minor: number | null | undefined) => (minor == null ? "" : (minor / 100).toFixed(2));

/** A month of one merchant's business, day by day. */
export async function statementData(q: Q, merchantId: string, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month must be YYYY-MM");
  const start = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const from = nairobiInstant(start);
  const to = nairobiInstant(next);
  const merchant = await one<{ business_name: string; code: string; owner_name: string }>(q, `select business_name, code, owner_name from merchants where id = $1`, [merchantId]);
  const days = await many<{ d: string; games: number; collected: number; commission: number; earnings: number; payments: number }>(
    q,
    `with days as (select generate_series($2::date, ($3::date - 1), interval '1 day')::date as d)
     select to_char(days.d, 'YYYY-MM-DD') as d,
            (select count(*)::int from game_credits g where g.merchant_id = $1 and g.status = 'acked' and (g.acked_at at time zone 'Africa/Nairobi')::date = days.d) as games,
            (select coalesce(sum(amount_minor), 0) from payments p where p.merchant_id = $1 and (p.credited_at at time zone 'Africa/Nairobi')::date = days.d) as collected,
            (select coalesce(sum(commission_minor), 0) from payments p where p.merchant_id = $1 and (p.credited_at at time zone 'Africa/Nairobi')::date = days.d) as commission,
            (select coalesce(sum(merchant_share_minor), 0) from payments p where p.merchant_id = $1 and (p.credited_at at time zone 'Africa/Nairobi')::date = days.d) as earnings,
            (select count(*)::int from payments p where p.merchant_id = $1 and (p.credited_at at time zone 'Africa/Nairobi')::date = days.d) as payments
       from days order by days.d`,
    [merchantId, start, next],
  );
  const withdrawals = await many<{ ref: string; requested_at: Date; completed_at: Date | null; gross_minor: number; fee_minor: number; net_minor: number; status: string; mpesa_receipt: string | null }>(
    q,
    `select ref, requested_at, completed_at, gross_minor, fee_minor, net_minor, status, mpesa_receipt from payouts where merchant_id = $1 and requested_at >= $2 and requested_at < $3 order by requested_at`,
    [merchantId, from, to],
  );
  const account = `merchant_payable:${merchantId}`;
  const opening = await one<{ b: number }>(q, `select -coalesce(sum(e.amount_minor), 0) as b from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.code = $1 and e.created_at < $2`, [account, from]);
  const closing = await one<{ b: number }>(q, `select -coalesce(sum(e.amount_minor), 0) as b from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.code = $1 and e.created_at < $2`, [account, to]);
  const totals = days.reduce((t, d) => ({ games: t.games + d.games, collected: t.collected + d.collected, commission: t.commission + d.commission, earnings: t.earnings + d.earnings }), { games: 0, collected: 0, commission: 0, earnings: 0 });
  const paidOut = withdrawals.filter((w) => w.status === "succeeded").reduce((s, w) => s + w.gross_minor, 0);
  return { merchant, month, days, withdrawals, openingMinor: opening?.b ?? 0, closingMinor: closing?.b ?? 0, totals, paidOutMinor: paidOut };
}

export function statementCsv(s: Awaited<ReturnType<typeof statementData>>) {
  const rows = s.days.map((d) => ({ date: d.d, games: d.games, payments: d.payments, collected_kes: shillings(d.collected), commission_kes: shillings(d.commission), your_earnings_kes: shillings(d.earnings) }));
  rows.push({ date: "TOTAL", games: s.totals.games, payments: rows.reduce((t, r) => t + Number(r.payments), 0), collected_kes: shillings(s.totals.collected), commission_kes: shillings(s.totals.commission), your_earnings_kes: shillings(s.totals.earnings) });
  const w = s.withdrawals.map((x) => ({ reference: x.ref, requested_at: x.requested_at, completed_at: x.completed_at, amount_kes: shillings(x.gross_minor), fee_kes: shillings(x.fee_minor), received_kes: shillings(x.net_minor), status: x.status, mpesa_receipt: x.mpesa_receipt }));
  return `Aura Pool statement,${s.merchant?.business_name ?? ""},${s.month}\nOpening balance KES,${shillings(s.openingMinor)}\nClosing balance KES,${shillings(s.closingMinor)}\n\n${toCsv(rows)}\nWithdrawals\n${toCsv(w, ["reference", "requested_at", "completed_at", "amount_kes", "fee_kes", "received_kes", "status", "mpesa_receipt"])}`;
}

export function statementPdf(s: Awaited<ReturnType<typeof statementData>>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Aura Pool statement ${s.month}`, Author: "Aura Pool" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const ink = "#111412";
    const muted = "#5d6660";
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(18).text("Aura Pool");
    doc.moveDown(0.2).font("Helvetica").fontSize(11).fillColor(muted).text(`Monthly statement · ${monthName(s.month)}`);
    doc.moveDown(0.8).fillColor(ink).fontSize(12).font("Helvetica-Bold").text(s.merchant?.business_name ?? "");
    doc.font("Helvetica").fontSize(10).fillColor(muted).text(`${s.merchant?.code ?? ""} · ${s.merchant?.owner_name ?? ""}`);
    doc.moveDown(1);
    const kv = (k: string, v: string) => {
      doc.font("Helvetica").fontSize(10).fillColor(muted).text(k, { continued: true }).fillColor(ink).font("Helvetica-Bold").text(`  ${v}`);
    };
    kv("Games played", String(s.totals.games));
    kv("Money collected", formatKsh(s.totals.collected));
    kv("Platform commission", formatKsh(s.totals.commission));
    kv("Your earnings", formatKsh(s.totals.earnings));
    kv("Withdrawn", formatKsh(s.paidOutMinor));
    kv("Opening balance", formatKsh(s.openingMinor));
    kv("Closing balance", formatKsh(s.closingMinor));
    doc.moveDown(1);
    const cols = [48, 140, 200, 300, 400];
    const header = ["Date", "Games", "Collected", "Commission", "Your earnings"];
    const row = (vals: string[], bold = false) => {
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(ink);
      vals.forEach((v, i) => doc.text(v, cols[i], y, { width: (cols[i + 1] ?? 548) - cols[i] - 6, align: i === 0 ? "left" : "right" }));
      doc.moveDown(0.35);
    };
    row(header, true);
    doc.moveTo(48, doc.y).lineTo(548, doc.y).strokeColor("#d9ddda").stroke();
    doc.moveDown(0.3);
    for (const d of s.days) {
      if (doc.y > 760) doc.addPage();
      row([d.d, String(d.games), formatKsh(d.collected), formatKsh(d.commission), formatKsh(d.earnings)]);
    }
    doc.moveTo(48, doc.y).lineTo(548, doc.y).strokeColor("#d9ddda").stroke();
    doc.moveDown(0.3);
    row(["Total", String(s.totals.games), formatKsh(s.totals.collected), formatKsh(s.totals.commission), formatKsh(s.totals.earnings)], true);
    if (s.withdrawals.length) {
      doc.moveDown(1).font("Helvetica-Bold").fontSize(11).text("Withdrawals", 48);
      doc.moveDown(0.4);
      for (const w of s.withdrawals) {
        if (doc.y > 760) doc.addPage();
        doc.font("Helvetica").fontSize(9).fillColor(ink).text(`${w.ref}   ${new Date(w.requested_at).toISOString().slice(0, 10)}   ${formatKsh(w.gross_minor)} (fee ${formatKsh(w.fee_minor)})   ${w.status}${w.mpesa_receipt ? `   ${w.mpesa_receipt}` : ""}`, 48);
      }
    }
    doc.moveDown(2).font("Helvetica").fontSize(8).fillColor(muted).text("Times are East Africa Time. Figures come from the Aura Pool ledger. Customer numbers are never shown in full.", 48);
    doc.end();
  });
}

function monthName(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-KE", { month: "long", year: "numeric", timeZone: "UTC" });
}

// ------------------------------------------------------------------ daily close

/** Collections, commission, payouts, fees and closing balances for one Nairobi day. */
export async function dailyClose(q: Q, date: string) {
  const from = nairobiInstant(date);
  const to = nairobiInstant(addDays(date, 1));
  const c = await one<{ n: number; collected: number; credited: number; unmatched: number; commission: number; games: number }>(
    q,
    `select count(*)::int as n, coalesce(sum(amount_minor), 0) as collected,
            coalesce(sum(amount_minor) filter (where status in ('credited','refund_pending','refunded')), 0) as credited,
            coalesce(sum(amount_minor) filter (where status = 'unmatched'), 0) as unmatched,
            coalesce(sum(commission_minor), 0) as commission,
            (select count(*)::int from game_credits g where g.status = 'acked' and g.acked_at >= $1 and g.acked_at < $2) as games
       from payments where received_at >= $1 and received_at < $2 and status <> 'rejected'`,
    [from, to],
  );
  const p = await one<{ n: number; gross: number; net: number; fees: number; tariff: number }>(
    q,
    `select count(*)::int as n, coalesce(sum(gross_minor), 0) as gross, coalesce(sum(net_minor), 0) as net, coalesce(sum(fee_minor), 0) as fees, coalesce(sum(tariff_minor), 0) as tariff
       from payouts where status = 'succeeded' and completed_at >= $1 and completed_at < $2`,
    [from, to],
  );
  const refunds = await one<{ n: number; s: number }>(q, `select count(*)::int as n, coalesce(sum(amount_minor), 0) as s from refunds where status = 'paid' and paid_at >= $1 and paid_at < $2`, [from, to]);
  const balances = await many<{ code: string; name: string; b: number }>(
    q,
    `select a.code, a.name, coalesce(sum(e.amount_minor), 0) as b from ledger_accounts a left join ledger_entries e on e.account_id = a.id and e.created_at < $1
      where a.code not like 'merchant_payable:%' group by a.id order by a.code`,
    [to],
  );
  const owed = await one<{ b: number }>(q, `select -coalesce(sum(e.amount_minor), 0) as b from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.code like 'merchant_payable:%' and e.created_at < $1`, [to]);
  return {
    date,
    collections: { payments: c?.n ?? 0, totalMinor: c?.collected ?? 0, creditedMinor: c?.credited ?? 0, unmatchedMinor: c?.unmatched ?? 0, games: c?.games ?? 0 },
    commissionMinor: c?.commission ?? 0,
    payouts: { count: p?.n ?? 0, grossMinor: p?.gross ?? 0, netMinor: p?.net ?? 0, feesChargedMinor: p?.fees ?? 0, providerTariffMinor: p?.tariff ?? 0 },
    refunds: { count: refunds?.n ?? 0, totalMinor: refunds?.s ?? 0 },
    closingBalances: [...balances.map((b) => ({ account: b.code, name: b.name, balanceMinor: b.b })), { account: "merchant_payable:*", name: "Owed to merchants", balanceMinor: -(owed?.b ?? 0) }],
  };
}

export function dailyCloseCsv(d: Awaited<ReturnType<typeof dailyClose>>) {
  const lines = [
    { item: "Payments received", value: d.collections.payments },
    { item: "Collected (KES)", value: shillings(d.collections.totalMinor) },
    { item: "Credited to tables (KES)", value: shillings(d.collections.creditedMinor) },
    { item: "Unmatched, in suspense (KES)", value: shillings(d.collections.unmatchedMinor) },
    { item: "Games played", value: d.collections.games },
    { item: "Platform commission (KES)", value: shillings(d.commissionMinor) },
    { item: "Payouts sent", value: d.payouts.count },
    { item: "Payouts gross (KES)", value: shillings(d.payouts.grossMinor) },
    { item: "Payouts net (KES)", value: shillings(d.payouts.netMinor) },
    { item: "Withdrawal fees charged (KES)", value: shillings(d.payouts.feesChargedMinor) },
    { item: "B2C tariff paid (KES)", value: shillings(d.payouts.providerTariffMinor) },
    { item: "Refunds paid (KES)", value: shillings(d.refunds.totalMinor) },
    ...d.closingBalances.map((b) => ({ item: `Closing: ${b.name} (KES, debit +)`, value: shillings(b.balanceMinor) })),
  ];
  return `Aura Pool daily close,${d.date}\n${toCsv(lines, ["item", "value"])}`;
}

/** 00:05 Nairobi: yesterday's close, stored and emailed. */
export async function runDailyClose(date = addDays(nairobiDate(), -1)) {
  const d = await dailyClose(db(), date);
  await db().query(`insert into daily_reports (report_date, data) values ($1, $2) on conflict (report_date) do update set data = excluded.data, created_at = now()`, [date, JSON.stringify(d)]);
  const cfg = await getSetting("reports");
  const contacts = await getSetting("operator_contacts");
  const to = [...new Set([...cfg.recipients, ...contacts.email])];
  if (cfg.daily_email && to.length) {
    const sent = await sendEmail(to, `Aura Pool daily close ${date}`, `Collected ${formatKsh(d.collections.totalMinor)}, ${d.collections.games} games, commission ${formatKsh(d.commissionMinor)}, ${d.payouts.count} payouts (${formatKsh(d.payouts.grossMinor)}).`, [{ filename: `aura-daily-close-${date}.csv`, content: Buffer.from(dailyCloseCsv(d)).toString("base64") }]);
    if (sent.ok) await db().query(`update daily_reports set emailed_at = now() where report_date = $1`, [date]);
  }
  return d;
}

onJob("report.daily_close", async (p) => {
  await runDailyClose(p.date ? String(p.date) : undefined);
});

/** First of the month: last month's summary to the chosen recipients. */
export async function runMonthlySummary(now = new Date()) {
  const cfg = await getSetting("reports");
  const to = cfg.recipients;
  if (!cfg.monthly_email || !to.length) return;
  const today = nairobiDate(now);
  const lastMonthEnd = addDays(`${today.slice(0, 8)}01`, -1);
  const month = lastMonthEnd.slice(0, 7);
  const rows = await many<{ report_date: string; data: { collections: { totalMinor: number; games: number }; commissionMinor: number } }>(db(), `select to_char(report_date, 'YYYY-MM-DD') as report_date, data from daily_reports where to_char(report_date, 'YYYY-MM') = $1 order by report_date`, [month]);
  const total = rows.reduce((t, r) => ({ c: t.c + r.data.collections.totalMinor, g: t.g + r.data.collections.games, k: t.k + r.data.commissionMinor }), { c: 0, g: 0, k: 0 });
  await sendEmail(to, `Aura Pool monthly summary ${month}`, `${month}: collected ${formatKsh(total.c)}, ${total.g} games, commission ${formatKsh(total.k)} across ${rows.length} reported days.`, [
    { filename: `aura-month-${month}.csv`, content: Buffer.from(toCsv(rows.map((r) => ({ date: r.report_date, collected_kes: shillings(r.data.collections.totalMinor), games: r.data.collections.games, commission_kes: shillings(r.data.commissionMinor) })))).toString("base64") },
  ]);
}
