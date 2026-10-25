import { env } from "../config/env.js";
import { DarajaProvider } from "./daraja.js";
import { SimulatedProvider } from "./simulated.js";
import type { PaymentProvider } from "./types.js";

// The active provider. IntaSend sits behind the same interface in Phase 2; until it is
// enabled the console shows its placeholder status and nothing routes to it.

let current: PaymentProvider | null = null;

export function provider(): PaymentProvider {
  if (!current) current = env.provider === "daraja" ? new DarajaProvider() : new SimulatedProvider();
  return current;
}

export function intasendStatus() {
  return {
    name: "IntaSend",
    enabled: false,
    phase: "Phase 2",
    note: "The adapter slot exists behind the same PaymentProvider interface. Paybill (C2B) collections stay on Daraja; IntaSend would carry STK and payouts once enabled.",
  };
}
