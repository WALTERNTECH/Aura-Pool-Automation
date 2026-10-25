// Provider simulator: plays Safaricom at an Aura Pool API running with PAYMENTS_PROVIDER=simulated.
// Sends C2B validation and confirmation callbacks exactly as Daraja shapes them, including
// duplicates, out-of-order delivery, invalid accounts, under- and over-payments, and forged
// callbacks the provider never issued. B2C, status and balance answers come from the API's own
// simulated provider over the same callback routes.
//
//   npm run sim:provider -- --api http://localhost:4000 --secret dev-callback --account T001 --amount 50
//   npm run sim:provider -- --scenario all --account T001
//
// Raw replay of saved Daraja payloads (works against any provider mode):
//   npm run sim:provider -- --replay payload.json --kind confirmation

import fs from "node:fs";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const api = (arg("api", process.env.API_URL ?? "http://localhost:4000") as string).replace(/\/$/, "");
const secret = arg("secret", process.env.CALLBACK_SECRET ?? "dev-callback") as string;
const account = arg("account", "T001") as string;

async function post(path: string, body: unknown) {
  const r = await fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
}

async function pay(label: string, body: Record<string, unknown>) {
  const r = await post(`/cb/sim/${secret}/c2b`, { accountRef: account, amountMinor: 5000, msisdn: "0712345678", ...body });
  console.log(`${label.padEnd(28)} → ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

const SCENARIOS: Record<string, () => Promise<unknown>> = {
  normal: () => pay("one game (KSh 50)", {}),
  loose_account: () => pay('account typed as "t 1"', { accountRef: "t 1" }),
  duplicate: () => pay("duplicate confirmation", { duplicate: true }),
  out_of_order: () => pay("confirmation before validation", { outOfOrder: true }),
  invalid_account: () => pay("unknown account (validated)", { accountRef: "T999" }),
  unmatched: () => pay("unknown account (no validation)", { accountRef: "TABLE1", skipValidation: true }),
  underpaid: () => pay("underpaid KSh 30", { amountMinor: 3000, msisdn: "0722111333" }),
  top_up: () => pay("top-up KSh 20, same payer", { amountMinor: 2000, msisdn: "0722111333" }),
  overpaid: () => pay("overpaid KSh 120", { amountMinor: 12000, msisdn: "0733111444" }),
  forged: () => pay("forged callback", { forged: true }),
};

async function main() {
  const replay = arg("replay");
  if (replay) {
    const kind = arg("kind", "confirmation");
    const path = kind === "validation" ? `/cb/daraja/c2b/${secret}/validation` : kind === "stk" ? `/cb/daraja/stk/${secret}` : kind === "b2c" ? `/cb/daraja/b2c/${secret}/result` : `/cb/daraja/c2b/${secret}/confirmation`;
    const payloads = JSON.parse(fs.readFileSync(replay, "utf8"));
    for (const p of Array.isArray(payloads) ? payloads : [payloads]) {
      const r = await post(path, p);
      console.log(`replay ${kind} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    return;
  }
  const scenario = arg("scenario");
  if (scenario === "all") {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      await run();
      await new Promise((r) => setTimeout(r, Number(arg("gap", "1500"))));
      void name;
    }
    return;
  }
  if (scenario) {
    const run = SCENARIOS[scenario];
    if (!run) throw new Error(`unknown scenario; pick one of: all, ${Object.keys(SCENARIOS).join(", ")}`);
    await run();
    return;
  }
  const amount = Math.round(Number(arg("amount", "50")) * 100);
  await pay(`KSh ${amount / 100} to ${account}`, { amountMinor: amount, msisdn: arg("phone", "0712345678"), duplicate: flag("duplicate"), outOfOrder: flag("out-of-order"), skipValidation: flag("skip-validation"), forged: flag("forged") });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
