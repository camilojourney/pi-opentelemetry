import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("loads in the pinned real Pi CLI without credentials or a model call", async () => {
  const home = await mkdtemp(`${tmpdir()}/pi-otel-smoke-`);
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const pkgRoot = resolve("node_modules/@earendil-works/pi-coding-agent");
    const pkg = JSON.parse(await readFile(`${pkgRoot}/package.json`, "utf8"));
    const address = server.address() as { port: number };
    // Deliberately do not inherit auth, packages, project settings or global instructions.
    const run = promisify(execFile)(process.execPath, [resolve(pkgRoot, pkg.bin.pi), "--offline", "--no-session",
      "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-mcp",
      "-e", resolve("src/index.ts"), "-p", "/otel-status"], {
      cwd: home, timeout: 30000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: `${home}/agent`,
        PI_OFFLINE: "1", PI_OTEL_METRICS_EXPORTER: "none", PI_OTEL_PRIVACY_PROFILE: "strict",
        PI_OTEL_INSTANCE_ID: "isolated-cli-test", PI_OTEL_EXPORTER_OTLP_HEADERS: "",
        PI_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces` },
    });
    run.child.stdin?.end();
    await run;
    const spans = bodies.flatMap((body) => body.resourceSpans.flatMap((r: any) =>
      r.scopeSpans.flatMap((scope: any) => scope.spans)));
    expect(spans.some((span) => span.name === "pi.session")).toBe(true);
    expect(spans.some((span) => span.name === "pi.turn")).toBe(false);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await rm(home, { recursive: true, force: true });
  }
}, 40000);
