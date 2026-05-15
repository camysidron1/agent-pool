import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(appRoot, "dist");

await runBuild();
await assertServedBundle();

async function runBuild(): Promise<void> {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: appRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);

  if (exitCode !== 0) {
    throw new Error(`web build failed\n${stdout}\n${stderr}`);
  }
}

async function assertServedBundle(): Promise<void> {
  if (!existsSync(join(distRoot, "index.html"))) {
    throw new Error("web build did not create dist/index.html");
  }

  const port = await getFreePort();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const path = join(distRoot, pathname);
      const file = Bun.file(path);

      if (!(await file.exists())) {
        return new Response("not found", { status: 404 });
      }

      return new Response(file);
    },
  });

  try {
    const html = await fetchText(new URL("/", server.url));
    const scriptPath = readEntryScriptPath(html);
    const script = await fetchText(new URL(scriptPath, server.url));

    if (!html.includes('<div id="root"></div>')) {
      throw new Error("served HTML is missing the React root");
    }
    assertBundleMarkers(script, [
      ["auth storage", "agent-pool.operatorId"],
      ["public auth header", "x-agent-pool-operator-id"],
      ["project selector", "project-selector"],
      ["kanban board", "Loaded project Kanban board"],
      ["task panel", "Task detail"],
      ["full-page detail", "Full-page task detail"],
      ["raw output log", "Raw output log"],
      ["security timeline", "Security Timeline"],
      ["artifact modal", "Document artifact preview"],
      ["operator notes", "Operator Notes"],
      ["note mutation", "/notes"],
      ["attempt timeline", "Attempt Timeline"],
      ["final response", "Final Assistant Response"],
      ["steering composer", "Steering message"],
      ["steering state", "Queued and failed steering"],
      ["interrupt confirmation", "Confirm interrupt"],
      ["steering mutation", "/steer"],
      ["interrupt mutation", "/interrupt"],
      ["upload planning", "/uploads/plan"],
      ["priority mutation", "/priority"],
      ["unblock mutation", "/unblock"],
      ["backlog mutation", "/backlog"],
    ]);

    console.log(`browser smoke ok ${server.url}`);
  } finally {
    server.stop(true);
  }
}

function assertBundleMarkers(script: string, markers: readonly (readonly [string, string])[]): void {
  const missing = markers.filter(([, marker]) => !script.includes(marker)).map(([label]) => label);

  if (missing.length > 0) {
    throw new Error(`served bundle is missing browser acceptance markers: ${missing.join(", ")}`);
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          rejectPort(new Error("could not allocate a browser smoke port"));
          return;
        }

        resolvePort(address.port);
      });
    });
  });
}

async function fetchText(url: URL): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch failed for ${url}: ${response.status}`);
  }

  return response.text();
}

function readEntryScriptPath(html: string): string {
  const match = html.match(/<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/);
  if (!match?.[1]) {
    throw new Error("served HTML is missing an entry script");
  }

  return match[1];
}
