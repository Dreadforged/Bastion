import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildHeaders } from "./headers.mjs";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
if (!existsSync(dist)) throw new Error("dist/ not found: run vite build first");
writeFileSync(`${dist}/_headers`, buildHeaders(process.env));
console.log("wrote dist/_headers");
