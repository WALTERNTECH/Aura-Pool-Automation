import QRCode from "qrcode";
import { env } from "../config/env.js";
import { formatKsh } from "../lib/kenya.js";

// The printable table sheet: a QR code to the pay page, the Paybill and the table's account
// number, and short instructions. Served as a self-contained HTML page sized for A5.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function tableSheet(t: { id: string; name: string; price_minor: number; business_name: string }) {
  const url = `${env.publicUrl}/t/${t.id}`;
  const qr = await QRCode.toString(url, { type: "svg", margin: 0, width: 260, errorCorrectionLevel: "M" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.id)} payment sheet</title>
<style>
  @page { size: A5; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111412; background: #fff; }
  .sheet { max-width: 520px; margin: 24px auto; padding: 28px; border: 1.5px solid #111412; border-radius: 18px; text-align: center; }
  .brand { font-weight: 800; letter-spacing: .02em; font-size: 14px; text-transform: uppercase; color: #1f6b48; }
  h1 { font-size: 30px; margin: 6px 0 2px; }
  .sub { color: #5d6660; margin: 0 0 18px; }
  .qr svg { width: 240px; height: 240px; }
  .or { margin: 18px 0 10px; color: #5d6660; font-size: 13px; text-transform: uppercase; letter-spacing: .1em; }
  .pay { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: left; }
  .pay div { border: 1px solid #d9ddda; border-radius: 12px; padding: 10px 12px; }
  .pay small { display: block; color: #5d6660; font-size: 12px; }
  .pay b { font-size: 24px; letter-spacing: .04em; }
  ol { text-align: left; margin: 18px 0 0; padding-left: 20px; color: #333a35; }
  .foot { margin-top: 16px; font-size: 12px; color: #5d6660; }
  @media print { .sheet { margin: 0; } }
</style></head><body>
<div class="sheet">
  <div class="brand">Aura Pool</div>
  <h1>${esc(t.name)}</h1>
  <p class="sub">${formatKsh(t.price_minor)} per game · Table ${esc(t.id)}</p>
  <div class="qr">${qr}</div>
  <div class="or">or pay by M-Pesa Paybill</div>
  <div class="pay"><div><small>Business number</small><b>${esc(env.paybillNumber)}</b></div><div><small>Account number</small><b>${esc(t.id)}</b></div></div>
  <ol><li>Go to M-Pesa, Lipa na M-Pesa, Pay Bill.</li><li>Business number <b>${esc(env.paybillNumber)}</b>, account <b>${esc(t.id)}</b>.</li><li>Pay ${formatKsh(t.price_minor)} for each game. The balls release in a few seconds.</li></ol>
  <div class="foot">${esc(t.business_name)} · If the table doesn't release, the attendant can help.</div>
</div>
</body></html>`;
}
