import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Inline Pi's filesystem helpers so workload images still need only Node.
await build({
  entryPoints: [fileURLToPath(new URL("../src/worker.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/worker.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: `/*\n${await readFile(new URL("../THIRD_PARTY_NOTICES", import.meta.url), "utf8")}*/`,
  },
});
