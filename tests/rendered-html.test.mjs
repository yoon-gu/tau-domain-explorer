import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const catalogUrl = new URL("../app/data/benchmark-snapshot.json", import.meta.url);
const stylesheetUrl = new URL("../app/globals.css", import.meta.url);
const taskTranslationsUrl = new URL(
  "../app/data/task-translations.ko.json",
  import.meta.url,
);
const contextTranslationsUrl = new URL(
  "../app/data/gpt5-context-translations.ko.json",
  import.meta.url,
);
const toolTranslationsUrl = new URL(
  "../app/data/gpt5-tool-translations.ko.json",
  import.meta.url,
);
const transcriptTranslationsDirectoryUrl = new URL(
  "../app/data/gpt5-transcript-translations.ko/",
  import.meta.url,
);
const hangulPattern = /[\uac00-\ud7a3]/u;
const controlOnlyPattern = /^\s*###(?:STOP|TRANSFER|OUT-OF-SCOPE)###\s*$/iu;
const toolClassifierVersion = "tau2-tool-ascii-prose-v1";
const toolUrlOnlyPattern = /^https?:\/\/\S+$/iu;
const toolEmailOnlyPattern = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/iu;
const toolCompactUpperCodePattern = /^#?[A-Z0-9_-]+$/u;
const toolCompactMixedAlnumPattern = /^(?=.*[A-Za-z])(?=.*\d)\S+$/u;
const toolSnakeIdentifierPattern = /^[a-z0-9]+(?:_[a-z0-9]+)+$/u;
const protectedContextSource = [
  "###(?:STOP|TRANSFER|OUT-OF-SCOPE)###",
  "`[^`]+`",
  "https?://[^\\s)\\]}>]+",
  "[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}",
  "\\b\\d{3}-\\d{3}-\\d{4}\\b",
  "#[A-Za-z0-9_-]+",
  "\\b\\d{4}-\\d{2}-\\d{2}\\b",
  "\\b\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[AP]M)?\\b",
  "[$€£¥]\\s?\\d(?:\\d|[,.](?=\\d))*(?:\\s?(?:USD|EUR|GBP|KRW))?",
  "\\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9_-]{3,}\\b",
  "\\b[a-z][a-z0-9_]+\\((?=[^()\\n]*(?:=|[\"']))[^()\\n]*\\)",
  "\\b[a-z]+(?:_[a-z0-9]+)+\\b",
  "\\b\\d+(?:[.,]\\d+)*[A-Za-z]{1,6}\\b",
  "\\b\\d+(?:[.,]\\d+)*(?:%|st|nd|rd|th)?\\b",
].join("|");
const toolProtectedCodeTokens = [
  "AA", "AC", "AM", "APN", "ATL", "BOS", "CF", "CLT", "DEN", "DOB", "DTW",
  "ET", "EWR", "GB", "HD", "HEPA", "HLR", "HSS", "HXDUBJ", "IAH", "ID",
  "IFOYYZ", "IL", "IR", "JFK", "LAS", "LAX", "LED", "LGA", "MCO", "MIA",
  "MMS", "MMSC", "MSP", "MXP", "ORD", "PDP", "PGW", "PHL", "PHX", "PIN",
  "POOR", "PUK", "SD", "SEA", "SFO", "SIM", "SMF", "SMS", "SSD", "TX",
  "URL", "USA", "USD", "VPN", "ZIP",
].join("|");
const toolProtectedSource = `${protectedContextSource}|\\b(?:${toolProtectedCodeTokens})(?:-(?:${toolProtectedCodeTokens}))*\\b`;

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

async function readJsonWithRaw(url) {
  const raw = await readFile(url, "utf8");
  return { raw, value: JSON.parse(raw) };
}

