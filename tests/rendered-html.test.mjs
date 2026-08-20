import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const catalogUrl = new URL("../app/data/benchmark-snapshot.json", import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function publicAssetUrl(assetPath) {
  assert.match(assetPath, /^\/data\/[a-zA-Z0-9_./-]+\.json$/);
  return new URL(`../public${assetPath}`, import.meta.url);
}

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

test("server-renders the TAU domain explorer shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>TAU Explorer/);
  assert.match(html, /TAU Explorer/);
  assert.match(html, /τ²-bench/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("catalog indexes every official conversational run", async () => {
  const catalog = await readJson(catalogUrl);
  const expectedDomains = {
    "tau:airline": { runs: 2, trajectories: 600 },
    "tau:retail": { runs: 2, trajectories: 1_380 },
    "tau2:airline": { runs: 5, trajectories: 1_000 },
    "tau2:retail": { runs: 5, trajectories: 2_280 },
    "tau2:telecom": { runs: 11, trajectories: 5_016 },
  };

  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.datasetId, "official-conversational-v2");
  assert.equal(catalog.totals.runs, 25);
  assert.equal(catalog.totals.trajectories, 10_276);
  assert.deepEqual(catalog.excluded, {
    reason: "No user-role messages / dummy_user ablation",
    runs: 8,
    trajectories: 3_648,
  });
  assert.deepEqual(
    catalog.domains.map((domain) => domain.id),
    Object.keys(expectedDomains),
  );
  assert.ok(catalog.sources.every((source) => source.license === "MIT"));

  const runs = [];
  for (const domain of catalog.domains) {
    const expected = expectedDomains[domain.id];
    assert.equal(domain.runs.length, expected.runs);
    assert.equal(domain.trajectoryCount, expected.trajectories);
    assert.equal(
      domain.runs.reduce((total, run) => total + run.trajectoryCount, 0),
      domain.trajectoryCount,
    );
    assert.ok(domain.policy.length > 1_000);
    assert.ok(domain.runs.some((run) => run.id === domain.defaultRunId));

    const promptIds = new Set(domain.userPrompts.map((prompt) => prompt.id));
    const policySnapshotIds = new Set(
      domain.policySnapshots.map((snapshot) => snapshot.id),
    );
    for (const run of domain.runs) {
      assert.ok(run.trajectoryCount > 3);
      assert.match(run.indexPath, /^\/data\/.*\.json$/);
      assert.match(run.tasksPath, /^\/data\/.*\.json$/);
      assert.ok(promptIds.has(run.promptRef));
      assert.ok(policySnapshotIds.has(run.policySnapshotId));
      assert.notEqual(run.userImplementation, "dummy_user");
      assert.ok(!run.mode.startsWith("no-user"));
      assert.doesNotMatch(run.sourceFile, /_no-user(?:-op)?_/);
      runs.push({ domain, run });
    }
  }

  assert.equal(runs.length, 25);
  assert.equal(new Set(runs.map(({ run }) => run.id)).size, runs.length);
});

test("run indexes, task sets, and lazy trajectory details stay consistent", async () => {
  const catalog = await readJson(catalogUrl);
  const taskSets = new Map();
  const trajectoryIds = new Set();
  const detailPaths = new Set();
  const detailSamples = [];
  let indexedTrajectories = 0;
  let userToolExample;

  async function loadTaskSet(tasksPath) {
    if (!taskSets.has(tasksPath)) {
      taskSets.set(tasksPath, await readJson(publicAssetUrl(tasksPath)));
    }
    return taskSets.get(tasksPath);
  }

  for (const domain of catalog.domains) {
    for (const run of domain.runs) {
      const [index, taskSet] = await Promise.all([
        readJson(publicAssetUrl(run.indexPath)),
        loadTaskSet(run.tasksPath),
      ]);

      assert.equal(index.schemaVersion, catalog.schemaVersion);
      assert.equal(index.datasetId, catalog.datasetId);
      assert.equal(index.runId, run.id);
      assert.equal(index.trajectories.length, run.trajectoryCount);
      assert.ok(index.trajectories.length > 3);
      assert.equal(taskSet.schemaVersion, catalog.schemaVersion);
      assert.equal(taskSet.datasetId, catalog.datasetId);
      assert.equal(Object.keys(taskSet.tasks).length, run.taskCount);

      const passCount = index.trajectories.filter((item) => item.reward === 1).length;
      assert.equal(passCount, run.passCount);
      assert.equal(index.trajectories.length - passCount, run.failCount);

      for (const summary of index.trajectories) {
        assert.equal(summary.domainId, domain.id);
        assert.equal(summary.runId, run.id);
        assert.ok(taskSet.tasks[summary.taskId]);
        assert.ok(!trajectoryIds.has(summary.id), `duplicate trajectory id: ${summary.id}`);
        assert.ok(!detailPaths.has(summary.detailPath), `duplicate detail path: ${summary.detailPath}`);
        assert.match(summary.detailPath, /^\/data\/.*\.json$/);
        assert.ok(summary.messageCount > 0);
        assert.ok(summary.toolCallCount >= summary.userToolCallCount);
        assert.deepEqual(
          summary.toolNames,
          [...new Set(summary.toolNames)].sort(),
        );
        trajectoryIds.add(summary.id);
        detailPaths.add(summary.detailPath);
        indexedTrajectories += 1;

        if (!userToolExample && summary.userToolCallCount > 0) {
          userToolExample = { domain, run, summary };
        }
      }

      detailSamples.push(
        { domain, run, summary: index.trajectories[0] },
        { domain, run, summary: index.trajectories.at(-1) },
      );
    }
  }

  assert.equal(indexedTrajectories, catalog.totals.trajectories);
  assert.equal(trajectoryIds.size, 10_276);
  assert.ok(taskSets.size >= 5, "expected content-addressed task sets for both benchmarks");

  for (const { run, summary } of detailSamples) {
    const payload = await readJson(publicAssetUrl(summary.detailPath));
    const trajectory = payload.trajectory;
    const toolCalls = trajectory.messages.flatMap((message) => message.toolCalls);

    assert.equal(payload.schemaVersion, catalog.schemaVersion);
    assert.equal(payload.datasetId, catalog.datasetId);
    assert.equal(trajectory.id, summary.id);
    assert.equal(trajectory.runId, run.id);
    assert.equal(trajectory.taskId, summary.taskId);
    assert.equal(trajectory.trial, summary.trial);
    assert.equal(trajectory.reward, summary.reward);
    assert.equal(trajectory.title, summary.title);
    assert.equal(trajectory.messages.length, summary.messageCount);
    assert.equal(toolCalls.length, summary.toolCallCount);
    assert.equal(
      toolCalls.filter((call) => call.requestor === "user").length,
      summary.userToolCallCount,
    );
    assert.deepEqual(
      [...new Set(toolCalls.map((call) => call.name))].sort(),
      summary.toolNames,
    );
  }

  assert.ok(userToolExample, "expected a Telecom trajectory with user-operated tools");
  assert.equal(userToolExample.domain.id, "tau2:telecom");
  assert.ok(
    userToolExample.domain.userPrompts.some((prompt) => prompt.id === "tool-enabled"),
  );
  const userToolPayload = await readJson(
    publicAssetUrl(userToolExample.summary.detailPath),
  );
  const userToolCalls = userToolPayload.trajectory.messages.flatMap((message) =>
    message.toolCalls.filter((call) => call.requestor === "user"),
  );
  assert.equal(userToolCalls.length, userToolExample.summary.userToolCallCount);
  assert.ok(userToolCalls.length > 0);
});

test("ships a social preview", async () => {
  const preview = await readFile(new URL("../public/og.png", import.meta.url));
  assert.ok(preview.length > 0);
});
