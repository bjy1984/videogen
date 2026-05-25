import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const envFiles = [".env", ".env.local"];

for (const fileName of envFiles) {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    process.env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "");
}
