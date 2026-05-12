import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

type BoundaryRule = {
  readonly name: string;
  readonly roots: readonly string[];
  readonly forbiddenImports: readonly string[];
};

const IMPORT_SPECIFIER_PATTERN = /(?:import|export)\s+(?:type\s+)?(?:[^'"()]+?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

const RULES: readonly BoundaryRule[] = [
  {
    name: "web stays browser-safe and does not import backend/runtime packages",
    roots: ["apps/web/src"],
    forbiddenImports: ["@agent-pool/db", "@agent-pool/queue", "@agent-pool/runtime"],
  },
  {
    name: "orchestrator does not import backend-owned db package",
    roots: ["apps/orchestrator/src"],
    forbiddenImports: ["@agent-pool/db", "bun:sqlite", "drizzle-orm"],
  },
  {
    name: "non-api production source does not import backend-owned db package",
    roots: [
      "apps/orchestrator/src",
      "apps/web/src",
      "packages/auth/src",
      "packages/config/src",
      "packages/queue/src",
      "packages/runtime/src",
      "packages/shared/src",
      "packages/storage/src",
    ],
    forbiddenImports: ["@agent-pool/db", "bun:sqlite", "drizzle-orm"],
  },
  {
    name: "session bridge stays isolated from app, backend db, and runtime provider code",
    roots: ["packages/session-bridge/src"],
    forbiddenImports: [
      "@agent-pool/db",
      "@agent-pool/runtime",
      "@e2b/code-interpreter",
      "apps/api",
      "apps/web",
      "apps/orchestrator",
      "bun:sqlite",
      "drizzle-orm",
      "../../apps/api",
      "../../apps/web",
      "../../apps/orchestrator",
      "../../packages/db",
      "../../packages/runtime",
      "../api",
      "../db",
      "../runtime",
    ],
  },
];

describe("import boundaries", () => {
  for (const rule of RULES) {
    test(rule.name, async () => {
      const violations = await collectViolations(rule);

      expect(violations).toEqual([]);
    });
  }

  test("non-api production source does not construct or open the backend database", async () => {
    const roots = [
      "apps/orchestrator/src",
      "apps/web/src",
      "packages/auth/src",
      "packages/config/src",
      "packages/queue/src",
      "packages/runtime/src",
      "packages/session-bridge/src",
      "packages/shared/src",
      "packages/storage/src",
    ];
    const violations: string[] = [];

    for (const root of roots) {
      for (const filePath of await listSourceFiles(root)) {
        const contents = await readFile(filePath, "utf8");

        for (const pattern of DB_CONNECTION_PATTERNS) {
          if (pattern.pattern.test(contents)) {
            violations.push(`${relative(process.cwd(), filePath)} contains ${pattern.name}`);
          }
        }
      }
    }

    expect(violations.sort()).toEqual([]);
  });
});

const DB_CONNECTION_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "openWebSandboxDatabase", pattern: /\bopenWebSandboxDatabase\s*\(/ },
  { name: "createWebSandboxDatabaseConfig", pattern: /\bcreateWebSandboxDatabaseConfig\s*\(/ },
  { name: "migrateWebSandboxDatabase", pattern: /\bmigrateWebSandboxDatabase\s*\(/ },
  { name: "createDrizzleDatabase", pattern: /\bcreateDrizzleDatabase\s*\(/ },
  { name: "new Database", pattern: /\bnew\s+Database\s*\(/ },
];

async function collectViolations(rule: BoundaryRule): Promise<string[]> {
  const violations: string[] = [];

  for (const root of rule.roots) {
    for (const filePath of await listSourceFiles(root)) {
      const contents = await readFile(filePath, "utf8");

      for (const specifier of readImportSpecifiers(contents)) {
        const forbiddenImport = rule.forbiddenImports.find(
          (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
        );

        if (forbiddenImport) {
          violations.push(`${relative(process.cwd(), filePath)} imports ${specifier}`);
        }
      }
    }
  }

  return violations.sort();
}

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(path);
      }

      if (entry.isFile() && /\.[cm]?[tj]sx?$/.test(entry.name)) {
        return [path];
      }

      return [];
    }),
  );

  return files.flat().sort();
}

function readImportSpecifiers(contents: string): string[] {
  return Array.from(contents.matchAll(IMPORT_SPECIFIER_PATTERN), (match) => match[1] ?? match[2]).filter(
    (specifier): specifier is string => Boolean(specifier),
  );
}
