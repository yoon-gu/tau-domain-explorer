import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const catalogUrl = new URL("../app/data/benchmark-snapshot.json", import.meta.url);
const stylesheetUrl = new URL("../app/globals.css", import.meta.url);

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

function selectorBlock(css, selector) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  assert.notEqual(start, -1, `missing CSS selector: ${selector}`);
  const end = css.indexOf("}", start + marker.length);
  assert.notEqual(end, -1, `unterminated CSS selector: ${selector}`);
  return css.slice(start + marker.length, end);
}

function fontPixels(css, selector) {
  const block = selectorBlock(css, selector);
  const explicit = block.match(/font-size:\s*(\d+)px/);
  const shorthand = block.match(/font:\s*(?:\d+\s+)?(\d+)px/);
  const value = explicit?.[1] ?? shorthand?.[1];
  assert.ok(value, `missing pixel font size for ${selector}`);
  return Number(value);
}

test("server-renders the TAU domain explorer shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>TAU Explorer/);
  assert.match(html, /TAU Explorer/);
  assert.match(html, /τ²-bench/);
  assert.match(html, /Catalog view/);
  assert.match(html, />Tasks</);
  assert.match(html, />Trajectories</);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("uses a readable typography scale across the explorer", async () => {
  const css = await readFile(stylesheetUrl, "utf8");
  const minimums = new Map([
    [".brand-name", 14],
    [".benchmark-tab", 12],
    [".domain-name", 13],
    [".catalog-filter select", 12],
    [".catalog-view-switch button", 11],
    [".trajectory-item-copy strong", 13],
    [".task-group-copy strong", 13],
    [".task-trial-chip", 11],
    [".message-meta", 11],
    [".message > p", 14],
    [".tool-summary-copy strong", 12],
    [".json-block pre", 12],
    [".context-tabs button", 11],
    [".markdown-document p", 13],
    [".context-section p", 13],
    [".prompt-pre,\n.raw-pre", 12],
    [".mobile-selectors select", 16],
  ]);

  for (const [selector, minimum] of minimums) {
    assert.ok(
      fontPixels(css, selector) >= minimum,
      `${selector} should be at least ${minimum}px`,
    );
  }
  assert.equal(css.split(".message > p {").length - 1, 1);
});

test("catalog indexes every official run, including agent-only ablations", async () => {
  const catalog = await readJson(catalogUrl);
  const expectedDomains = {
    "tau:airline": { runs: 2, trajectories: 600 },
    "tau:retail": { runs: 2, trajectories: 1_380 },
    "tau2:airline": { runs: 5, trajectories: 1_000 },
    "tau2:retail": { runs: 5, trajectories: 2_280 },
    "tau2:telecom": { runs: 19, trajectories: 8_664 },
  };

  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.datasetId, "official-conversational-v2");
  assert.equal(catalog.totals.runs, 33);
  assert.equal(catalog.totals.trajectories, 13_924);
  assert.deepEqual(catalog.agentOnly, {
    reason: "dummy_user ablations with zero user-role messages",
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
      runs.push({ domain, run });
    }
  }

  assert.equal(runs.length, 33);
  assert.equal(new Set(runs.map(({ run }) => run.id)).size, runs.length);

  const agentOnlyRuns = runs.filter(
    ({ run }) => run.userImplementation === "dummy_user",
  );
  assert.equal(agentOnlyRuns.length, 8);
  assert.equal(
    agentOnlyRuns.reduce((total, { run }) => total + run.trajectoryCount, 0),
    3_648,
  );
  assert.deepEqual(
    new Set(agentOnlyRuns.map(({ run }) => run.environmentId)),
    new Set(["telecom", "telecom-workflow"]),
  );
  assert.deepEqual(
    new Set(agentOnlyRuns.map(({ run }) => run.model)),
    new Set(["GPT-4.1", "o4-mini"]),
  );
  assert.deepEqual(
    new Set(agentOnlyRuns.map(({ run }) => run.mode)),
    new Set(["no-user", "no-user-oracle-plan"]),
  );
  assert.deepEqual(
    agentOnlyRuns
      .map(({ run }) => `${run.model}|${run.environmentId}|${run.mode}`)
      .sort(),
    [
      "GPT-4.1|telecom-workflow|no-user",
      "GPT-4.1|telecom-workflow|no-user-oracle-plan",
      "GPT-4.1|telecom|no-user",
      "GPT-4.1|telecom|no-user-oracle-plan",
      "o4-mini|telecom-workflow|no-user",
      "o4-mini|telecom-workflow|no-user-oracle-plan",
      "o4-mini|telecom|no-user",
      "o4-mini|telecom|no-user-oracle-plan",
    ].sort(),
  );
  for (const { domain, run } of agentOnlyRuns) {
    assert.equal(domain.id, "tau2:telecom");
    assert.equal(run.trajectoryCount, 456);
    assert.equal(run.userModel, "Not used");
    assert.equal(run.promptRef, "no-user");
    assert.match(run.sourceFile, /_no-user(?:-op)?_/);
  }
});

