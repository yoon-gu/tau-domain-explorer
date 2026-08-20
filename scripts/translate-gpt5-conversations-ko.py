#!/usr/bin/env python3
"""Build resumable Korean display translations for one pinned GPT-5 run.

This is an offline curation helper, not part of the website build. It reads the
canonical English detail chunks, translates each distinct user/assistant body,
and writes a compact run-level translation memory. The snapshot generator later
validates that memory and repacks it into lazy per-detail-chunk overlays.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = PROJECT_ROOT / "app/data/benchmark-snapshot.json"
DATASET_ID = "tau2-gpt5-sierra-2025-08-09-v1"
CONTROL_ONLY = re.compile(
    r"^\s*###(?:STOP|TRANSFER|OUT-OF-SCOPE)###\s*$",
    re.IGNORECASE,
)
CONTROL_TOKEN = re.compile(
    r"###(?:STOP|TRANSFER|OUT-OF-SCOPE)###",
    re.IGNORECASE,
)
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
            r"[$€£¥]\s?\d[\d,.]*(?:\s?(?:USD|EUR|GBP|KRW))?",
            r"\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{3,}\b",
            r"\b[a-z]+(?:_[a-z0-9]+)+\b",
            r"\b\d+(?:[.,]\d+)*[A-Za-z]{1,6}\b",
            r"\b\d+(?:[.,]\d+)*(?:%|st|nd|rd|th)?\b",
        ]
    ),
    flags=re.ASCII,
)
HANGUL = re.compile(r"[\uac00-\ud7a3]")
LATIN_WORD = re.compile(r"[A-Za-z]{2,}")
ADDED_DIGITS = re.compile(r"\d+")


def korean_integer(value: str) -> str:
    """Spell model-added Arabic digits without touching protected source numbers."""
    digit_names = "영일이삼사오육칠팔구"
    if not value or not value.isdigit():
        return value
    if len(value) > 16 or (len(value) > 1 and value.startswith("0")):
        return "".join(digit_names[int(character)] for character in value)
    number = int(value)
    if number == 0:
        return "영"
    large_units = ("", "만", "억", "조")
    groups: list[str] = []
    group_index = 0
    while number:
        group = number % 10_000
        if group:
            parts: list[str] = []
            for position, unit in enumerate(("", "십", "백", "천")):
                digit = (group // (10 ** position)) % 10
                if not digit:
                    continue
                prefix = "" if digit == 1 and position > 0 else digit_names[digit]
                parts.append(f"{prefix}{unit}")
            groups.append(f"{''.join(reversed(parts))}{large_units[group_index]}")
        number //= 10_000
        group_index += 1
    return "".join(reversed(groups))


def verbalize_model_added_digits(value: str) -> str:
    """Prevent translated prose from inventing protected numeric literals.

    Every source digit is removed into a protected span before Google sees a
    prose unit. Any Arabic digit returned inside that unit therefore came from
    spelling an English number word (or from a translation hallucination), not
    from the canonical transcript. Keep source numbers byte-exact when spans
    are reinserted, and render only these model-added digits as Korean words.
    """
    return ADDED_DIGITS.sub(lambda match: korean_integer(match.group(0)), value)


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


def message_id(role: str, content: str) -> tuple[str, str]:
    source_hash = hashlib.sha256(
        json.dumps([role, content], ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    return f"msg_{source_hash[:24]}", source_hash


def protect(value: str) -> tuple[str, list[str]]:
    literals: list[str] = []

    def replace(match: re.Match[str]) -> str:
        index = len(literals)
        literals.append(match.group(0))
        return f"<TAUKEEP{index}>"

    return PROTECTED.sub(replace, value), literals


def restore(value: str, literals: list[str]) -> str:
    restored = value
    for index, literal in enumerate(literals):
        marker = re.compile(
            rf"<\s*TAU\s*KEEP\s*{index}\s*>",
            re.IGNORECASE,
        )
        restored, count = marker.subn(lambda _match: literal, restored, count=1)
        if count != 1:
            raise ValueError(f"translator dropped protected marker {index}")
    if re.search(r"TAU\s*KEEP", restored, re.IGNORECASE):
        raise ValueError("translator emitted an orphan protected marker")
    return restored


def polish(value: str, role: str) -> str:
    counterpart = "고객님" if role == "assistant" else "상담원님"
    replacements = [
        (r"\b당신의\b", f"{counterpart}의"),
        (r"\b당신은\b", f"{counterpart}은"),
        (r"\b당신을\b", f"{counterpart}을"),
        (r"\b당신에게\b", f"{counterpart}에게"),
        (r"\b당신\b", counterpart),
        (r"\b나의\b", "제"),
        (r"\b나는\b", "저는"),
    ]
    output = value.strip()
    for pattern, replacement in replacements:
        output = re.sub(pattern, replacement, output)
    return output


def translate_plain(value: str, role: str) -> str:
    from argostranslate import translate

    protected, literals = protect(value)
    translated = translate.translate(protected, "en", "ko")
    try:
        restored = restore(translated, literals)
    except ValueError:
        # Rare tokenizer failures are handled conservatively: translate only the
        # prose spans and reinsert every protected literal in source order.
        pieces: list[str] = []
        cursor = 0
        for match in PROTECTED.finditer(value):
            prose = value[cursor : match.start()]
            pieces.append(translate.translate(prose, "en", "ko") if prose.strip() else prose)
            pieces.append(match.group(0))
            cursor = match.end()
        tail = value[cursor:]
        pieces.append(translate.translate(tail, "en", "ko") if tail.strip() else tail)
        restored = "".join(pieces)
    return polish(restored, role)


def validate_json_shape(source: Any, translated: Any, path: str = "$") -> None:
    """Ensure a display translation cannot mutate structured transcript data."""
    if isinstance(source, dict):
        if not isinstance(translated, dict) or list(source) != list(translated):
            raise ValueError(f"JSON object keys changed at {path}")
        for key in source:
            validate_json_shape(source[key], translated[key], f"{path}.{key}")
        return
    if isinstance(source, list):
        if not isinstance(translated, list) or len(source) != len(translated):
            raise ValueError(f"JSON array shape changed at {path}")
        for index, (source_item, translated_item) in enumerate(zip(source, translated)):
            validate_json_shape(source_item, translated_item, f"{path}[{index}]")
        return
    if isinstance(source, str):
        if not isinstance(translated, str):
            raise ValueError(f"JSON string type changed at {path}")
        return
    if translated != source:
        raise ValueError(f"JSON literal changed at {path}")


UNIT_TOKEN = re.compile(r"\ue000([0-9]+)\ue001")


def make_gemini_plan(
    source: str, entry_id: str, *, force_segmented: bool = False
) -> tuple[Any, bool, list[dict[str, str]], list[str] | None]:
    """Extract prose units so protected literals/JSON structure never reach the model."""
    units: list[dict[str, str]] = []

    protected, whole_literals = protect(source)
    if not force_segmented and len(whole_literals) <= 20:
        try:
            json.loads(source)
        except json.JSONDecodeError:
            is_json = False
        else:
            is_json = True
        units.append({"id": f"{entry_id}:0", "content": protected})
        return "\ue0000\ue001", is_json, units, whole_literals

    def plan_string(value: str) -> str:
        if "\ue000" in value or "\ue001" in value:
            raise ValueError("source contains a reserved translation-plan marker")
        pieces: list[str] = []
        cursor = 0
        spans = list(PROTECTED.finditer(value))
        for index in range(len(spans) + 1):
            end = spans[index].start() if index < len(spans) else len(value)
            prose = value[cursor:end]
            if LATIN_WORD.search(prose):
                unit_index = len(units)
                prefix = re.match(r"^\s*", prose).group(0)
                suffix = re.search(r"\s*$", prose).group(0)
                core_end = len(prose) - len(suffix) if suffix else len(prose)
                core = prose[len(prefix) : core_end]
                if core:
                    unit_id = f"{entry_id}:{unit_index}"
                    units.append({"id": unit_id, "content": core})
                    pieces.extend([prefix, f"\ue000{unit_index}\ue001", suffix])
                else:
                    pieces.append(prose)
            else:
                pieces.append(prose)
            if index < len(spans):
                pieces.append(spans[index].group(0))
                cursor = spans[index].end()
        return "".join(pieces)

    try:
        parsed = json.loads(source)
    except json.JSONDecodeError:
        return plan_string(source), False, units, None

    def visit(value: Any) -> Any:
        if isinstance(value, str):
            return plan_string(value) if should_translate_json_string(value) else value
        if isinstance(value, list):
            return [visit(item) for item in value]
        if isinstance(value, dict):
            return {key: visit(item) for key, item in value.items()}
        return value

    return visit(parsed), True, units, None


def finish_gemini_plan(
    source: str,
    plan: Any,
    is_json: bool,
    unit_translations: dict[str, str],
    entry_id: str,
    role: str,
    literals: list[str] | None,
) -> str:
    def finish_string(value: str) -> str:
        def replace(match: re.Match[str]) -> str:
            key = f"{entry_id}:{match.group(1)}"
            if key not in unit_translations:
                raise ValueError(f"missing translated prose unit {key}")
            return polish(unit_translations[key], role)

        return UNIT_TOKEN.sub(replace, value)

    def visit(value: Any) -> Any:
        if isinstance(value, str):
            return finish_string(value)
        if isinstance(value, list):
            return [visit(item) for item in value]
        if isinstance(value, dict):
            return {key: visit(item) for key, item in value.items()}
        return value

    finished = visit(plan)
    restored = (
        json.dumps(finished, ensure_ascii=False, indent=2)
        if is_json and literals is None
        else finished
    )
    if literals is not None:
        restored = restore(restored, literals)
    try:
        source_json = json.loads(source)
    except json.JSONDecodeError:
        requires_hangul = bool(LATIN_WORD.search(PROTECTED.sub("", source)))
    else:
        translated_json = json.loads(restored)
        validate_json_shape(source_json, translated_json)
        requires_hangul = json_requires_hangul(source_json)
    if requires_hangul and not HANGUL.search(restored):
        raise ValueError("translated prose does not contain Hangul")
    for token in CONTROL_TOKEN.findall(source):
        if restored.count(token) != source.count(token):
            raise ValueError(f"control token was not preserved: {token}")
    return restored


def gemini_request(items: list[dict[str, str]], model: str, attempts: int = 3) -> list[str]:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise ValueError("GEMINI_API_KEY is required for --provider gemini")
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={key}"
    )
    instruction = (
        "Translate every content value from English to natural, polite Korean for a customer-service "
        "conversation. Preserve every <TAUKEEPn> marker exactly, including its spelling and count. Preserve "
        "Markdown structure, line breaks, JSON syntax, JSON object keys, arrays, and non-string JSON literals. "
        "Translate all supplied human-readable prose without adding explanations or omitting content. Return a JSON array with exactly one string "
        "for every input string, in exactly the same order.\n\nINPUT:\n"
        + json.dumps([item["content"] for item in items], ensure_ascii=False, separators=(",", ":"))
    )
    schema = {
        "type": "ARRAY",
        "items": {"type": "STRING"},
        "minItems": len(items),
        "maxItems": len(items),
    }
    generation_config: dict[str, Any] = {
        "temperature": 0.1,
        "responseMimeType": "application/json",
        "responseSchema": schema,
    }
    if not model.startswith(("gemini-3.6", "gemini-3.7")):
        generation_config["thinkingConfig"] = {"thinkingBudget": 0}
    body = json.dumps(
        {
            "contents": [{"role": "user", "parts": [{"text": instruction}]}],
            "generationConfig": generation_config,
        }
    ).encode()
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.load(response)
            text = payload["candidates"][0]["content"]["parts"][0]["text"]
            result = json.loads(text)
            if not isinstance(result, list) or any(not isinstance(item, str) for item in result):
                raise ValueError("Gemini response is not an array")
            return result
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError) as error:
            if attempt + 1 == attempts:
                raise
            if isinstance(error, urllib.error.HTTPError) and error.code not in {429, 500, 502, 503, 504}:
                raise
            retry_after = None
            if isinstance(error, urllib.error.HTTPError):
                retry_after = error.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                delay = int(retry_after)
            elif isinstance(error, urllib.error.HTTPError) and error.code == 429:
                delay = min(90, 20 * (attempt + 1))
            else:
                delay = min(30, 2 ** attempt)
            print(f"Gemini request retry {attempt + 1}/{attempts} in {delay}s: {error}", flush=True)
            time.sleep(delay)
    raise AssertionError("unreachable")


def translate_gemini_batch(
    batch: list[tuple[str, str, str]], model: str, *, force_segmented: bool = False
) -> dict[str, str]:
    prepared: list[dict[str, str]] = []
    plans: dict[str, tuple[Any, bool, list[str] | None]] = {}
    source_by_id: dict[str, tuple[str, str]] = {}
    for entry_id, role, source in batch:
        plan, is_json, units, literals = make_gemini_plan(
            source, entry_id, force_segmented=force_segmented
        )
        prepared.extend(units)
        plans[entry_id] = (plan, is_json, literals)
        source_by_id[entry_id] = (role, source)
    if prepared:
        result = gemini_request(prepared, model)
        if len(result) != len(prepared):
            raise ValueError("Gemini response count does not match the request")
        unit_translations = {
            item["id"]: translated for item, translated in zip(prepared, result)
        }
    else:
        unit_translations = {}
    completed: dict[str, str] = {}
    for entry_id, (plan, is_json, literals) in plans.items():
        role, source = source_by_id[entry_id]
        try:
            completed[entry_id] = finish_gemini_plan(
                source, plan, is_json, unit_translations, entry_id, role, literals
            )
        except ValueError:
            if force_segmented or literals is None:
                raise
            completed.update(
                translate_gemini_batch(
                    [(entry_id, role, source)], model, force_segmented=True
                )
            )
    return completed


def translate_gemini_resilient(
    batch: list[tuple[str, str, str]], model: str
) -> dict[str, str]:
    try:
        return translate_gemini_batch(batch, model)
    except urllib.error.HTTPError:
        # Quota/server errors should be handled by the request retry policy or
        # by resuming the checkpoint with another configured model.
        raise
    except Exception:
        if len(batch) == 1:
            return translate_gemini_batch(batch, model, force_segmented=True)
        midpoint = len(batch) // 2
        completed = translate_gemini_resilient(batch[:midpoint], model)
        completed.update(translate_gemini_resilient(batch[midpoint:], model))
        return completed


def google_request(items: list[dict[str, str]], attempts: int = 7) -> list[str]:
    """Translate prose units through Google's public machine-translation endpoint."""
    markers = [f"[[[TAU_BATCH_{index:06d}]]]" for index in range(len(items) - 1)]
    pieces: list[str] = []
    for index, item in enumerate(items):
        pieces.append(item["content"])
        if index < len(markers):
            pieces.extend(["\n", markers[index], "\n"])
    body = urllib.parse.urlencode({"q": "".join(pieces)}).encode()
    host = os.environ.get("TAU_GOOGLE_TRANSLATE_HOST", "clients5.google.com")
    if not re.fullmatch(r"clients[1-5]\.google\.com", host):
        raise ValueError(f"unsupported Google translation host: {host}")
    url = f"https://{host}/translate_a/t?client=dict-chrome-ex&sl=en&tl=ko"
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "tau-domain-explorer-translation-builder/1.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=90) as response:
                payload = json.load(response)
            if payload and isinstance(payload[0], str):
                translated = "".join(payload)
            else:
                translated = "".join(
                    segment[0] for segment in payload[0] if segment and segment[0]
                )
            output: list[str] = []
            cursor = 0
            for marker in markers:
                position = translated.find(marker, cursor)
                if position < 0:
                    raise ValueError(f"Google Translate dropped batch marker {marker}")
                output.append(translated[cursor:position].strip())
                cursor = position + len(marker)
            output.append(translated[cursor:].strip())
            if len(output) != len(items) or any(not item for item in output):
                raise ValueError("Google Translate response count/content mismatch")
            return output
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError, IndexError, TypeError) as error:
            if attempt + 1 == attempts:
                raise
            if isinstance(error, urllib.error.HTTPError) and error.code not in {429, 500, 502, 503, 504}:
                raise
            delay = min(20, 2 ** attempt)
            print(f"Google translation retry {attempt + 1}/{attempts} in {delay}s: {error}", flush=True)
            time.sleep(delay)
    raise AssertionError("unreachable")


