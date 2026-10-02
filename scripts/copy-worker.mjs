import { copyFile } from "node:fs/promises";

await copyFile(new URL("../src/worker.mjs", import.meta.url), new URL("../dist/worker.mjs", import.meta.url));
