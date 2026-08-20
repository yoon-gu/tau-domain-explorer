import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const catalogUrl = new URL("../app/data/benchmark-snapshot.json", import.meta.url);
const stylesheetUrl = new URL("../app/globals.css", import.meta.url);
const taskTranslationsUrl = new URL(
  "../app/data/task-translations.ko.json",
  import.meta.url,
);
const hangulPattern = /[\uac00-\ud7a3]/u;

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function publicAssetUrl(assetPath) {
  assert.match(assetPath, /^\/data\/[a-zA-Z0-9_./-]+\.json$/);
  return new URL(`../public${assetPath}`, import.meta.url);
}

function assertExactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} keys`,
  );
}

function assertKorean(value, label) {
  assert.equal(typeof value, "string", `${label} type`);
  assert.ok(value.trim().length > 0, `${label} must not be blank`);
  assert.match(value, hangulPattern, `${label} must contain Hangul`);
}

function protectedTaskLiterals(value) {
  const patterns = [
    /`[^`]+`/g,
    /https?:\/\/[^\s)\]}]+/g,
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
    /#[A-Za-z0-9_-]+/g,
    /\b\d{3}-\d{3}-\d{4}\b/g,
    /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{3,}\b/g,
    /\b[a-z]+(?:_[a-z0-9]+)+\b/g,
    /(?:\b\d{4}-\d{2}-\d{2}\b|\b\d{6,}\b)/g,
  ];
  return [...new Set(patterns.flatMap((pattern) => value.match(pattern) ?? []))]
    .filter((literal) => !/^\d{1,2}(?:am|pm|h|st|nd|rd|th)$/i.test(literal))
    .filter((literal) => !/^\d{1,3}-year-old$/i.test(literal));
}

