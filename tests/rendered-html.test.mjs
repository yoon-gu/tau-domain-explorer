import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the TAU domain explorer", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>TAU Explorer/);
  assert.match(html, /TAU Explorer/);
  assert.match(html, /τ²-bench/);
  assert.match(html, /Telecom/);
  assert.match(html, /Domain context/);
  assert.match(html, /Conversation transcript/i);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("ships pinned official data and a social preview", async () => {
  const raw = await readFile(
    new URL("../app/data/benchmark-snapshot.json", import.meta.url),
    "utf8",
  );
  const snapshot = JSON.parse(raw);
  const ids = snapshot.domains.map((domain) => domain.id);

  assert.deepEqual(ids, [
    "tau:airline",
    "tau:retail",
    "tau2:airline",
    "tau2:retail",
    "tau2:telecom",
  ]);
  assert.ok(snapshot.domains.every((domain) => domain.trajectories.length === 3));
  assert.ok(snapshot.domains.every((domain) => domain.policy.length > 1_000));
  assert.ok(snapshot.sources.every((source) => source.license === "MIT"));

  const telecom = snapshot.domains.find((domain) => domain.id === "tau2:telecom");
  const userToolCalls = telecom.trajectories.flatMap((trajectory) =>
    trajectory.messages.flatMap((message) =>
      message.toolCalls.filter((call) => call.requestor === "user"),
    ),
  );
  assert.ok(userToolCalls.length > 0);
  assert.equal(telecom.userPrompts[0].id, "tool-enabled");

  await access(new URL("../public/og.png", import.meta.url));
});
