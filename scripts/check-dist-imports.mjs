// Fails when a package entry other than ./mock can reach a module that is not a runtime
// dependency (the test chain @paryonusd/mem-cash above all): bundlers resolve every import, the
// dynamic ones included, so a dev dependency reachable from an entry breaks app builds.
// Run after `pnpm build`.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const allowed = Object.keys(pkg.dependencies ?? {});
const testOnlyEntries = ["./mock"];

const specifiers = (source) =>
  [
    ...source.matchAll(
      /(?:^|[\s;}])(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']/g,
    ),
    ...source.matchAll(/(?:^|[\s;}])import\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);

const isAllowed = (specifier) =>
  specifier.startsWith("node:") ||
  allowed.some((dep) => specifier === dep || specifier.startsWith(`${dep}/`));

const problems = [];
for (const [entry, target] of Object.entries(pkg.exports)) {
  if (testOnlyEntries.includes(entry)) continue;
  const queue = [resolve(root, target.import)];
  const seen = new Set(queue);
  while (queue.length) {
    const file = queue.pop();
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        const next = resolve(dirname(file), specifier);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      } else if (!isAllowed(specifier)) {
        problems.push(
          `${entry}: ${file.slice(root.length + 1)} imports ${specifier}`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error(
    `Entries reach modules that are not dependencies:\n${problems.join("\n")}`,
  );
  process.exit(1);
}
console.log("Package entries import runtime dependencies only.");