function assertTranslationQuality(source, translated, label) {
  assertKorean(translated, label);
  assert.doesNotMatch(translated, /__TAU\d+TOKEN__/u, `${label} placeholder leak`);
  assert.doesNotMatch(translated, /\b\d{5}년/u, `${label} must not treat a ZIP code as a year`);
  for (const literal of protectedTaskLiterals(source)) {
    assert.ok(translated.includes(literal), `${label} must preserve ${literal}`);
  }
  if (source === "You do not remember your email address") {
    assert.match(translated, /기억나지 않습니다[.]?$/u, `${label} perspective`);
    assert.doesNotMatch(translated, /[?？]/u, `${label} must remain a statement`);
  }
  if (/\bboots?\b/i.test(source)) {
    assert.doesNotMatch(translated, /부팅/u, `${label} must translate boots as footwear`);
  }
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
    [".task-language-switch button", 11],
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

test("every task asset carries an exhaustive Korean presentation translation", async () => {
  const [catalog, translationSource] = await Promise.all([
    readJson(catalogUrl),
    readJson(taskTranslationsUrl),
  ]);
  assertExactKeys(
    translationSource,
    ["schemaVersion", "datasetId", "locale", "domains"],
    "task translation root",
  );
  assert.equal(translationSource.schemaVersion, 1);
  assert.equal(translationSource.datasetId, catalog.datasetId);
  assert.equal(translationSource.locale, "ko");
  assertExactKeys(
    translationSource.domains,
    catalog.domains.map((domain) => domain.id),
    "task translation domains",
  );

  const uniqueTaskAssets = new Set();
  let translatedTaskCount = 0;
  for (const domain of catalog.domains) {
    assert.ok(
      domain.userPrompts.every((prompt) => !hangulPattern.test(prompt.content)),
      `${domain.id} runtime user prompts must remain source English`,
    );
    const domainTranslation = translationSource.domains[domain.id];
    assertExactKeys(domainTranslation, ["tasks"], `${domain.id} translation domain`);
    const domainTaskPaths = new Set(domain.runs.map((run) => run.tasksPath));
    assert.equal(domainTaskPaths.size, 1, `${domain.id} should share one task asset`);

    for (const tasksPath of domainTaskPaths) {
      assert.ok(!uniqueTaskAssets.has(tasksPath), `task asset reused across domains: ${tasksPath}`);
      uniqueTaskAssets.add(tasksPath);
      const taskSet = await readJson(publicAssetUrl(tasksPath));
      assertExactKeys(
        domainTranslation.tasks,
        Object.keys(taskSet.tasks),
        `${domain.id} translated task IDs`,
      );

      for (const [taskId, taskEntry] of Object.entries(taskSet.tasks)) {
        const label = `${domain.id} task ${taskId}`;
        const sourceTranslation = domainTranslation.tasks[taskId];
        assertExactKeys(
          sourceTranslation,
          ["title", "descriptionPurpose", "scenario"],
          `${label} source translation`,
        );
        assert.deepEqual(taskEntry.translations, { ko: sourceTranslation });
        assertTranslationQuality(
          taskEntry.title,
          sourceTranslation.title,
          `${label} title`,
        );
        assert.doesNotMatch(taskEntry.title, hangulPattern, `${label} source title`);
        assert.doesNotMatch(
          JSON.stringify(taskEntry.task),
          hangulPattern,
          `${label} raw task must remain source English`,
        );
        assert.ok(!("translations" in taskEntry.task), `${label} raw task must not contain translations`);

        const expectedScenarioKeys = domain.benchmark === "tau"
          ? ["instruction"]
          : ["persona", "reasonForCall", "knownInfo", "unknownInfo", "taskInstructions"];
        const sourceScenarioKeys = Object.keys(taskEntry.scenario).filter(
          (key) => key !== "userId",
        );
        assert.deepEqual(
          [...sourceScenarioKeys].sort(),
          [...expectedScenarioKeys].sort(),
          `${label} source scenario keys`,
        );
        assertExactKeys(
          sourceTranslation.scenario,
          sourceScenarioKeys,
          `${label} translated scenario`,
        );
        assert.ok(!("userId" in sourceTranslation.scenario), `${label} must not translate userId`);
        for (const key of sourceScenarioKeys) {
          const sourceValue = taskEntry.scenario[key];
          const translatedValue = sourceTranslation.scenario[key];
          assert.ok(
            sourceValue === null || typeof sourceValue === "string",
            `${label} scenario.${key} source type`,
          );
          if (sourceValue === null) {
            assert.equal(translatedValue, null, `${label} scenario.${key} null parity`);
          } else {
            assert.doesNotMatch(sourceValue, hangulPattern, `${label} scenario.${key} source`);
            assertTranslationQuality(
              sourceValue,
              translatedValue,
              `${label} scenario.${key}`,
            );
          }
        }

        const sourceDescriptionPurpose = domain.benchmark === "tau2"
          ? taskEntry.task.description?.purpose ?? null
          : null;
        if (sourceDescriptionPurpose === null) {
          assert.equal(
            sourceTranslation.descriptionPurpose,
            null,
            `${label} descriptionPurpose null parity`,
          );
        } else {
          assert.equal(typeof sourceDescriptionPurpose, "string");
          assert.doesNotMatch(
            sourceDescriptionPurpose,
            hangulPattern,
            `${label} description purpose source`,
          );
          assertTranslationQuality(
            sourceDescriptionPurpose,
            sourceTranslation.descriptionPurpose,
            `${label} descriptionPurpose`,
          );
        }

        if (domain.benchmark === "tau") {
          assert.equal(taskEntry.scenario.userId, taskEntry.task.user_id, `${label} userId`);
        } else {
          const rawScenario = taskEntry.task.user_scenario;
          const rawInstructions = rawScenario.instructions;
          assert.ok(rawInstructions && typeof rawInstructions === "object");
          assert.equal(taskEntry.scenario.persona, rawScenario.persona ?? null);
          assert.equal(taskEntry.scenario.reasonForCall, rawInstructions.reason_for_call ?? null);
          assert.equal(taskEntry.scenario.knownInfo, rawInstructions.known_info ?? null);
          assert.equal(taskEntry.scenario.unknownInfo, rawInstructions.unknown_info ?? null);
          assert.equal(taskEntry.scenario.taskInstructions, rawInstructions.task_instructions ?? null);
        }
        translatedTaskCount += 1;
      }
    }
  }

  assert.equal(uniqueTaskAssets.size, 5);
  assert.equal(translatedTaskCount, 443);
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