function publicAssetUrl(assetPath) {
  assert.match(assetPath, /^\/data\/[a-zA-Z0-9_./-]+\.json$/);
  return new URL(`../public${assetPath}`, import.meta.url);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function protectedContextLiterals(value, protectedSource = protectedContextSource) {
  return [...value.matchAll(new RegExp(protectedSource, "gu"))]
    .map((match) => match[0])
    .sort();
}

function assertContextTranslation(
  source,
  translated,
  label,
  { korean = true, protectedSource = protectedContextSource } = {},
) {
  if (korean) assertKorean(translated, label);
  else {
    assert.equal(typeof translated, "string", `${label} type`);
    assert.ok(translated.trim(), `${label} must not be blank`);
  }
  assert.deepEqual(
    protectedContextLiterals(translated, protectedSource),
    protectedContextLiterals(source, protectedSource),
    `${label} protected literals`,
  );
}

function assertTranscriptNaturalness(source, translated, role, domainId, label) {
  const globallyMechanical = [
    /귀하/u,
    /당신/u,
    /제공하십시오/u,
    /계정을 식별/u,
    /고객님의 고객 ID/u,
    /제가 도와드릴 수 있어요/u,
    /예약을 예약/u,
    /\\n원문 표기:/u,
    /(?:지불|결제) 할당/u,
    /이름과 이름/u,
    /그것은 제가 필요한 모든 것을 다룹니다/u,
    /고객님은 그것을 얻었습니다/u,
    /정말 천만에요/u,
    /\$\d(?:\d|[,.](?=\d))*[,.][가-힣]/u,
  ];
  for (const pattern of globallyMechanical) {
    assert.doesNotMatch(translated, pattern, `${label} mechanical Korean: ${pattern}`);
  }

  if (role === "assistant") {
    assert.doesNotMatch(
      translated,
      /(?:^|[\s"'“‘(])(?:제|내)\s*(?:계정|회선|휴대폰|전화|SIM)\b/imu,
      `${label} assistant perspective`,
    );
  }

  if (domainId === "tau2:retail") {
    if (/\bboots?\b/iu.test(source)) {
      assert.doesNotMatch(translated, /부팅/u, `${label} boots must mean footwear`);
    }
    if (/\bpuzzle\b[\s\S]*\bpieces\b|\bpieces\b[\s\S]*\bpuzzle\b/iu.test(source)) {
      assert.doesNotMatch(translated, /작품/u, `${label} puzzle pieces`);
    }
    if (/\border (?:was |has been )?placed\b|\bplaced (?:the |an? )?order\b/iu.test(source)) {
      assert.doesNotMatch(translated, /배치/u, `${label} placed order`);
    }
    if (/\bon file\b/iu.test(source)) {
      assert.doesNotMatch(translated, /파일/u, `${label} on-file account data`);
    }
    assert.doesNotMatch(translated, /\bi[칠오]\b|\bx이\b/u, `${label} product model`);
  }

  if (domainId === "tau2:airline") {
    if (/\breturn\b/iu.test(source) && /\b(?:flight|date|leg|trip|itinerary)\b|same day/iu.test(source)) {
      assert.doesNotMatch(
        translated,
        /당일\s*반환|귀국[^\n.]{0,30}반환|반환[^\n.]{0,30}(?:귀국|항공편|일정|날짜)/u,
        `${label} return flight`,
      );
    }
    if (/\bdirect\b/iu.test(source) && /\bflight/iu.test(source)) {
      assert.doesNotMatch(
        translated,
        /직접\s*(?:및|항공편|편|비행)/u,
        `${label} direct flight`,
      );
    }
  }

  if (domainId === "tau2:telecom") {
    const proseOnly = translated.replace(
      /\b[a-z][a-z0-9_]+\((?=[^()\n]*(?:=|["']))[^()\n]*\)/gu,
      "",
    );
    assert.doesNotMatch(
      proseOnly,
      /연료(?:를)?\s*보급|서비스 안 함|서비스를 제공하지 않음|서비스가 제공되지 않|실행 그리고|추가했습니다\s*\d|MMS 다시/u,
      `${label} telecom terminology`,
    );
    assert.doesNotMatch(
      proseOnly,
      /\b(?:No Service|No Signal|Data Disabled)\b/u,
      `${label} untranslated status label`,
    );
  }
}

function assertToolTranslation(source, translated, label) {
  assertKorean(translated, label);
  assert.doesNotMatch(translated, /__TAU\d+TOKEN__/u, `${label} placeholder leak`);
  const counts = (value) => {
    const output = new Map();
    for (const literal of protectedContextLiterals(value, toolProtectedSource)) {
      output.set(literal, (output.get(literal) ?? 0) + 1);
    }
    return output;
  };
  const expected = counts(source);
  const actual = counts(translated);
  for (const [literal, count] of expected) {
    assert.ok(
      (actual.get(literal) ?? 0) >= count,
      `${label} must preserve ${literal}`,
    );
  }
  const controls = (value) => (value.match(/###(?:STOP|TRANSFER|OUT-OF-SCOPE)###/giu) ?? [])
    .map((token) => token.toUpperCase())
    .sort();
  assert.deepEqual(controls(translated), controls(source), `${label} control tokens`);
}

function assertSourceHashDocument(record, source, label, options) {
  assertExactKeys(record, ["sourceHash", "content"], label);
  assert.equal(record.sourceHash, sha256(source), `${label} source hash`);
  assertContextTranslation(source, record.content, label, options);
}

function assertContentAddressedAsset(assetPath, raw, label) {
  const digest = sha256(raw);
  assert.match(
    assetPath,
    new RegExp(`_${digest.slice(0, 18)}\\.json$`),
    `${label} content-addressed path`,
  );
  return digest;
}

function messageTranslationIdentity(role, content) {
  const sourceHash = sha256(JSON.stringify([role, content]));
  return { id: `msg_${sourceHash.slice(0, 24)}`, sourceHash };
}

function toolTranslationIdentity(content) {
  const sourceHash = sha256(content);
  return { id: `tool_${sourceHash.slice(0, 24)}`, sourceHash };
}

function isToolTranslationEligible(value) {
  const compact = value.trim();
  return Boolean(compact)
    && /[A-Za-z]/u.test(compact)
    && !controlOnlyPattern.test(compact)
    && !toolUrlOnlyPattern.test(compact)
    && !toolEmailOnlyPattern.test(compact)
    && !toolCompactUpperCodePattern.test(compact)
    && !toolCompactMixedAlnumPattern.test(compact)
    && !toolSnakeIdentifierPattern.test(compact);
}

function jsonPointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function visitStringLeaves(value, pointer, visitor) {
  if (typeof value === "string") {
    visitor(value, pointer);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visitStringLeaves(item, `${pointer}/${index}`, visitor);
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visitStringLeaves(item, `${pointer}/${jsonPointerSegment(key)}`, visitor);
    }
  }
}

function resolveJsonPointer(value, pointer, label) {
  assert.match(pointer, /^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])*)*$/u, `${label} syntax`);
  let cursor = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(cursor)) {
      assert.match(segment, /^(?:0|[1-9]\d*)$/u, `${label} array index`);
      const index = Number(segment);
      assert.ok(index < cursor.length, `${label} array bounds`);
      cursor = cursor[index];
    } else {
      assert.ok(cursor && typeof cursor === "object", `${label} object parent`);
      assert.ok(Object.prototype.hasOwnProperty.call(cursor, segment), `${label} property`);
      cursor = cursor[segment];
    }
  }
  return cursor;
}

function createSurfaceCounter() {
  return { occurrences: 0, values: new Set() };
}

function recordSurface(counter, value) {
  counter.occurrences += 1;
  counter.values.add(value);
}

function surfaceTotals(counter) {
  return { occurrences: counter.occurrences, unique: counter.values.size };
}

function pythonStringRepr(value) {
  const useDouble = value.includes("'") && !value.includes('"');
  const quote = useDouble ? '"' : "'";
  let escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
  escaped = useDouble
    ? escaped.replaceAll('"', '\\"')
    : escaped.replaceAll("'", "\\'");
  return `${quote}${escaped}${quote}`;
}

function pythonListRepr(values) {
  return `[${values.map(pythonStringRepr).join(", ")}]`;
}

function resolveTemplate(template, replacements, label) {
  let output = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    assert.equal(
      output.split(placeholder).length - 1,
      1,
      `${label} must contain one ${placeholder}`,
    );
    output = output.replace(placeholder, value);
  }
  return output;
}

function resolvedTemplateValues(template, resolved, placeholders, label) {
  let expression = "^";
  let cursor = 0;
  for (const placeholder of placeholders) {
    const index = template.indexOf(placeholder, cursor);
    assert.ok(index >= cursor, `${label} missing ${placeholder}`);
    expression += template.slice(cursor, index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expression += "([\\s\\S]*?)";
    cursor = index + placeholder.length;
  }
  expression += `${template.slice(cursor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const match = resolved.match(new RegExp(expression, "u"));
  assert.ok(match, `${label} must resolve the pinned template exactly`);
  return Object.fromEntries(placeholders.map((placeholder, index) => [placeholder, match[index + 1]]));
}

function parsedRoleTranscript(value, label) {
  const markers = [...value.matchAll(/^(assistant|user|tool): /gmu)];
  assert.ok(markers.length > 0, `${label} role markers`);
  return markers.map((match, index) => {
    const start = match.index + match[0].length;
    const next = markers[index + 1]?.index ?? value.length;
    const end = index + 1 < markers.length ? next - 1 : next;
    return { role: match[1], content: value.slice(start, end) };
  });
}

function localizedToolValue(value, toolEntries, expectedToolSources, label) {
  if (typeof value === "string") {
    if (!isToolTranslationEligible(value)) return value;
    const identity = toolTranslationIdentity(value);
    const expected = expectedToolSources.get(identity.id);
    assert.deepEqual(expected, { sourceHash: identity.sourceHash, content: value }, label);
    const translation = toolEntries[identity.id];
    assert.ok(translation, `${label} missing ${identity.id}`);
    return translation.content;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      localizedToolValue(item, toolEntries, expectedToolSources, `${label}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      localizedToolValue(item, toolEntries, expectedToolSources, `${label}.${key}`),
    ]));
  }
  return value;
}

function localizedToolMessageContent(content, toolEntries, expectedToolSources, label) {
  try {
    return JSON.stringify(localizedToolValue(
      JSON.parse(content),
      toolEntries,
      expectedToolSources,
      label,
    ));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return localizedToolValue(content, toolEntries, expectedToolSources, label);
  }
}

