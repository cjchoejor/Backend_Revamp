import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const backEndRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(backEndRoot, "dist"), { recursive: true, force: true });
