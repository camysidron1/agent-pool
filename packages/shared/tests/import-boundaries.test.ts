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
    forbiddenImports: ["@agent-pool/db"],
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
    forbiddenImports: ["@agent-pool/db"],
  },
];

describe("import boundaries", () => {
  for (const rule of RULES) {
    test(rule.name, async () => {
      const violations = await collectViolations(rule);

      expect(violations).toEqual([]);
    });
  }
});

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
