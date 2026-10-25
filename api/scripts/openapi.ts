// Writes openapi.json from the route declarations (the same document the API serves at
// /v1/openapi.json). Front ends develop against a mock generated from it.
import fs from "node:fs";
import { createApp } from "../src/app.js";
import { openapi } from "../src/lib/api.js";

createApp();
const doc = openapi({ version: "1.0.0", serverUrl: process.env.PUBLIC_URL ?? "https://aura-pool-api.onrender.com" });
fs.writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");
console.log(`openapi.json: ${Object.keys(doc.paths).length} paths`);