def translate_google_batch(batch: list[tuple[str, str, str]]) -> dict[str, str]:
    prepared: list[dict[str, str]] = []
    plans: dict[str, tuple[Any, bool]] = {}
    source_by_id: dict[str, tuple[str, str]] = {}
    for entry_id, role, source in batch:
        plan, is_json, units, literals = make_gemini_plan(
            source, entry_id, force_segmented=True
        )
        if literals is not None:
            raise AssertionError("segmented translation unexpectedly returned literals")
        prepared.extend(units)
        plans[entry_id] = (plan, is_json)
        source_by_id[entry_id] = (role, source)
    translated_units = google_request(prepared) if prepared else []
    translated_units = [
        verbalize_model_added_digits(value) for value in translated_units
    ]
    unit_translations = {
        item["id"]: translated
        for item, translated in zip(prepared, translated_units)
    }
    completed: dict[str, str] = {}
    for entry_id, (plan, is_json) in plans.items():
        role, source = source_by_id[entry_id]
        completed[entry_id] = finish_gemini_plan(
            source,
            plan,
            is_json,
            unit_translations,
            entry_id,
            role,
            None,
        )
    return completed


def translate_google_resilient(
    batch: list[tuple[str, str, str]],
) -> dict[str, str]:
    try:
        return translate_google_batch(batch)
    except urllib.error.HTTPError:
        raise
    except Exception:
        if len(batch) == 1:
            raise
        midpoint = len(batch) // 2
        completed = translate_google_resilient(batch[:midpoint])
        completed.update(translate_google_resilient(batch[midpoint:]))
        return completed


