#!/usr/bin/env python3
"""Build the pinned Korean translation memory for GPT-5 tool string leaves.

This is an offline, resumable curation helper. It reads the three selected
tau2 GPT-5 submission files directly, reproduces the snapshot generator's
tool-call/result normalization and ``tau2-tool-ascii-prose-v1`` classifier,
then translates each distinct eligible English value exactly once.

The resulting source-of-truth file is consumed and strictly validated by
``scripts/build-snapshot.mjs``. JSON object keys and non-string values are not
translation surfaces; only recursively visited string leaves are considered.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
from types import ModuleType
from typing import Any, Callable, Iterable


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TAU2_ROOT = Path(
    os.environ.get("TAU2_BENCH_DIR", PROJECT_ROOT / "work/tau2-bench")
).resolve()
SUBMISSION_ROOT = (
    TAU2_ROOT
    / "web/leaderboard/public/submissions/gpt-5_sierra_2025-08-09/trajectories"
)
DEFAULT_OUTPUT = PROJECT_ROOT / "app/data/gpt5-tool-translations.ko.json"
TRANSLATION_HELPER = PROJECT_ROOT / "scripts/translate-gpt5-conversations-ko.py"

DATASET_ID = "tau2-gpt5-sierra-2025-08-09-v1"
MODEL = "GPT-5"
LOCALE = "ko"
CLASSIFIER_VERSION = "tau2-tool-ascii-prose-v1"
RUNTIME_COMMIT = "964ef7aed331ecf0c9bc592abdc2b4aecd941586"

SELECTED_RUNS = (
    {
        "domain": "airline",
        "file": "gpt-5_airline_default_gpt-4.1-2025-04-14_4trials.json",
        "sha256": "a105bdd94410994cf5b252b409766d67b7f71a105adbe828ed6718d5f7ff721a",
        "tasks": 50,
        "trajectories": 200,
    },
    {
        "domain": "retail",
        "file": "gpt-5_retail_default_gpt-4.1-2025-04-14_4trials.json",
        "sha256": "e85532b024b128349c547e2ebadec34b399e73c1a750ef911628072fc0a47734",
        "tasks": 114,
        "trajectories": 456,
    },
    {
        "domain": "telecom",
        "file": "gpt-5_telecom_default_gpt-4.1-2025-04-14_4trials.json",
        "sha256": "015610625e69f05ef0e0acdf4c822dcf69ef70010e29ead0fd0e60bb68c84f2f",
        "tasks": 114,
        "trajectories": 456,
    },
)

EXPECTED = {
    "tool_calls": 15_157,
    "tool_results": 15_157,
    "all_occurrences": 188_101,
    "all_unique": 3_396,
    "eligible_occurrences": 72_782,
    "eligible_unique": 1_057,
    "eligible_argument_occurrences": 2_333,
    "eligible_argument_unique": 309,
    "eligible_result_occurrences": 70_449,
    "eligible_result_unique": 861,
    "code_occurrences": 115_319,
    "code_unique": 2_339,
}

CONTROL_ONLY = re.compile(
    r"^\s*###(?:STOP|TRANSFER|OUT-OF-SCOPE)###\s*$", re.IGNORECASE
)
TOOL_URL_ONLY = re.compile(r"^https?://\S+$", re.IGNORECASE)
TOOL_EMAIL_ONLY = re.compile(
    r"^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$", re.IGNORECASE | re.ASCII
)
TOOL_COMPACT_UPPER_CODE = re.compile(r"^#?[A-Z0-9_-]+$")
TOOL_COMPACT_MIXED_ALNUM = re.compile(
    r"^(?=.*[A-Za-z])(?=.*\d)\S+$", re.ASCII
)
TOOL_SNAKE_IDENTIFIER = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)+$")
ASCII_LETTER = re.compile(r"[A-Za-z]")
HANGUL = re.compile(r"[\uac00-\ud7a3]")
PROTECTED = re.compile(
    "|".join(
        [
            r"###(?:STOP|TRANSFER|OUT-OF-SCOPE)###",
            r"`[^`]+`",
            r"https?://[^\s)\]}>]+",
            r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}",
            r"\b\d{3}-\d{3}-\d{4}\b",
            r"#[A-Za-z0-9_-]+",
            r"\b\d{4}-\d{2}-\d{2}\b",
            r"\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b",
            r"[$€£¥]\s?\d(?:\d|[,.](?=\d))*(?:\s?(?:USD|EUR|GBP|KRW))?",
            r"\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{3,}\b",
            r"\b[a-z][a-z0-9_]+\((?=[^()\n]*(?:=|[\"']))[^()\n]*\)",
            r"\b[a-z]+(?:_[a-z0-9]+)+\b",
            r"\b\d+(?:[.,]\d+)*[A-Za-z]{1,6}\b",
            r"\b\d+(?:[.,]\d+)*(?:%|st|nd|rd|th)?\b",
        ]
    ),
    re.ASCII,
)
TOOL_PROTECTED_CODE_TOKENS = (
    "AA",
    "AC",
    "AM",
    "APN",
    "ATL",
    "BOS",
    "CF",
    "CLT",
    "DEN",
    "DOB",
    "DTW",
    "ET",
    "EWR",
    "GB",
    "HD",
    "HEPA",
    "HLR",
    "HSS",
    "HXDUBJ",
    "IAH",
    "ID",
    "IFOYYZ",
    "IL",
    "IR",
    "JFK",
    "LAS",
    "LAX",
    "LED",
    "LGA",
    "MCO",
    "MIA",
    "MMS",
    "MMSC",
    "MSP",
    "MXP",
    "ORD",
    "PDP",
    "PGW",
    "PHL",
    "PHX",
    "PIN",
    "POOR",
    "PUK",
    "SD",
    "SEA",
    "SFO",
    "SIM",
    "SMF",
    "SMS",
    "SSD",
    "TX",
    "URL",
    "USA",
    "USD",
    "VPN",
    "ZIP",
)
_TOOL_PROTECTED_TOKEN_CHOICE = "(?:" + "|".join(TOOL_PROTECTED_CODE_TOKENS) + ")"
TOOL_PROTECTED_CODE = re.compile(
    rf"\b{_TOOL_PROTECTED_TOKEN_CHOICE}(?:-{_TOOL_PROTECTED_TOKEN_CHOICE})*\b",
    re.ASCII,
)
# Tool leaves require a narrower, curated uppercase-code contract in addition
# to the global transcript literals. Do not broaden the shared PROTECTED regex:
# status words such as ON/OFF/PAID/ACTIVE/LOCKED must remain translatable.
TOOL_PROTECTED = re.compile(
    rf"{PROTECTED.pattern}|{TOOL_PROTECTED_CODE.pattern}",
    re.ASCII,
)

CURATED_TRANSLATIONS = {
    # Google preserves this standards name verbatim, but every eligible display
    # string must contain Korean. This is the conventional Korean rendering.
    "Wi-Fi": "와이파이",
    "sms": "문자 메시지",
    # High-frequency contextless enums need domain-aware Korean rather than a
    # dictionary's conversational or literal sense.
    "yes": "예",
    "no": "아니요",
    "silver": "실버",
    "gold": "골드",
    "economy": "이코노미",
    "business": "비즈니스",
    "small": "소형",
    "medium": "중형",
    "large": "대형",
    "low": "낮음",
    "high": "높음",
    "plain": "무지",
    "bagged": "먼지봉투형",
    "certificate": "여행 증서",
    "electric": "전기식",
    "full size": "풀 사이즈",
    "pending": "처리 대기",
    "delivered": "배송 완료",
    "Paid": "결제 완료",
    "Issued": "발행됨",
    "Plan Charge": "요금제 이용료",
    "Premium Plan": "프리미엄 요금제",
    # Product facets and service-status text need compact catalog Korean,
    # not literal dictionary phrasing.
    "men": "남성용",
    "women": "여성용",
    "hardshell": "하드쉘",
    "exchange requested": "교환 요청됨",
    "stainless steel": "스테인리스 스틸",
    "clicky": "클릭형",
    "tactile": "택타일",
    "canister": "통형",
    "8 hours": "8시간",
    "10 hours": "10시간",
    "20 hours": "20시간",
    "Transfer successful": "상담원 연결 완료",
    "Charge for line L1002": "회선 L1002 요금",
}


def curated_translation(source: str) -> str | None:
    curated = CURATED_TRANSLATIONS.get(source)
    if curated is not None:
        return curated
    suite = re.fullmatch(r"Suite (\d+)", source)
    if suite:
        return f"스위트 {suite.group(1)}호"
    storage = re.fullmatch(r"(\d+(?:GB|TB)) SSD", source)
    if storage:
        return f"{storage.group(1)} SSD(솔리드 스테이트 드라이브)"
    plan_line = re.fullmatch(r"(Basic|Premium) Plan - Line (\d{3}-\d{3}-\d{4})", source)
    if plan_line:
        plan = "기본" if plan_line.group(1) == "Basic" else "프리미엄"
        return f"{plan} 요금제 - 회선 {plan_line.group(2)}"
    refuel = re.fullmatch(
        r"Successfully added (\d+) GB of data for line ([A-Z]+\d+) for (\$[\d.]+)",
        source,
    )
    if refuel:
        return (
            f"회선 {refuel.group(2)}에 데이터 {refuel.group(1)} GB를 "
            f"{refuel.group(3)}에 성공적으로 추가했습니다."
        )
    return None


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def tool_identity(content: str) -> tuple[str, str]:
    source_hash = sha256_bytes(content.encode("utf-8"))
    return f"tool_{source_hash[:24]}", source_hash


def maybe_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def is_tool_translation_eligible(value: str) -> bool:
    """Exact Python equivalent of the generator's v1 JS classifier."""
    compact = value.strip()
    return bool(compact) and bool(ASCII_LETTER.search(compact)) and not any(
        expression.fullmatch(compact)
        for expression in (
            CONTROL_ONLY,
            TOOL_URL_ONLY,
            TOOL_EMAIL_ONLY,
            TOOL_COMPACT_UPPER_CODE,
            TOOL_COMPACT_MIXED_ALNUM,
            TOOL_SNAKE_IDENTIFIER,
        )
    )


