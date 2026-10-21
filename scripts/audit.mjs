import { spawnSync } from "node:child_process";

// npm run exports the user's allow-scripts setting as a CLI-style env option.
// npm 11 rejects that option in nested audit calls. Keep the user config and
// explicitly disable lifecycle scripts; only remove the redundant env override.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
}
if (!process.env.npm_execpath) throw new Error("Run the audit through npm run check");
const result = spawnSync(
  process.execPath,
  [process.env.npm_execpath, "audit", "--ignore-scripts", "--audit-level=low"],
  { env, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