def should_translate_json_string(value: str) -> bool:
    stripped = value.strip()
    if not stripped or CONTROL_ONLY.fullmatch(stripped):
        return False
    if re.fullmatch(r"[A-Za-z0-9_.:/#@+-]+", stripped) and " " not in stripped:
        return False
    return bool(LATIN_WORD.search(stripped) or HANGUL.search(stripped))


def translate_json_value(value: Any, role: str) -> Any:
    if isinstance(value, str):
        return translate_plain(value, role) if should_translate_json_string(value) else value
    if isinstance(value, list):
        return [translate_json_value(item, role) for item in value]
    if isinstance(value, dict):
        return {key: translate_json_value(item, role) for key, item in value.items()}
    return value


def json_requires_hangul(value: Any) -> bool:
    if isinstance(value, str):
        return should_translate_json_string(value)
    if isinstance(value, list):
        return any(json_requires_hangul(item) for item in value)
    if isinstance(value, dict):
        return any(json_requires_hangul(item) for item in value.values())
    return False


def translate_content(content: str, role: str) -> str:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        translated = translate_plain(content, role)
        requires_hangul = bool(LATIN_WORD.search(PROTECTED.sub("", content)))
    else:
        translated = json.dumps(
            translate_json_value(parsed, role),
            ensure_ascii=False,
            indent=2,
        )
        requires_hangul = json_requires_hangul(parsed)
    if requires_hangul and not HANGUL.search(translated):
        raise ValueError("translated prose does not contain Hangul")
    for token in CONTROL_TOKEN.findall(content):
        if translated.count(token) != content.count(token):
            raise ValueError(f"control token was not preserved: {token}")
    return translated