function localizedEvaluatorTrajectory(
  source,
  memory,
  toolEntries,
  expectedToolSources,
  label,
) {
  const roleLabels = { assistant: "상담원", user: "사용자", tool: "도구" };
  return parsedRoleTranscript(source, label).map(({ role, content }, index) => {
    if (content === "None") return `${roleLabels[role]}: 없음`;
    if (role === "tool") {
      return `${roleLabels[role]}: ${localizedToolMessageContent(
        content,
        toolEntries,
        expectedToolSources,
        `${label} tool message ${index}`,
      )}`;
    }
    if (!content.trim() || controlOnlyPattern.test(content)) {
      return `${roleLabels[role]}: ${content}`;
    }
    const identity = messageTranslationIdentity(role, content);
    const entry = memory.entries[identity.id];
    assert.ok(entry, `${label} missing ${identity.id}`);
    assert.equal(entry.role, role, `${label} ${identity.id} role`);
    assert.equal(entry.sourceHash, identity.sourceHash, `${label} ${identity.id} hash`);
    return `${roleLabels[role]}: ${entry.content}`;
  }).join("\n");
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

function minimumHeightPixels(css, selector) {
  const block = selectorBlock(css, selector);
  const value = block.match(/min-height:\s*(\d+)px/)?.[1];
  assert.ok(value, `missing pixel min-height for ${selector}`);
  return Number(value);
}

test("server-renders the pinned τ² GPT-5 explorer shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>τ² GPT-5 Explorer/);
  assert.match(html, /TAU Explorer/);
  assert.match(html, /τ² · GPT-5/);
  assert.match(html, /Catalog view/);
  assert.match(html, />Tasks</);
  assert.match(html, />Trajectories</);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("uses a readable typography scale across the explorer", async () => {
  const css = await readFile(stylesheetUrl, "utf8");
  const minimums = new Map([
    [".brand-name", 14],
    [".brand-subtitle", 12],
    [".task-language-switch button", 11],
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

test("keeps the mobile explorer readable and touch friendly", async () => {
  const css = await readFile(stylesheetUrl, "utf8");
  const mobileStart = css.indexOf("@media (max-width: 820px)");
  const compactStart = css.indexOf("@media (max-width: 520px)", mobileStart);
  assert.ok(mobileStart >= 0 && compactStart > mobileStart, "mobile media queries");
  const mobileCss = css.slice(mobileStart, compactStart);

  assert.match(mobileCss, /\.desktop-task-language\s*\{\s*display:\s*grid;/u);
  assert.match(mobileCss, /\.mobile-task-language\s*\{\s*display:\s*none;/u);
  assert.ok(minimumHeightPixels(mobileCss, ".desktop-task-language button") >= 44);
  assert.ok(minimumHeightPixels(mobileCss, ".mobile-selectors select") >= 44);
  assert.ok(minimumHeightPixels(mobileCss, ".mobile-browser-trigger") >= 44);
  assert.ok(minimumHeightPixels(mobileCss, ".score-badge") >= 44);
  assert.ok(minimumHeightPixels(mobileCss, ".context-trigger") >= 44);
  assert.ok(minimumHeightPixels(mobileCss, ".context-close") >= 44);
  assert.ok(minimumHeightPixels(mobileCss, ".mini-switch button") >= 44);
  assert.ok(
    minimumHeightPixels(
      mobileCss,
      ".trajectory-browser.mobile-open .catalog-view-switch button",
    ) >= 44,
  );
  assert.ok(
    minimumHeightPixels(
      mobileCss,
      ".trajectory-browser.mobile-open .outcome-filter button,\n  .trajectory-browser.mobile-open .mini-switch button,\n  .trajectory-browser.mobile-open .quiet-button",
    ) >= 44,
  );
  assert.match(
    selectorBlock(mobileCss, ".context-close"),
    /flex:\s*0\s+0\s+44px/u,
  );
  assert.ok(
    minimumHeightPixels(
      mobileCss,
      ".trajectory-toolbar button,\n  .trajectory-toolbar a",
    ) >= 44,
  );
});

test("catalog is narrowed to the three official τ² GPT-5 runs", async () => {
  const catalog = await readJson(catalogUrl);
  const expectedDomains = {
    "tau2:airline": {
      tasks: 50,
      trajectories: 200,
      chunks: 10,
      pass: 125,
      fail: 75,
      agentTools: 14,
      userTools: 0,
      runId: "run_cJ5pvG-VbK9x6vYlpe",
      promptId: "standard",
      promptSource: "data/tau2/user_simulator/simulation_guidelines.md",
    },
    "tau2:retail": {
      tasks: 114,
      trajectories: 456,
      chunks: 23,
      pass: 372,
      fail: 84,
      agentTools: 15,
      userTools: 0,
      runId: "run_o7OQCUdXVT5V8W3TkF",
      promptId: "standard",
      promptSource: "data/tau2/user_simulator/simulation_guidelines.md",
    },
    "tau2:telecom": {
      tasks: 114,
      trajectories: 456,
      chunks: 23,
      pass: 437,
      fail: 19,
      agentTools: 13,
      userTools: 30,
      runId: "run_NkQuH5ORPpc2f1qZ8t",
      promptId: "tool-enabled",
      promptSource: "data/tau2/user_simulator/simulation_guidelines_tools.md",
    },
  };

  assertExactKeys(
    catalog,
    [
      "schemaVersion",
      "datasetId",
      "generatedAt",
      "notice",
      "agentOnly",
      "selection",
      "sources",
      "totals",
      "translationTotals",
      "runtimePrompts",
      "domains",
    ],
    "catalog root",
  );
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.datasetId, "tau2-gpt5-sierra-2025-08-09-v1");
  assert.deepEqual(catalog.selection, {
    benchmark: "tau2",
    model: "GPT-5",
    submission: "gpt-5_sierra_2025-08-09",
    release: "v0.2.0",
    runtimeCommit: "964ef7aed331ecf0c9bc592abdc2b4aecd941586",
  });
  assert.deepEqual(catalog.totals, {
    runs: 3,
    tasks: 278,
    trajectories: 1_112,
    detailChunks: 56,
    detailBytes: catalog.totals.detailBytes,
  });
  assert.ok(catalog.totals.detailBytes > 0);
  assert.deepEqual(catalog.agentOnly, {
    reason: "The selected GPT-5 submission contains interactive user simulations only.",
    runs: 0,
    trajectories: 0,
  });
  assert.deepEqual(catalog.translationTotals, {
    locale: "ko",
    transcriptOverlays: 56,
    messageContents: 14_018,
    translatedMessageContents: 13_735,
    controlOnlyContents: 283,
    evaluatorPrompts: 232,
    contexts: 3,
    toolLeaves: {
      classifierVersion: toolClassifierVersion,
      calls: 15_157,
      all: { occurrences: 188_101, unique: 3_396 },
      translated: { occurrences: 72_782, unique: 1_057 },
      translatedArguments: { occurrences: 2_333, unique: 309 },
      translatedResults: { occurrences: 70_449, unique: 861 },
      codeOnly: { occurrences: 115_319, unique: 2_339 },
    },
  });
  assert.deepEqual(
    catalog.sources,
    [{
      id: "tau2",
      label: "τ²-bench",
      repository: "https://github.com/sierra-research/tau2-bench",
      revision: "v0.2.0",
      runtimeCommit: "964ef7aed331ecf0c9bc592abdc2b4aecd941586",
      dataCommit: "f8de30c298689cbe0117d76a378e7315a17e5bd8",
      license: "MIT",
    }],
  );
  assert.deepEqual(
    catalog.domains.map((domain) => domain.id),
    Object.keys(expectedDomains),
  );

  for (const domain of catalog.domains) {
    const expected = expectedDomains[domain.id];
    assert.ok(expected);
    assertExactKeys(
      domain,
      [
        "id",
        "benchmark",
        "benchmarkLabel",
        "versionLabel",
        "slug",
        "name",
        "summary",
        "taskCount",
        "trajectoryCount",
        "toolCount",
        "agentToolCount",
        "userToolCount",
        "policy",
        "policySource",
        "policyUrl",
        "userPrompts",
        "promptSource",
        "promptUrl",
        "source",
        "defaultRunId",
        "policySnapshots",
        "contextTranslationPath",
        "runs",
      ],
      `${domain.id} catalog domain`,
    );
    assert.equal(domain.benchmark, "tau2");
    assert.equal(domain.benchmarkLabel, "τ²-bench");
    assert.equal(domain.versionLabel, "v0.2.0");
    assert.equal(domain.taskCount, expected.tasks);
    assert.equal(domain.trajectoryCount, expected.trajectories);
    assert.equal(domain.agentToolCount, expected.agentTools);
    assert.equal(domain.userToolCount, expected.userTools);
    assert.equal(domain.toolCount, expected.agentTools + expected.userTools);
    assert.ok(domain.policy.length > 1_000);
    assert.equal(domain.runs.length, 1);
    assert.equal(domain.defaultRunId, expected.runId);
    assert.equal(domain.userPrompts.length, 1);
    const [prompt] = domain.userPrompts;
    assertExactKeys(
      prompt,
      [
        "id",
        "label",
        "description",
        "content",
        "sourceHash",
        "sourceUrl",
        "sourceLinks",
      ],
      `${domain.id} user prompt`,
    );
    assert.equal(prompt.id, expected.promptId);
    assert.equal(prompt.sourceHash, sha256(prompt.content));
    assert.equal(
      prompt.sourceUrl,
      "https://github.com/sierra-research/tau2-bench/blob/964ef7aed331ecf0c9bc592abdc2b4aecd941586/src/tau2/user/user_simulator.py",
    );
    assert.deepEqual(prompt.sourceLinks, [
      {
        label: "Runtime wrapper",
        sourcePath: "src/tau2/user/user_simulator.py",
        sourceUrl: prompt.sourceUrl,
      },
      {
        label: "Simulation guidelines",
        sourcePath: expected.promptSource,
        sourceUrl: `https://github.com/sierra-research/tau2-bench/blob/964ef7aed331ecf0c9bc592abdc2b4aecd941586/${expected.promptSource}`,
      },
    ]);
    assert.equal(
      domain.promptSource,
      `src/tau2/user/user_simulator.py + ${expected.promptSource}`,
    );
    assert.equal(domain.promptUrl, prompt.sourceUrl);
    assert.equal(domain.policySnapshots.length, 1);
    assert.match(domain.contextTranslationPath, /^\/data\/.*\.json$/);
    assert.deepEqual(domain.source, {
      repository: "sierra-research/tau2-bench",
      commit: "964ef7aed331ecf0c9bc592abdc2b4aecd941586",
      release: "v0.2.0",
      dataCommit: "f8de30c298689cbe0117d76a378e7315a17e5bd8",
      license: "MIT",
    });

    const run = domain.runs[0];
    assertExactKeys(
      run,
      [
        "id",
        "label",
        "model",
        "userModel",
        "mode",
        "environmentId",
        "policyVariant",
        "agentImplementation",
        "userImplementation",
        "taskCount",
        "trajectoryCount",
        "passCount",
        "failCount",
        "trials",
        "policySnapshotId",
        "promptRef",
        "indexPath",
        "tasksPath",
        "sourceFile",
        "sourceUrl",
      ],
      `${domain.id} run`,
    );
    assert.equal(run.id, expected.runId);
    assert.equal(run.model, "GPT-5");
    assert.equal(run.userModel, "gpt-4.1-2025-04-14");
    assert.equal(run.mode, "default");
    assert.equal(run.environmentId, domain.slug);
    assert.equal(run.policyVariant, "standard");
    assert.equal(run.agentImplementation, "llm_agent");
    assert.equal(run.userImplementation, "user_simulator");
    assert.equal(run.taskCount, expected.tasks);
    assert.equal(run.trajectoryCount, expected.trajectories);
    assert.equal(run.passCount, expected.pass);
    assert.equal(run.failCount, expected.fail);
    assert.deepEqual(run.trials, [0, 1, 2, 3]);
    assert.equal(run.policySnapshotId, domain.policySnapshots[0].id);
    assert.equal(run.promptRef, domain.userPrompts[0].id);
    assert.match(run.indexPath, /^\/data\/.*\.json$/);
    assert.match(run.tasksPath, /^\/data\/.*\.json$/);
  }

  assert.equal(
    Object.values(expectedDomains).reduce((sum, domain) => sum + domain.chunks, 0),
    catalog.totals.detailChunks,
  );
});

test("selected task assets carry exhaustive Korean task and runtime-scenario translations", async () => {
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
    "selected task translation domains",
  );

  const uniqueTaskAssets = new Set();
  let translatedTaskCount = 0;
  for (const domain of catalog.domains) {
    assert.ok(translationSource.domains[domain.id], `missing ${domain.id} task translations`);
    assert.ok(
      domain.userPrompts.every((prompt) => !hangulPattern.test(prompt.content)),
      `${domain.id} runtime user prompts must remain source English`,
    );
    const domainTranslation = translationSource.domains[domain.id];
    assertExactKeys(domainTranslation, ["tasks"], `${domain.id} translation domain`);
    const domainTaskPaths = new Set(domain.runs.map((run) => run.tasksPath));
    assert.equal(domainTaskPaths.size, 1);
    const [tasksPath] = domainTaskPaths;
    assert.ok(!uniqueTaskAssets.has(tasksPath), `task asset reused across domains: ${tasksPath}`);
    uniqueTaskAssets.add(tasksPath);

    const { raw, value: taskSet } = await readJsonWithRaw(publicAssetUrl(tasksPath));
    assertContentAddressedAsset(tasksPath, raw, `${domain.id} task asset`);
    assert.equal(taskSet.schemaVersion, catalog.schemaVersion);
    assert.equal(taskSet.datasetId, catalog.datasetId);
    assert.equal(Object.keys(taskSet.tasks).length, domain.taskCount);
    assertExactKeys(
      domainTranslation.tasks,
      Object.keys(taskSet.tasks),
      `${domain.id} translated task IDs`,
    );

    for (const [taskId, taskEntry] of Object.entries(taskSet.tasks)) {
      const label = `${domain.id} task ${taskId}`;
      const sourceTranslation = domainTranslation.tasks[taskId];
      const generatedTranslation = taskEntry.translations?.ko;
      assertExactKeys(
        sourceTranslation,
        ["title", "descriptionPurpose", "scenario"],
        `${label} source translation`,
      );
      assertExactKeys(
        generatedTranslation,
        ["title", "descriptionPurpose", "scenario", "runtimeScenario"],
        `${label} generated translation`,
      );
      assert.equal(generatedTranslation.title, sourceTranslation.title);
      assert.equal(
        generatedTranslation.descriptionPurpose,
        sourceTranslation.descriptionPurpose,
      );
      assert.deepEqual(generatedTranslation.scenario, sourceTranslation.scenario);
      assertTranslationQuality(taskEntry.title, generatedTranslation.title, `${label} title`);
      assert.doesNotMatch(taskEntry.title, hangulPattern, `${label} source title`);
      assert.doesNotMatch(
        JSON.stringify(taskEntry.task),
        hangulPattern,
        `${label} raw task must remain source English`,
      );
      assert.ok(!("translations" in taskEntry.task), `${label} raw task translations`);

      const scenarioKeys = [
        "persona",
        "reasonForCall",
        "knownInfo",
        "unknownInfo",
        "taskInstructions",
      ];
      assertExactKeys(taskEntry.scenario, scenarioKeys, `${label} source scenario`);
      assertExactKeys(
        generatedTranslation.scenario,
        scenarioKeys,
        `${label} translated scenario`,
      );
      for (const key of scenarioKeys) {
        const sourceValue = taskEntry.scenario[key];
        const translatedValue = generatedTranslation.scenario[key];
        assert.ok(
          sourceValue === null || typeof sourceValue === "string",
          `${label} scenario.${key} source type`,
        );
        if (sourceValue === null) {
          assert.equal(translatedValue, null, `${label} scenario.${key} null parity`);
        } else {
          assert.doesNotMatch(sourceValue, hangulPattern, `${label} scenario.${key} source`);
          assertTranslationQuality(sourceValue, translatedValue, `${label} scenario.${key}`);
        }
      }

      const rawScenario = taskEntry.task.user_scenario;
      const rawInstructions = rawScenario.instructions;
      assert.ok(rawInstructions && typeof rawInstructions === "object");
      assert.equal(taskEntry.scenario.persona, rawScenario.persona ?? null);
      assert.equal(taskEntry.scenario.reasonForCall, rawInstructions.reason_for_call ?? null);
      assert.equal(taskEntry.scenario.knownInfo, rawInstructions.known_info ?? null);
      assert.equal(taskEntry.scenario.unknownInfo, rawInstructions.unknown_info ?? null);
      assert.equal(taskEntry.scenario.taskInstructions, rawInstructions.task_instructions ?? null);

      const sourceDescriptionPurpose = taskEntry.task.description?.purpose ?? null;
      if (sourceDescriptionPurpose === null) {
        assert.equal(generatedTranslation.descriptionPurpose, null);
      } else {
        assertTranslationQuality(
          sourceDescriptionPurpose,
          generatedTranslation.descriptionPurpose,
          `${label} descriptionPurpose`,
        );
      }
      assert.equal(typeof taskEntry.runtimeScenario, "string");
      assert.doesNotMatch(taskEntry.runtimeScenario, hangulPattern);
      assertTranslationQuality(
        taskEntry.runtimeScenario,
        generatedTranslation.runtimeScenario,
        `${label} runtime scenario`,
      );
      translatedTaskCount += 1;
    }
  }

  assert.equal(uniqueTaskAssets.size, 3);
  assert.equal(translatedTaskCount, 278);
});

test("context assets preserve actual runtime provenance and complete Korean prompt overlays", async () => {
  const [catalog, source] = await Promise.all([
    readJson(catalogUrl),
    readJson(contextTranslationsUrl),
  ]);
  assertExactKeys(
    source,
    ["schemaVersion", "datasetId", "locale", "model", "common", "domains"],
    "context translation root",
  );
  assert.equal(source.schemaVersion, 1);
  assert.equal(source.datasetId, catalog.datasetId);
  assert.equal(source.locale, "ko");
  assert.equal(source.model, "GPT-5");
  assertExactKeys(
    source.common,
    [
      "agentInstruction",
      "agentTemplate",
      "evaluatorSystem",
      "evaluatorUserTemplate",
      "evaluationAssertions",
    ],
    "context common translations",
  );
  assertExactKeys(
    source.domains,
    catalog.domains.map((domain) => domain.id),
    "context translation domains",
  );

  const runtime = catalog.runtimePrompts;
  for (const [label, document] of [
    ["agent instruction", runtime.agent.instruction],
    ["agent template", runtime.agent.systemTemplate],
    ["evaluator system", runtime.evaluator.system],
    ["evaluator user template", runtime.evaluator.userTemplate],
  ]) {
    assert.equal(document.sourceHash, sha256(document.content), `${label} runtime hash`);
    assert.match(document.sourceUrl, /\/blob\/964ef7aed331ecf0c9bc592abdc2b4aecd941586\//);
  }
  assert.equal(runtime.agent.model, "GPT-5");
  assert.equal(runtime.evaluator.model, "gpt-4o-mini");
  assert.equal(runtime.evaluator.temperature, 0);
  assert.equal(runtime.evaluator.invocationCount, 232);

  assertSourceHashDocument(
    source.common.agentInstruction,
    runtime.agent.instruction.content,
    "agent instruction translation",
  );
  assertSourceHashDocument(
    source.common.agentTemplate,
    runtime.agent.systemTemplate.content,
    "agent template translation",
    { korean: false },
  );
  assertSourceHashDocument(
    source.common.evaluatorSystem,
    runtime.evaluator.system.content,
    "evaluator system translation",
  );
  assertSourceHashDocument(
    source.common.evaluatorUserTemplate,
    runtime.evaluator.userTemplate.content,
    "evaluator user template translation",
  );
  for (const placeholder of ["{agent_instruction}", "{domain_policy}"]) {
    assert.equal(
      source.common.agentTemplate.content.split(placeholder).length,
      runtime.agent.systemTemplate.content.split(placeholder).length,
      `agent template ${placeholder}`,
    );
  }
  for (const placeholder of ["{trajectory_str}", "{nl_assertions}"]) {
    assert.equal(
      source.common.evaluatorUserTemplate.content.split(placeholder).length,
      runtime.evaluator.userTemplate.content.split(placeholder).length,
      `evaluator template ${placeholder}`,
    );
  }

  const allAssertions = new Map();
  const contextPaths = new Set();
  const expectedInvocationCounts = {
    "tau2:airline": 200,
    "tau2:retail": 32,
    "tau2:telecom": 0,
  };
  for (const domain of catalog.domains) {
    const taskSet = await readJson(publicAssetUrl(domain.runs[0].tasksPath));
    const domainAssertions = new Map();
    for (const taskEntry of Object.values(taskSet.tasks)) {
      for (const assertion of taskEntry.task.evaluation_criteria?.nl_assertions ?? []) {
        const hash = sha256(assertion);
        allAssertions.set(hash, assertion);
        domainAssertions.set(hash, assertion);
      }
    }

    const domainSource = source.domains[domain.id];
    assertExactKeys(domainSource, ["policy", "userPrompt"], `${domain.id} context source`);
    assertSourceHashDocument(
      domainSource.policy,
      domain.policy,
      `${domain.id} policy translation`,
    );
    const englishUserPrompt = domain.userPrompts[0];
    assertExactKeys(
      domainSource.userPrompt,
      ["id", "sourceHash", "label", "description", "content"],
      `${domain.id} user prompt source`,
    );
    assert.equal(domainSource.userPrompt.id, englishUserPrompt.id);
    assert.equal(domainSource.userPrompt.sourceHash, sha256(englishUserPrompt.content));
    assertKorean(domainSource.userPrompt.label, `${domain.id} user prompt label`);
    assertKorean(domainSource.userPrompt.description, `${domain.id} user prompt description`);
    assertContextTranslation(
      englishUserPrompt.content,
      domainSource.userPrompt.content,
      `${domain.id} user prompt translation`,
    );
    assert.equal(
      domainSource.userPrompt.content.split("{{ user_scenario }}").length - 1,
      1,
    );

    assert.ok(!contextPaths.has(domain.contextTranslationPath));
    contextPaths.add(domain.contextTranslationPath);
    const { raw, value: context } = await readJsonWithRaw(
      publicAssetUrl(domain.contextTranslationPath),
    );
    assertContentAddressedAsset(
      domain.contextTranslationPath,
      raw,
      `${domain.id} context asset`,
    );
    assertExactKeys(
      context,
      [
        "schemaVersion",
        "datasetId",
        "locale",
        "model",
        "domainId",
        "source",
        "policy",
        "policySnapshots",
        "agent",
        "user",
        "evaluator",
      ],
      `${domain.id} context asset`,
    );
    assertExactKeys(
      context.source,
      ["repository", "release", "runtimeCommit"],
      `${domain.id} context provenance`,
    );
    assertExactKeys(
      context.policySnapshots,
      [domain.runs[0].policySnapshotId],
      `${domain.id} translated policy snapshots`,
    );
    assertExactKeys(
      context.agent,
      ["model", "instruction", "systemTemplate", "resolvedSystemPrompt"],
      `${domain.id} translated agent context`,
    );
    assertExactKeys(
      context.user,
      ["model", "prompt"],
      `${domain.id} translated user context`,
    );
    assertExactKeys(
      context.evaluator,
      [
        "model",
        "temperature",
        "invocationCount",
        "system",
        "userTemplate",
        "assertions",
      ],
      `${domain.id} translated evaluator context`,
    );
    assert.equal(context.schemaVersion, 1);
    assert.equal(context.datasetId, catalog.datasetId);
    assert.equal(context.locale, "ko");
    assert.equal(context.model, "GPT-5");
    assert.equal(context.domainId, domain.id);
    assert.deepEqual(context.source, {
      repository: "https://github.com/sierra-research/tau2-bench",
      release: "v0.2.0",
      runtimeCommit: "964ef7aed331ecf0c9bc592abdc2b4aecd941586",
    });
    assert.deepEqual(context.policy, domainSource.policy);
    assert.deepEqual(context.policySnapshots, {
      [domain.runs[0].policySnapshotId]: domainSource.policy,
    });
    assert.equal(context.agent.model, "GPT-5");
    assert.deepEqual(context.agent.instruction, source.common.agentInstruction);
    assert.deepEqual(context.agent.systemTemplate, source.common.agentTemplate);

    const resolvedEnglish = runtime.agent.systemTemplate.content
      .replace("{agent_instruction}", runtime.agent.instruction.content)
      .replace("{domain_policy}", domain.policy);
    const resolvedKorean = source.common.agentTemplate.content
      .replace("{agent_instruction}", source.common.agentInstruction.content)
      .replace("{domain_policy}", domainSource.policy.content);
    assert.deepEqual(context.agent.resolvedSystemPrompt, {
      sourceHash: sha256(resolvedEnglish),
      content: resolvedKorean,
    });
    assert.deepEqual(context.user, {
      model: "gpt-4.1-2025-04-14",
      prompt: domainSource.userPrompt,
    });
    assert.equal(context.evaluator.model, "gpt-4o-mini");
    assert.equal(context.evaluator.temperature, 0);
    assert.equal(context.evaluator.invocationCount, expectedInvocationCounts[domain.id]);
    assert.deepEqual(context.evaluator.system, source.common.evaluatorSystem);
    assert.deepEqual(
      context.evaluator.userTemplate,
      source.common.evaluatorUserTemplate,
    );
    assertExactKeys(
      context.evaluator.assertions,
      domainAssertions.keys(),
      `${domain.id} evaluator assertion hashes`,
    );
    for (const hash of domainAssertions.keys()) {
      assert.equal(
        context.evaluator.assertions[hash],
        source.common.evaluationAssertions[hash],
      );
    }
  }

  assert.equal(contextPaths.size, 3);
  assert.equal(allAssertions.size, 133);
  assertExactKeys(
    source.common.evaluationAssertions,
    allAssertions.keys(),
    "global evaluator assertion translations",
  );
  for (const [hash, assertion] of allAssertions) {
    assert.equal(hash, sha256(assertion));
    assertContextTranslation(
      assertion,
      source.common.evaluationAssertions[hash],
      `evaluation assertion ${hash}`,
    );
  }
});

test("run indexes, chunks, transcript memories, and Korean overlays resolve exhaustively", async () => {
  const [catalog, toolTranslationSource, contextTranslationSource] = await Promise.all([
    readJson(catalogUrl),
    readJson(toolTranslationsUrl),
    readJson(contextTranslationsUrl),
  ]);
  assertExactKeys(
    toolTranslationSource,
    ["schemaVersion", "datasetId", "locale", "model", "classifierVersion", "entries"],
    "tool translation source",
  );
  assert.equal(toolTranslationSource.schemaVersion, 1);
  assert.equal(toolTranslationSource.datasetId, catalog.datasetId);
  assert.equal(toolTranslationSource.locale, "ko");
  assert.equal(toolTranslationSource.model, "GPT-5");
  assert.equal(toolTranslationSource.classifierVersion, toolClassifierVersion);
  assert.equal(Object.keys(toolTranslationSource.entries).length, 1_057);
  const transcriptFileNames = (await readdir(transcriptTranslationsDirectoryUrl))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.equal(transcriptFileNames.length, 3);

  const transcriptMemories = new Map();
  const memorySourceHashes = new Set();
  let runLocalTranslationEntries = 0;
  for (const fileName of transcriptFileNames) {
    const memory = await readJson(new URL(fileName, transcriptTranslationsDirectoryUrl));
    assertExactKeys(
      memory,
      ["schemaVersion", "datasetId", "locale", "model", "domainId", "runId", "entries"],
      `${fileName} transcript memory`,
    );
    assert.equal(memory.schemaVersion, 1);
    assert.equal(memory.datasetId, catalog.datasetId);
    assert.equal(memory.locale, "ko");
    assert.equal(memory.model, "GPT-5");
    assert.equal(fileName, `${memory.runId}.json`);
    assert.ok(!transcriptMemories.has(memory.runId));
    transcriptMemories.set(memory.runId, memory);
    for (const [entryId, entry] of Object.entries(memory.entries)) {
      assert.match(entryId, /^msg_[0-9a-f]{24}$/);
      assertExactKeys(entry, ["role", "sourceHash", "content"], `${fileName} ${entryId}`);
      assert.ok(entry.role === "user" || entry.role === "assistant");
      assert.match(entry.sourceHash, /^[0-9a-f]{64}$/);
      assertKorean(entry.content, `${fileName} ${entryId} translation`);
      memorySourceHashes.add(entry.sourceHash);
      runLocalTranslationEntries += 1;
    }
  }
  assert.equal(runLocalTranslationEntries, 11_520);
  assert.equal(memorySourceHashes.size, 11_499);

  const taskSets = new Map();
  const trajectoryIds = new Set();
  const chunkPaths = new Set();
  const overlayPaths = new Set();
  const indexPaths = new Set();
  const taskPaths = new Set();
  const contextPaths = new Set();
  const expectedGlobalSourceHashes = new Set();
  let indexedTrajectories = 0;
  let resolvedTrajectories = 0;
  let normalizedMessages = 0;
  let nonemptyContents = 0;
  let nullOrEmptyContents = 0;
  let controlOnlyContents = 0;
  let translatedOccurrences = 0;
  let evaluatorPrompts = 0;
  let toolCallsCount = 0;
  let userToolCallsCount = 0;
  let translatedToolLeafOccurrences = 0;
  let userToolExample;
  const expectedToolSources = new Map();
  const toolSurfaces = {
    all: createSurfaceCounter(),
    arguments: createSurfaceCounter(),
    results: createSurfaceCounter(),
    translated: createSurfaceCounter(),
    translatedArguments: createSurfaceCounter(),
    translatedResults: createSurfaceCounter(),
    codeOnly: createSurfaceCounter(),
  };

  async function loadTaskSet(tasksPath) {
    if (!taskSets.has(tasksPath)) {
      taskSets.set(tasksPath, await readJson(publicAssetUrl(tasksPath)));
    }
    return taskSets.get(tasksPath);
  }

  for (const domain of catalog.domains) {
    assert.equal(domain.runs.length, 1);
    const run = domain.runs[0];
    const memory = transcriptMemories.get(run.id);
    assert.ok(memory, `missing transcript memory for ${run.id}`);
    assert.equal(memory.domainId, domain.id);
    indexPaths.add(run.indexPath);
    taskPaths.add(run.tasksPath);
    contextPaths.add(domain.contextTranslationPath);

    const [index, taskSet] = await Promise.all([
      readJson(publicAssetUrl(run.indexPath)),
      loadTaskSet(run.tasksPath),
    ]);
    assertExactKeys(
      index,
      ["schemaVersion", "datasetId", "runId", "trajectories", "transcriptOverlays"],
      `${run.id} index asset`,
    );
    assert.equal(index.schemaVersion, catalog.schemaVersion);
    assert.equal(index.datasetId, catalog.datasetId);
    assert.equal(index.runId, run.id);
    assert.equal(index.trajectories.length, run.trajectoryCount);
    assert.equal(taskSet.schemaVersion, catalog.schemaVersion);
    assert.equal(taskSet.datasetId, catalog.datasetId);
    assert.equal(Object.keys(taskSet.tasks).length, run.taskCount);

    const passCount = index.trajectories.filter((item) => item.reward === 1).length;
    assert.equal(passCount, run.passCount);
    assert.equal(index.trajectories.length - passCount, run.failCount);

    const summariesByChunk = new Map();
    const summariesByTask = new Map();
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
      assert.deepEqual(summary.toolNames, [...new Set(summary.toolNames)].sort());
      trajectoryIds.add(summary.id);
      chunkPaths.add(summary.detailPath);
      indexedTrajectories += 1;

      const chunkSummaries = summariesByChunk.get(summary.detailPath) ?? [];
      chunkSummaries.push(summary);
      summariesByChunk.set(summary.detailPath, chunkSummaries);
      const taskSummaries = summariesByTask.get(summary.taskId) ?? [];
      taskSummaries.push(summary);
      summariesByTask.set(summary.taskId, taskSummaries);
    }

    assert.equal(summariesByTask.size, run.taskCount);
    for (const summaries of summariesByTask.values()) {
      assert.deepEqual(
        summaries.map((summary) => summary.trial).sort((a, b) => a - b),
        run.trials,
      );
      assert.equal(new Set(summaries.map((summary) => summary.title)).size, 1);
    }
    assert.equal(summariesByChunk.size, Math.ceil(run.trajectoryCount / 20));
    assertExactKeys(
      index.transcriptOverlays,
      ["ko"],
      `${run.id} transcript overlay locales`,
    );
    assertExactKeys(
      index.transcriptOverlays.ko,
      summariesByChunk.keys(),
      `${run.id} transcript overlay source chunks`,
    );

    const expectedRunEntries = new Map();
    for (const [chunkPath, summaries] of summariesByChunk) {
      assert.ok(summaries.length > 0 && summaries.length <= 20);
      const [{ raw: chunkRaw, value: payload }, overlayRef] = await Promise.all([
        readJsonWithRaw(publicAssetUrl(chunkPath)),
        Promise.resolve(index.transcriptOverlays.ko[chunkPath]),
      ]);
      assertExactKeys(
        overlayRef,
        ["path", "sha256", "bytes", "sourceSha256"],
        `${chunkPath} Korean overlay ref`,
      );
      assert.equal(overlayRef.sourceSha256, sha256(chunkRaw));
      assert.match(
        overlayRef.path,
        new RegExp(`/translations/ko/transcripts/${run.id}/chunk_[0-9]+_[0-9a-f]{18}\\.json$`),
      );
      overlayPaths.add(overlayRef.path);
      const { raw: overlayRaw, value: overlay } = await readJsonWithRaw(
        publicAssetUrl(overlayRef.path),
      );
      assert.equal(overlayRef.sha256, sha256(overlayRaw));
      assert.equal(overlayRef.bytes, Buffer.byteLength(overlayRaw));
      assertContentAddressedAsset(overlayRef.path, overlayRaw, `${chunkPath} Korean overlay`);

      assertExactKeys(
        payload,
        ["schemaVersion", "datasetId", "trajectories"],
        `${chunkPath} detail chunk`,
      );
      assertExactKeys(
        overlay,
        [
          "schemaVersion",
          "datasetId",
          "locale",
          "model",
          "runId",
          "sourceDetailPath",
          "trajectories",
        ],
        `${chunkPath} Korean overlay`,
      );
      assert.equal(payload.schemaVersion, catalog.schemaVersion);
      assert.equal(payload.datasetId, catalog.datasetId);
      assert.equal(overlay.schemaVersion, 1);
      assert.equal(overlay.datasetId, catalog.datasetId);
      assert.equal(overlay.locale, "ko");
      assert.equal(overlay.model, "GPT-5");
      assert.equal(overlay.runId, run.id);
      assert.equal(overlay.sourceDetailPath, chunkPath);
      assert.deepEqual(
        Object.keys(payload.trajectories).sort(),
        summaries.map((summary) => summary.id).sort(),
      );
      assert.deepEqual(
        Object.keys(overlay.trajectories).sort(),
        summaries.map((summary) => summary.id).sort(),
      );

      for (const summary of summaries) {
        const trajectory = payload.trajectories[summary.id];
        const translatedTrajectory = overlay.trajectories[summary.id];
        assert.ok(trajectory);
        assert.ok(translatedTrajectory);
        const toolCalls = trajectory.messages.flatMap((message) => message.toolCalls);
        const expectedToolLeaves = {};
        trajectory.messages.forEach((message, messageIndex) => {
          message.toolCalls.forEach((call, callIndex) => {
            const callPointer = `/messages/${messageIndex}/toolCalls/${callIndex}`;
            for (const [surfaceName, value] of [
              ["arguments", call.arguments],
              ["results", call.result],
            ]) {
              const canonicalName = surfaceName === "arguments" ? "arguments" : "result";
              visitStringLeaves(
                value,
                `${callPointer}/${canonicalName}`,
                (content, pointer) => {
                  recordSurface(toolSurfaces.all, content);
                  recordSurface(toolSurfaces[surfaceName], content);
                  if (!isToolTranslationEligible(content)) {
                    recordSurface(toolSurfaces.codeOnly, content);
                    return;
                  }
                  recordSurface(toolSurfaces.translated, content);
                  recordSurface(
                    toolSurfaces[surfaceName === "arguments"
                      ? "translatedArguments"
                      : "translatedResults"],
                    content,
                  );
                  const identity = toolTranslationIdentity(content);
                  const expected = { sourceHash: identity.sourceHash, content };
                  const previous = expectedToolSources.get(identity.id);
                  if (previous) {
                    assert.deepEqual(previous, expected, `${identity.id} source collision`);
                  } else {
                    expectedToolSources.set(identity.id, expected);
                  }
                  const translation = toolTranslationSource.entries[identity.id];
                  assert.ok(translation, `${summary.id} missing ${identity.id}`);
                  assert.equal(
                    resolveJsonPointer(trajectory, pointer, `${summary.id} ${pointer}`),
                    content,
                    `${summary.id} ${pointer} canonical leaf`,
                  );
                  expectedToolLeaves[pointer] = translation.content;
                  translatedToolLeafOccurrences += 1;
                },
              );
            }
          });
        });
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

        const expectedMessageIndexes = [];
        trajectory.messages.forEach((message, messageIndex) => {
          normalizedMessages += 1;
          toolCallsCount += message.toolCalls.length;
          userToolCallsCount += message.toolCalls.filter(
            (call) => call.requestor === "user",
          ).length;
          const content = message.content;
          if (content === null || content === "") {
            nullOrEmptyContents += 1;
            return;
          }
          nonemptyContents += 1;
          if (controlOnlyPattern.test(content)) {
            controlOnlyContents += 1;
            return;
          }
          translatedOccurrences += 1;
          expectedMessageIndexes.push(String(messageIndex));
          const identity = messageTranslationIdentity(message.role, content);
          expectedGlobalSourceHashes.add(identity.sourceHash);
          const prior = expectedRunEntries.get(identity.id);
          if (prior) {
            assert.deepEqual(prior, {
              role: message.role,
              sourceHash: identity.sourceHash,
              source: content,
            });
          } else {
            expectedRunEntries.set(identity.id, {
              role: message.role,
              sourceHash: identity.sourceHash,
              source: content,
            });
          }
          const memoryEntry = memory.entries[identity.id];
          assert.ok(memoryEntry, `${run.id} missing ${identity.id}`);
          assert.equal(memoryEntry.role, message.role);
          assert.equal(memoryEntry.sourceHash, identity.sourceHash);
          assertContextTranslation(
            content,
            memoryEntry.content,
            `${run.id} ${identity.id} translation`,
          );
          assertTranscriptNaturalness(
            content,
            memoryEntry.content,
            message.role,
            domain.id,
            `${run.id} ${identity.id} translation`,
          );
          assert.equal(
            translatedTrajectory.messages[String(messageIndex)],
            memoryEntry.content,
          );
        });
        assertExactKeys(
          translatedTrajectory.messages,
          expectedMessageIndexes,
          `${summary.id} translated message indexes`,
        );

        const translatedTrajectoryKeys = ["messages"];
        if (Object.keys(expectedToolLeaves).length) {
          translatedTrajectoryKeys.push("toolLeaves");
          assertExactKeys(
            translatedTrajectory.toolLeaves,
            Object.keys(expectedToolLeaves),
            `${summary.id} translated tool pointers`,
          );
          for (const [pointer, content] of Object.entries(expectedToolLeaves)) {
            assert.equal(
              translatedTrajectory.toolLeaves[pointer],
              content,
              `${summary.id} ${pointer} overlay content`,
            );
          }
        } else {
          assert.equal(translatedTrajectory.toolLeaves, undefined);
        }

        if (trajectory.evaluationPrompt) {
          evaluatorPrompts += 1;
          assert.equal(trajectory.evaluationPrompt.model, "gpt-4o-mini");
          translatedTrajectoryKeys.push("evaluatorUserPrompt");
          const assertions = taskSet.tasks[trajectory.taskId].task
            .evaluation_criteria?.nl_assertions ?? [];
          assert.ok(assertions.length > 0, `${summary.id} evaluator assertions`);
          const placeholders = ["{trajectory_str}", "{nl_assertions}"];
          const englishValues = resolvedTemplateValues(
            catalog.runtimePrompts.evaluator.userTemplate.content,
            trajectory.evaluationPrompt.userPrompt,
            placeholders,
            `${summary.id} English evaluator prompt`,
          );
          assert.equal(
            englishValues["{nl_assertions}"],
            pythonListRepr(assertions),
            `${summary.id} English evaluator assertions`,
          );
          const sourceRoleMessages = parsedRoleTranscript(
            englishValues["{trajectory_str}"],
            `${summary.id} English evaluator trajectory`,
          );
          assert.equal(
            sourceRoleMessages.length,
            trajectory.messages.length + toolCalls.length,
            `${summary.id} evaluator message coverage`,
          );
          const koreanTrajectory = localizedEvaluatorTrajectory(
            englishValues["{trajectory_str}"],
            memory,
            toolTranslationSource.entries,
            expectedToolSources,
            `${summary.id} Korean evaluator trajectory`,
          );
          const translatedAssertions = assertions.map((assertion) => {
            const translated = contextTranslationSource.common
              .evaluationAssertions[sha256(assertion)];
            assertKorean(translated, `${summary.id} evaluator assertion`);
            return translated;
          });
          const expectedEvaluatorPrompt = resolveTemplate(
            contextTranslationSource.common.evaluatorUserTemplate.content,
            {
              "{trajectory_str}": koreanTrajectory,
              "{nl_assertions}": pythonListRepr(translatedAssertions),
            },
            `${summary.id} Korean evaluator prompt`,
          );
          assert.equal(
            translatedTrajectory.evaluatorUserPrompt,
            expectedEvaluatorPrompt,
            `${summary.id} Korean evaluator prompt reconstruction`,
          );
          assertKorean(
            translatedTrajectory.evaluatorUserPrompt,
            `${summary.id} Korean evaluator prompt`,
          );
          assert.doesNotMatch(
            translatedTrajectory.evaluatorUserPrompt,
            /^(?:assistant|user|tool):/mu,
            `${summary.id} English evaluator role label`,
          );
          assert.doesNotMatch(
            translatedTrajectory.evaluatorUserPrompt,
            /:\s*None(?:\s|$)/mu,
            `${summary.id} English evaluator null marker`,
          );
        } else {
          assert.equal(translatedTrajectory.evaluatorUserPrompt, undefined);
        }
        assertExactKeys(
          translatedTrajectory,
          translatedTrajectoryKeys,
          `${summary.id} translated trajectory`,
        );

        resolvedTrajectories += 1;
        if (!userToolExample && summary.userToolCallCount > 0) {
          userToolExample = { domain, summary, trajectory };
        }
      }
    }

    assertExactKeys(
      memory.entries,
      expectedRunEntries.keys(),
      `${run.id} run-local transcript memory`,
    );
  }

  assert.equal(indexedTrajectories, catalog.totals.trajectories);
  assert.equal(resolvedTrajectories, catalog.totals.trajectories);
  assert.equal(trajectoryIds.size, 1_112);
  assert.equal(chunkPaths.size, 56);
  assert.equal(overlayPaths.size, 56);
  assert.equal(taskSets.size, 3);
  assert.equal(normalizedMessages, 24_619);
  assert.equal(nonemptyContents, 14_018);
  assert.equal(nullOrEmptyContents, 10_601);
  assert.equal(controlOnlyContents, 283);
  assert.equal(translatedOccurrences, 13_735);
  assert.equal(evaluatorPrompts, 232);
  assert.equal(toolCallsCount, 15_157);
  assert.equal(userToolCallsCount, 6_740);
  assert.equal(expectedGlobalSourceHashes.size, 11_499);
  assert.deepEqual(expectedGlobalSourceHashes, memorySourceHashes);
  assert.equal(translatedToolLeafOccurrences, 72_782);

  const actualToolSurfaceTotals = Object.fromEntries(
    Object.entries(toolSurfaces).map(([name, counter]) => [name, surfaceTotals(counter)]),
  );
  assert.deepEqual(actualToolSurfaceTotals, {
    all: { occurrences: 188_101, unique: 3_396 },
    arguments: { occurrences: 15_477, unique: 1_236 },
    results: { occurrences: 172_624, unique: 3_168 },
    translated: { occurrences: 72_782, unique: 1_057 },
    translatedArguments: { occurrences: 2_333, unique: 309 },
    translatedResults: { occurrences: 70_449, unique: 861 },
    codeOnly: { occurrences: 115_319, unique: 2_339 },
  });
  assert.deepEqual(catalog.translationTotals.toolLeaves, {
    classifierVersion: toolClassifierVersion,
    calls: toolCallsCount,
    all: actualToolSurfaceTotals.all,
    translated: actualToolSurfaceTotals.translated,
    translatedArguments: actualToolSurfaceTotals.translatedArguments,
    translatedResults: actualToolSurfaceTotals.translatedResults,
    codeOnly: actualToolSurfaceTotals.codeOnly,
  });
  assert.equal(expectedToolSources.size, 1_057);
  assertExactKeys(
    toolTranslationSource.entries,
    expectedToolSources.keys(),
    "exhaustive tool translation source identities",
  );
  for (const [entryId, expected] of expectedToolSources) {
    assert.match(entryId, /^tool_[0-9a-f]{24}$/u);
    assert.equal(entryId, `tool_${expected.sourceHash.slice(0, 24)}`);
    assert.equal(expected.sourceHash, sha256(expected.content));
    const entry = toolTranslationSource.entries[entryId];
    assertExactKeys(entry, ["sourceHash", "content"], `${entryId} translation`);
    assert.equal(entry.sourceHash, expected.sourceHash, `${entryId} source hash`);
    assertToolTranslation(expected.content, entry.content, `${entryId} translation`);
  }

  assert.ok(userToolExample, "expected a Telecom trajectory with user-operated tools");
  assert.equal(userToolExample.domain.id, "tau2:telecom");
  const userToolCalls = userToolExample.trajectory.messages.flatMap((message) =>
    message.toolCalls.filter((call) => call.requestor === "user"),
  );
  assert.equal(userToolCalls.length, userToolExample.summary.userToolCallCount);
  assert.ok(userToolCalls.length > 0);

  assert.equal(indexPaths.size, 3);
  assert.equal(taskPaths.size, 3);
  assert.equal(contextPaths.size, 3);
  const expectedPublicAssets = new Set([
    ...indexPaths,
    ...taskPaths,
    ...contextPaths,
    ...chunkPaths,
    ...overlayPaths,
  ]);
  assert.equal(expectedPublicAssets.size, 121);

  const publicRootUrl = new URL("../public/", import.meta.url);
  const generatedEntries = await readdir(
    new URL("data/", publicRootUrl),
    { recursive: true, withFileTypes: true },
  );
  const generatedFiles = generatedEntries.filter((entry) => entry.isFile());
  const publicRootPath = fileURLToPath(publicRootUrl);
  const generatedAssetPaths = new Set(
    generatedFiles.map((entry) =>
      `/${path.relative(publicRootPath, path.join(entry.parentPath, entry.name))}`,
    ),
  );
  assert.equal(generatedFiles.length, expectedPublicAssets.size);
  assert.equal(generatedFiles.length, 121);
  assert.ok(generatedFiles.every((entry) => entry.name.endsWith(".json")));
  assert.deepEqual(generatedAssetPaths, expectedPublicAssets);
});

test("ships a social preview", async () => {
  const preview = await readFile(new URL("../public/og.png", import.meta.url));
  assert.ok(preview.length > 0);
});