test("run indexes, task sets, and lazy trajectory details stay consistent", async () => {
  const catalog = await readJson(catalogUrl);
  const taskSets = new Map();
  const trajectoryIds = new Set();
  const chunkPaths = new Set();
  let indexedTrajectories = 0;
  let resolvedTrajectories = 0;
  let resolvedAgentOnlyTrajectories = 0;
  let expectedChunkCount = 0;
  let userToolExample;

  async function loadTaskSet(tasksPath) {
    if (!taskSets.has(tasksPath)) {
      taskSets.set(tasksPath, await readJson(publicAssetUrl(tasksPath)));
    }
    return taskSets.get(tasksPath);
  }

  for (const domain of catalog.domains) {
    const domainTaskGroups = new Map();
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

      const summariesByChunk = new Map();
      const runTaskGroups = new Map();
      for (const summary of index.trajectories) {
        assert.equal(summary.domainId, domain.id);
        assert.equal(summary.runId, run.id);
        assert.ok(taskSet.tasks[summary.taskId]);
        assert.ok(!trajectoryIds.has(summary.id), `duplicate trajectory id: ${summary.id}`);
        assert.match(
          summary.detailPath,
          new RegExp(`/chunks/${run.id}/chunk_[0-9]+\\.json$`),
        );
        assert.ok(summary.messageCount > 0);
        assert.ok(summary.toolCallCount >= summary.userToolCallCount);
        assert.deepEqual(
          summary.toolNames,
          [...new Set(summary.toolNames)].sort(),
        );
        trajectoryIds.add(summary.id);
        chunkPaths.add(summary.detailPath);
        indexedTrajectories += 1;

        const taskGroupKey = JSON.stringify([
          summary.domainId,
          run.tasksPath,
          summary.taskId,
        ]);
        const runTaskSummaries = runTaskGroups.get(taskGroupKey) ?? [];
        runTaskSummaries.push(summary);
        runTaskGroups.set(taskGroupKey, runTaskSummaries);
        const domainTaskSummaries = domainTaskGroups.get(taskGroupKey) ?? [];
        domainTaskSummaries.push(summary);
        domainTaskGroups.set(taskGroupKey, domainTaskSummaries);

        const chunkSummaries = summariesByChunk.get(summary.detailPath) ?? [];
        chunkSummaries.push(summary);
        summariesByChunk.set(summary.detailPath, chunkSummaries);
      }

      assert.equal(runTaskGroups.size, run.taskCount);
      for (const summaries of runTaskGroups.values()) {
        assert.equal(new Set(summaries.map((summary) => summary.trial)).size, summaries.length);
        assert.deepEqual(
          summaries.map((summary) => summary.trial).sort((a, b) => a - b),
          [...run.trials].sort((a, b) => a - b),
        );
      }

      assert.equal(summariesByChunk.size, Math.ceil(run.trajectoryCount / 20));
      expectedChunkCount += summariesByChunk.size;
      for (const [chunkPath, summaries] of summariesByChunk) {
        assert.ok(summaries.length > 0 && summaries.length <= 20);
        const payload = await readJson(publicAssetUrl(chunkPath));
        assert.equal(payload.schemaVersion, catalog.schemaVersion);
        assert.equal(payload.datasetId, catalog.datasetId);
        assert.deepEqual(
          Object.keys(payload.trajectories).sort(),
          summaries.map((summary) => summary.id).sort(),
        );

        for (const summary of summaries) {
          const trajectory = payload.trajectories[summary.id];
          assert.ok(trajectory, `missing ${summary.id} in ${chunkPath}`);
          const toolCalls = trajectory.messages.flatMap((message) => message.toolCalls);

          assert.equal(trajectory.id, summary.id);
          assert.equal(trajectory.runId, run.id);
          assert.equal(trajectory.taskId, summary.taskId);
          assert.equal(trajectory.trial, summary.trial);
          assert.equal(trajectory.reward, summary.reward);
          assert.equal(trajectory.title, summary.title);
          assert.equal(trajectory.terminationReason, summary.terminationReason);
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
          resolvedTrajectories += 1;

          if (run.userImplementation === "dummy_user") {
            assert.ok(run.mode.startsWith("no-user"));
            assert.ok(
              trajectory.messages.every((message) => message.role !== "user"),
            );
            assert.equal(summary.userToolCallCount, 0);
            resolvedAgentOnlyTrajectories += 1;
          }

          if (!userToolExample && summary.userToolCallCount > 0) {
            userToolExample = { domain, summary, trajectory };
          }
        }
      }
    }

    assert.equal(domainTaskGroups.size, domain.taskCount);
    assert.equal(
      [...domainTaskGroups.values()].reduce((total, summaries) => total + summaries.length, 0),
      domain.trajectoryCount,
    );
    const expectedTrajectoriesPerTask = domain.runs.reduce(
      (total, run) => total + run.trials.length,
      0,
    );
    for (const summaries of domainTaskGroups.values()) {
      assert.equal(summaries.length, expectedTrajectoriesPerTask);
      assert.equal(
        new Set(summaries.map((summary) => `${summary.runId}:${summary.trial}`)).size,
        summaries.length,
      );
      assert.equal(new Set(summaries.map((summary) => summary.title)).size, 1);
    }
  }

  assert.equal(indexedTrajectories, catalog.totals.trajectories);
  assert.equal(resolvedTrajectories, catalog.totals.trajectories);
  assert.equal(resolvedAgentOnlyTrajectories, catalog.agentOnly.trajectories);
  assert.equal(trajectoryIds.size, 13_924);
  assert.equal(chunkPaths.size, expectedChunkCount);
  assert.equal(chunkPaths.size, 701);
  assert.ok(taskSets.size >= 5, "expected content-addressed task sets for both benchmarks");

  assert.ok(userToolExample, "expected a Telecom trajectory with user-operated tools");
  assert.equal(userToolExample.domain.id, "tau2:telecom");
  assert.ok(
    userToolExample.domain.userPrompts.some((prompt) => prompt.id === "tool-enabled"),
  );
  const userToolCalls = userToolExample.trajectory.messages.flatMap((message) =>
    message.toolCalls.filter((call) => call.requestor === "user"),
  );
  assert.equal(userToolCalls.length, userToolExample.summary.userToolCallCount);
  assert.ok(userToolCalls.length > 0);

  const generatedEntries = await readdir(
    new URL("../public/data/", import.meta.url),
    { recursive: true, withFileTypes: true },
  );
  const generatedFileCount = generatedEntries.filter((entry) => entry.isFile()).length;
  assert.ok(generatedFileCount < 1_000, `generated ${generatedFileCount} public data files`);
});

test("ships a social preview", async () => {
  const preview = await readFile(new URL("../public/og.png", import.meta.url));
  assert.ok(preview.length > 0);
});