def load_run(run_id: str) -> tuple[dict[str, Any], dict[str, tuple[str, str]]]:
    catalog = read_json(CATALOG_PATH)
    matches = [
        (domain, run)
        for domain in catalog["domains"]
        for run in domain["runs"]
        if run["id"] == run_id
    ]
    if len(matches) != 1:
        raise ValueError(f"expected one catalog run for {run_id}, found {len(matches)}")
    domain, run = matches[0]
    if domain["benchmark"] != "tau2" or run["model"] != "GPT-5":
        raise ValueError(f"{run_id} is not a pinned tau2 GPT-5 run")
    index = read_json(PROJECT_ROOT / f"public{run['indexPath']}")
    chunks: dict[str, Any] = {}
    expected: dict[str, tuple[str, str]] = {}
    for summary in index["trajectories"]:
        detail_path = summary["detailPath"]
        chunk = chunks.get(detail_path)
        if chunk is None:
            chunk = read_json(PROJECT_ROOT / f"public{detail_path}")
            chunks[detail_path] = chunk
        trajectory = chunk["trajectories"][summary["id"]]
        for message in trajectory["messages"]:
            content = message.get("content")
            if not isinstance(content, str) or not content.strip() or CONTROL_ONLY.fullmatch(content):
                continue
            entry_id, source_hash = message_id(message["role"], content)
            previous = expected.get(entry_id)
            current = (message["role"], source_hash)
            if previous is not None and previous != current:
                raise ValueError(f"message id collision: {entry_id}")
            expected[entry_id] = current
    return {"domain": domain, "run": run}, expected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checkpoint-every", type=int, default=20)
    parser.add_argument("--provider", choices=("argos", "gemini", "google"), default="argos")
    parser.add_argument("--gemini-model", default="gemini-2.5-flash")
    parser.add_argument("--batch-items", type=int, default=24)
    parser.add_argument("--batch-chars", type=int, default=24000)
    parser.add_argument("--batch-units", type=int, default=350)
    parser.add_argument("--batch-delay", type=float, default=0)
    parser.add_argument("--retranslate-invalid", action="store_true")
    args = parser.parse_args()

    metadata, expected = load_run(args.run_id)
    output_path = args.output.resolve()
    entries: dict[str, Any] = {}
    if output_path.exists():
        existing = read_json(output_path)
        if existing.get("runId") != args.run_id or existing.get("locale") != "ko":
            raise ValueError(f"incompatible translation checkpoint: {output_path}")
        entries = existing.get("entries", {})

    # Re-read exact source strings once, keyed by the validated IDs above.
    run = metadata["run"]
    index = read_json(PROJECT_ROOT / f"public{run['indexPath']}")
    chunks: dict[str, Any] = {}
    source_by_id: dict[str, tuple[str, str]] = {}
    for summary in index["trajectories"]:
        detail_path = summary["detailPath"]
        chunk = chunks.get(detail_path)
        if chunk is None:
            chunk = read_json(PROJECT_ROOT / f"public{detail_path}")
            chunks[detail_path] = chunk
        for message in chunk["trajectories"][summary["id"]]["messages"]:
            content = message.get("content")
            if not isinstance(content, str) or not content.strip() or CONTROL_ONLY.fullmatch(content):
                continue
            entry_id, _source_hash = message_id(message["role"], content)
            source_by_id[entry_id] = (message["role"], content)

    def payload() -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "datasetId": DATASET_ID,
            "locale": "ko",
            "model": "GPT-5",
            "domainId": metadata["domain"]["id"],
            "runId": args.run_id,
            "entries": dict(sorted(entries.items())),
        }

    stale = set(entries) - set(expected)
    if stale:
        raise ValueError(f"checkpoint has {len(stale)} entries not present in the run")
    if args.retranslate_invalid:
        invalid: list[str] = []
        for entry_id, entry in entries.items():
            role, source = source_by_id[entry_id]
            translated = entry.get("content")
            source_literals = sorted(PROTECTED.findall(source))
            translated_literals = (
                sorted(PROTECTED.findall(translated))
                if isinstance(translated, str)
                else []
            )
            if (
                entry.get("role") != role
                or entry.get("sourceHash") != message_id(role, source)[1]
                or not isinstance(translated, str)
                or not HANGUL.search(translated)
                or source_literals != translated_literals
            ):
                invalid.append(entry_id)
        for entry_id in invalid:
            entries.pop(entry_id)
        if invalid:
            write_json_atomic(output_path, payload())
            print(
                f"{args.run_id}: removed {len(invalid)} invalid checkpoint translations",
                flush=True,
            )

    completed = len(entries)
    total = len(expected)
    print(f"{args.run_id}: {completed}/{total} translations already present", flush=True)
    pending = [entry_id for entry_id in sorted(expected) if entry_id not in entries]
    while pending:
        batch_ids: list[str] = []
        batch_chars = 0
        batch_units = 0
        for entry_id in pending:
            _role, content = source_by_id[entry_id]
            if args.provider == "gemini":
                unit_count = len(make_gemini_plan(content, entry_id)[2])
            elif args.provider == "google":
                unit_count = len(
                    make_gemini_plan(content, entry_id, force_segmented=True)[2]
                )
            else:
                unit_count = 1
            if batch_ids and (
                len(batch_ids) >= args.batch_items
                or batch_chars + len(content) > args.batch_chars
                or batch_units + unit_count > args.batch_units
            ):
                break
            batch_ids.append(entry_id)
            batch_chars += len(content)
            batch_units += unit_count
        batch = [(entry_id, *source_by_id[entry_id]) for entry_id in batch_ids]
        try:
            if args.provider == "gemini":
                translations = translate_gemini_resilient(batch, args.gemini_model)
            elif args.provider == "google":
                translations = translate_google_resilient(batch)
            else:
                translations = {
                    entry_id: translate_content(content, role)
                    for entry_id, role, content in batch
                }
        except Exception as error:
            print(f"failed batch beginning {batch_ids[0]}: {error}", file=sys.stderr, flush=True)
            write_json_atomic(output_path, payload())
            raise
        for entry_id in batch_ids:
            role, content = source_by_id[entry_id]
            _entry_id, source_hash = message_id(role, content)
            entries[entry_id] = {
                "role": role,
                "sourceHash": source_hash,
                "content": translations[entry_id],
            }
        completed += len(batch_ids)
        pending = pending[len(batch_ids) :]
        if completed % args.checkpoint_every < len(batch_ids) or not pending:
            write_json_atomic(output_path, payload())
            print(f"{args.run_id}: {completed}/{total}", flush=True)
        if pending and args.batch_delay > 0:
            time.sleep(args.batch_delay)

    write_json_atomic(output_path, payload())
    print(f"{args.run_id}: complete ({total} distinct messages)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
