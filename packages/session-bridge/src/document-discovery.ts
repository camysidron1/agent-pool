import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

import type { BridgeDocumentRegistration, BridgeSessionOptions } from "./index";

export type BridgeDocumentDiscoveryOptions = {
  readonly session: BridgeSessionOptions;
  readonly workspaceRoot: string;
  readonly allowedRoots?: readonly string[];
};

export async function discoverBridgeDocuments(
  options: BridgeDocumentDiscoveryOptions,
): Promise<readonly BridgeDocumentRegistration[]> {
  const allowedRoots = options.allowedRoots ?? ["agent-docs", "shared-docs"];
  const documents: BridgeDocumentRegistration[] = [];

  for (const root of allowedRoots) {
    if (root !== "agent-docs" && root !== "shared-docs") {
      continue;
    }

    const absoluteRoot = join(options.workspaceRoot, root);
    for (const filePath of await listFiles(absoluteRoot)) {
      const metadata = await stat(filePath);
      const relativePath = toPortablePath(relative(options.workspaceRoot, filePath));

      documents.push({
        kind: "document",
        projectId: options.session.projectId,
        taskId: options.session.taskId,
        sessionId: options.session.sessionId,
        path: relativePath,
        title: basename(filePath),
        contentType: contentTypeForPath(filePath),
        sizeBytes: metadata.size,
      });
    }
  }

  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

async function listFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);

      if (entry.isDirectory()) {
        return listFiles(path);
      }

      return entry.isFile() ? [path] : [];
    }),
  );

  return files.flat();
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function toPortablePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