def visit_string_leaves(value: Any, visitor: Callable[[str], None]) -> None:
    if isinstance(value, str):
        visitor(value)
    elif isinstance(value, list):
        for item in value:
            visit_string_leaves(item, visitor)
    elif isinstance(value, dict):
        for item in value.values():
            visit_string_leaves(item, visitor)


def null_coalesce(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def normalized_tool_calls(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int, int]:
    """Pair calls/results with the same FIFO semantics as build-snapshot.mjs."""
    calls: list[dict[str, Any]] = []
    pending: dict[str, deque[dict[str, Any]]] = defaultdict(deque)
    orphan_results = 0
    for message_index, message in enumerate(messages):
        if message.get("role") == "tool":
            result_id = str(
                null_coalesce(message.get("id"), message.get("tool_call_id"), "")
            )
            if pending[result_id]:
                invocation = pending[result_id].popleft()
                invocation["result"] = maybe_json(message.get("content") or "")
                if not pending[result_id]:
                    del pending[result_id]
            else:
                orphan_results += 1
            continue
        if message.get("role") not in {"assistant", "user"}:
            continue
        for call_index, call in enumerate(message.get("tool_calls") or []):
            function = call.get("function") or {}
            call_id = str(
                null_coalesce(call.get("id"), f"{message_index}-{call_index}")
            )
            invocation = {
                "arguments": maybe_json(
                    null_coalesce(
                        call.get("arguments"), function.get("arguments"), {}
                    )
                ),
                "result": None,
            }
            calls.append(invocation)
            pending[call_id].append(invocation)
    unresolved = sum(len(queue) for queue in pending.values())
    return calls, orphan_results, unresolved


def collect_expected() -> tuple[dict[str, dict[str, str]], dict[str, int]]:
    expected: dict[str, dict[str, str]] = {}
    all_values: set[str] = set()
    eligible_values: set[str] = set()
    eligible_argument_values: set[str] = set()
    eligible_result_values: set[str] = set()
    code_values: set[str] = set()
    totals = Counter()

    for spec in SELECTED_RUNS:
        source_path = SUBMISSION_ROOT / spec["file"]
        raw = source_path.read_bytes()
        actual_hash = sha256_bytes(raw)
        if actual_hash != spec["sha256"]:
            raise ValueError(
                f"{spec['file']} source hash differs: {actual_hash}"
            )
        run = json.loads(raw)
        if run.get("info", {}).get("git_commit") != RUNTIME_COMMIT:
            raise ValueError(f"{spec['file']} runtime commit differs")
        if len(run.get("tasks", [])) != spec["tasks"]:
            raise ValueError(f"{spec['file']} task count differs")
        if len(run.get("simulations", [])) != spec["trajectories"]:
            raise ValueError(f"{spec['file']} trajectory count differs")

        for simulation in run["simulations"]:
            calls, orphan_results, unresolved = normalized_tool_calls(
                simulation["messages"]
            )
            totals["tool_calls"] += len(calls)
            totals["tool_results"] += len(calls) - unresolved
            totals["orphan_results"] += orphan_results
            totals["unresolved_calls"] += unresolved
            for call in calls:
                for side, surface in (
                    ("argument", call["arguments"]),
                    ("result", call["result"]),
                ):
                    def record(content: str, *, side: str = side) -> None:
                        totals["all_occurrences"] += 1
                        all_values.add(content)
                        if not is_tool_translation_eligible(content):
                            totals["code_occurrences"] += 1
                            code_values.add(content)
                            return
                        totals["eligible_occurrences"] += 1
                        totals[f"eligible_{side}_occurrences"] += 1
                        eligible_values.add(content)
                        if side == "argument":
                            eligible_argument_values.add(content)
                        else:
                            eligible_result_values.add(content)
                        entry_id, source_hash = tool_identity(content)
                        entry = {"sourceHash": source_hash, "source": content}
                        previous = expected.get(entry_id)
                        if previous is not None and previous != entry:
                            raise ValueError(f"tool translation id collision: {entry_id}")
                        expected[entry_id] = entry

                    visit_string_leaves(surface, record)

    totals.update(
        {
            "all_unique": len(all_values),
            "eligible_unique": len(eligible_values),
            "eligible_argument_unique": len(eligible_argument_values),
            "eligible_result_unique": len(eligible_result_values),
            "code_unique": len(code_values),
        }
    )
    if totals["orphan_results"] or totals["unresolved_calls"]:
        raise ValueError(
            "tool call/result pairing differs: "
            f"{totals['orphan_results']} orphan, {totals['unresolved_calls']} unresolved"
        )
    for name, wanted in EXPECTED.items():
        actual = totals[name]
        if actual != wanted:
            raise ValueError(f"{name} differs: expected {wanted}, got {actual}")
    return expected, dict(totals)


def protected_literals(value: str) -> Counter[str]:
    return Counter(TOOL_PROTECTED.findall(value))


def validate_translation(source: str, translated: Any, label: str) -> str:
    if not isinstance(translated, str) or not translated.strip():
        raise ValueError(f"{label} content must be a nonblank string")
    if not HANGUL.search(translated):
        raise ValueError(f"{label} content must contain Hangul")
    expected_literals = protected_literals(source)
    actual_literals = protected_literals(translated)
    for literal, count in expected_literals.items():
        if actual_literals[literal] < count:
            raise ValueError(
                f"{label} did not preserve protected literal {literal!r} exactly"
            )
    if re.search(r"TAU\s*KEEP|TAU_BATCH", translated, re.IGNORECASE):
        raise ValueError(f"{label} contains an internal translation marker")
    return translated


def exact_keys(value: Any, keys: Iterable[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    actual = set(value)
    wanted = set(keys)
    if actual != wanted:
        raise ValueError(
            f"{label} keys differ: expected {sorted(wanted)}, got {sorted(actual)}"
        )
    return value


def load_checkpoint(
    output: Path,
    expected: dict[str, dict[str, str]],
    *,
    retranslate_invalid: bool,
) -> dict[str, dict[str, str]]:
    if not output.exists():
        return {}
    root = exact_keys(
        read_json(output),
        (
            "schemaVersion",
            "datasetId",
            "locale",
            "model",
            "classifierVersion",
            "entries",
        ),
        "tool translation checkpoint",
    )
    metadata = (
        root["schemaVersion"],
        root["datasetId"],
        root["locale"],
        root["model"],
        root["classifierVersion"],
    )
    if metadata != (1, DATASET_ID, LOCALE, MODEL, CLASSIFIER_VERSION):
        raise ValueError("tool translation checkpoint metadata differs")
    entries = exact_keys(root["entries"], root["entries"].keys(), "entries")
    stale = set(entries) - set(expected)
    if stale:
        raise ValueError(f"checkpoint has {len(stale)} stale entries")
    valid: dict[str, dict[str, str]] = {}
    errors: list[str] = []
    for entry_id, entry in entries.items():
        try:
            checked = exact_keys(entry, ("sourceHash", "content"), entry_id)
            source = expected[entry_id]
            if checked["sourceHash"] != source["sourceHash"]:
                raise ValueError(f"{entry_id} source hash differs")
            validate_translation(source["source"], checked["content"], entry_id)
            curated = curated_translation(source["source"])
            if curated is not None and checked["content"] != curated:
                raise ValueError(f"{entry_id} differs from its curated translation")
            valid[entry_id] = checked
        except (KeyError, TypeError, ValueError) as error:
            if not retranslate_invalid:
                raise
            errors.append(f"{entry_id}: {error}")
    if errors:
        print(f"Removed {len(errors)} invalid checkpoint entries", flush=True)
    return valid


def payload(entries: dict[str, dict[str, str]]) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "datasetId": DATASET_ID,
        "locale": LOCALE,
        "model": MODEL,
        "classifierVersion": CLASSIFIER_VERSION,
        "entries": dict(sorted(entries.items())),
    }


def load_backend() -> ModuleType:
    if not TRANSLATION_HELPER.exists():
        raise ValueError(f"missing translation backend: {TRANSLATION_HELPER}")
    name = "tau_translate_gpt5_conversations_ko"
    spec = importlib.util.spec_from_file_location(name, TRANSLATION_HELPER)
    if spec is None or spec.loader is None:
        raise ValueError(f"could not load translation backend: {TRANSLATION_HELPER}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    # Reuse the mature batching/marker machinery while scoping the augmented
    # uppercase-code protection to this tool-only helper process.
    module.PROTECTED = TOOL_PROTECTED
    return module


def translate_batch(
    backend: ModuleType,
    provider: str,
    batch: list[tuple[str, str, str]],
    gemini_model: str,
) -> dict[str, str]:
    completed: dict[str, str] = {}
    automatic: list[tuple[str, str, str]] = []
    for entry_id, role, source in batch:
        curated = curated_translation(source)
        if curated is not None:
            completed[entry_id] = curated
        else:
            automatic.append((entry_id, role, source))
    if not automatic:
        return completed
    if provider == "google":
        completed.update(backend.translate_google_resilient(automatic))
    elif provider == "gemini":
        completed.update(
            backend.translate_gemini_resilient(automatic, gemini_model)
        )
    else:
        completed.update(
            {
                entry_id: backend.translate_content(source, role)
                for entry_id, role, source in automatic
            }
        )
    return completed


def validate_complete(
    entries: dict[str, dict[str, str]], expected: dict[str, dict[str, str]]
) -> None:
    if set(entries) != set(expected):
        missing = set(expected) - set(entries)
        stale = set(entries) - set(expected)
        raise ValueError(
            f"entry keyset differs: {len(missing)} missing, {len(stale)} stale"
        )
    for entry_id, source in expected.items():
        entry = exact_keys(entries[entry_id], ("sourceHash", "content"), entry_id)
        if entry["sourceHash"] != source["sourceHash"]:
            raise ValueError(f"{entry_id} source hash differs")
        validate_translation(source["source"], entry["content"], entry_id)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--provider", choices=("google", "gemini", "argos"), default="google"
    )
    parser.add_argument("--gemini-model", default="gemini-2.5-flash")
    parser.add_argument("--batch-items", type=int, default=24)
    parser.add_argument("--batch-chars", type=int, default=16_000)
    parser.add_argument("--batch-units", type=int, default=300)
    parser.add_argument("--batch-delay", type=float, default=0)
    parser.add_argument("--retranslate-invalid", action="store_true")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()

    if args.batch_items < 1 or args.batch_chars < 1 or args.batch_units < 1:
        parser.error("batch limits must be positive")
    output = args.output.resolve()
    expected, totals = collect_expected()
    entries = load_checkpoint(
        output, expected, retranslate_invalid=args.retranslate_invalid
    )
    print(
        "Pinned tool surfaces: "
        f"{totals['tool_calls']:,} calls, {totals['all_occurrences']:,} leaves, "
        f"{totals['eligible_occurrences']:,}/{totals['eligible_unique']:,} eligible",
        flush=True,
    )
    print(f"Checkpoint: {len(entries):,}/{len(expected):,}", flush=True)

    if args.validate_only:
        validate_complete(entries, expected)
        print(f"Validated {len(entries):,} tool translations", flush=True)
        return 0

    backend = load_backend()
    pending = [entry_id for entry_id in sorted(expected) if entry_id not in entries]
    while pending:
        batch_ids: list[str] = []
        batch_chars = 0
        batch_units = 0
        for entry_id in pending:
            source = expected[entry_id]["source"]
            force_segmented = args.provider == "google"
            unit_count = (
                len(
                    backend.make_gemini_plan(
                        source, entry_id, force_segmented=force_segmented
                    )[2]
                )
                if args.provider in {"google", "gemini"}
                else 1
            )
            if batch_ids and (
                len(batch_ids) >= args.batch_items
                or batch_chars + len(source) > args.batch_chars
                or batch_units + unit_count > args.batch_units
            ):
                break
            batch_ids.append(entry_id)
            batch_chars += len(source)
            batch_units += unit_count
        batch = [
            (entry_id, "assistant", expected[entry_id]["source"])
            for entry_id in batch_ids
        ]
        try:
            translated = translate_batch(
                backend, args.provider, batch, args.gemini_model
            )
            for entry_id in batch_ids:
                source = expected[entry_id]
                content = validate_translation(
                    source["source"], translated[entry_id], entry_id
                )
                entries[entry_id] = {
                    "sourceHash": source["sourceHash"],
                    "content": content,
                }
        except Exception:
            write_json_atomic(output, payload(entries))
            raise
        pending = pending[len(batch_ids) :]
        write_json_atomic(output, payload(entries))
        print(f"Translated {len(entries):,}/{len(expected):,}", flush=True)
        if pending and args.batch_delay > 0:
            time.sleep(args.batch_delay)

    validate_complete(entries, expected)
    write_json_atomic(output, payload(entries))
    print(f"Complete: {len(entries):,} distinct eligible tool strings", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
