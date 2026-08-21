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
import subprocess
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
            r"[$€£¥]\s?\d(?:\d|[,.](?=\d))*(?:\s?(?:USD|EUR|GBP|KRW))?",
            r"\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{3,}\b",
            r"\b[a-z][a-z0-9_]+\((?=[^()\n]*(?:=|[\"']))[^()\n]*\)",
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

CLAUDE_LOCALIZATION_SYSTEM = """You are a senior Korean localization editor for customer-service transcripts.
Translate every supplied content string into idiomatic, accurate Korean while respecting its role.

- An assistant speaks in professional polite Korean, calls the customer '고객님' only when natural, and never uses 귀하 or 당신. The assistant says 고객님의 계정/회선/휴대폰/SIM, never 제 계정/제 회선/제 휴대폰/제 SIM.
- A user speaks naturally in the first person with 저/제 and never addresses themself as 고객님.
- Preserve the exact meaning, subject, conditions, negation, quantities, comparisons, and temporal relationships.
- Use correct service terminology: order=주문, exchange=교환, return=반품, refund=환불, item=상품, puzzle pieces=퍼즐 조각, boots=부츠, and airline cabin classes=베이직 이코노미/이코노미/비즈니스석.
- For telecom, line=회선, plan=요금제, bill=청구서, refuel/add data=데이터 추가, No Service=서비스 없음, No Signal=신호 없음, Data Disabled=데이터 사용 중지, ON=켜짐, OFF=꺼짐.
- Never translate literal IDs, product codes, dates, amounts, card brands, airport codes, tool names, JSON keys, or non-string JSON values.
- Every <TAUKEEPn> marker is an essential literal. Preserve its exact spelling and count, keep it in the same sentence or list item, and attach it to the same noun, action, and comparison as in the source. Never merge, duplicate, omit, or move markers.
- Preserve Markdown structure, line breaks, JSON syntax, object keys, arrays, and control tokens.
- Translate all human-readable prose without adding explanations, invented details, or omitted content.

Return only the structured translations requested by the schema, in exactly the same order as the input."""


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
            # Source-side numbers are always protected before the model sees a
            # prose unit. Any Arabic digits returned inside that unit were
            # invented while spelling an English number word (for example,
            # ``once`` -> ``1회``). Render only those added digits as Korean
            # words so they cannot be mistaken for canonical order, card, date,
            # quantity, or amount literals.
            return polish(verbalize_model_added_digits(unit_translations[key]), role)

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


def gemini_request(items: list[dict[str, str]], model: str, attempts: int = 7) -> list[str]:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise ValueError("GEMINI_API_KEY is required for --provider gemini")
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={key}"
    )
    instruction = (
        "You are a senior Korean localization editor for a customer-service transcript. Translate every "
        "content value into idiomatic, accurate Korean while respecting its role. An assistant speaks in "
        "professional polite Korean, calls the customer '고객님' only when natural, and never uses 귀하 or 당신. "
        "The assistant must say 고객님의 계정/회선/휴대폰/SIM, never 제 계정/제 회선/제 휴대폰/제 SIM. "
        "A user speaks naturally in the first person with 저/제 and does not address themself as 고객님. "
        "Preserve the exact meaning, subject, conditions, negation, quantities, and temporal relationships. "
        "Use correct service terminology: order=주문, exchange=교환, return=반품, refund=환불, item=상품, "
        "puzzle pieces=퍼즐 조각, boots=부츠, and airline cabin classes=베이직 이코노미/이코노미/비즈니스석. "
        "For telecom, line=회선, plan=요금제, bill=청구서, refuel/add data=데이터 추가, No Service=서비스 없음, "
        "No Signal=신호 없음, Data Disabled=데이터 사용 중지, ON=켜짐, and OFF=꺼짐. "
        "Do not translate literal IDs, product codes, dates, amounts, card brands, airport codes, or tool names. "
        "Every <TAUKEEPn> marker represents an essential literal. Preserve its spelling and count, keep it in "
        "the same sentence or list item, and attach it to the same noun, action, and comparison as in the source; "
        "never move a marker into a later clause or paragraph. Preserve Markdown structure, "
        "line breaks, JSON syntax, JSON object keys, arrays, and non-string JSON literals. Translate all supplied "
        "human-readable prose without adding explanations, invented dates, or omitted content. Return a JSON array "
        "with exactly one translated string for every input object, in exactly the same order.\n\nINPUT:\n"
        + json.dumps(
            [
                {"role": item.get("role", "unknown"), "content": item["content"]}
                for item in items
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        )
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
    if not model.startswith(("gemini-3.5", "gemini-3.6", "gemini-3.7", "gemma-")):
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
            with urllib.request.urlopen(request, timeout=600) as response:
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


def claude_request(items: list[dict[str, str]], model: str, attempts: int = 3) -> list[str]:
    """Translate a batch through the authenticated local Claude CLI.

    The CLI is run without tools, project customizations, or session persistence.
    A strict schema keeps batch ordering deterministic while the existing plan
    and validators retain authority over every protected literal and JSON shape.
    """
    schema = {
        "type": "object",
        "properties": {
            "translations": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": len(items),
                "maxItems": len(items),
            }
        },
        "required": ["translations"],
        "additionalProperties": False,
    }
    prompt = (
        "Translate this JSON array. Each object has a speaker role and exact content. "
        "Return one translation for every object in the same order.\n\nINPUT:\n"
        + json.dumps(
            [
                {"role": item.get("role", "unknown"), "content": item["content"]}
                for item in items
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    command = [
        "claude",
        "-p",
        "--model",
        model,
        "--safe-mode",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--max-budget-usd",
        "2",
        "--system-prompt",
        CLAUDE_LOCALIZATION_SYSTEM,
        "--json-schema",
        json.dumps(schema, separators=(",", ":")),
        prompt,
    ]
    for attempt in range(attempts):
        try:
            completed = subprocess.run(
                command,
                cwd=PROJECT_ROOT,
                check=True,
                capture_output=True,
                text=True,
                timeout=600,
            )
            payload = json.loads(completed.stdout)
            structured = payload.get("structured_output")
            result = structured.get("translations") if isinstance(structured, dict) else None
            if (
                not isinstance(result, list)
                or len(result) != len(items)
                or any(not isinstance(item, str) for item in result)
            ):
                raise ValueError("Claude response does not match the translation schema")
            return result
        except (subprocess.SubprocessError, json.JSONDecodeError, ValueError) as error:
            if attempt + 1 == attempts:
                raise
            delay = min(15, 2 ** attempt)
            print(f"Claude request retry {attempt + 1}/{attempts} in {delay}s: {error}", flush=True)
            time.sleep(delay)
    raise AssertionError("unreachable")


def translate_gemini_batch(
    batch: list[tuple[str, str, str]],
    model: str,
    *,
    force_segmented: bool = False,
    defer_invalid: bool = False,
    request_units: Any | None = None,
) -> dict[str, str]:
    prepared: list[dict[str, str]] = []
    plans: dict[str, tuple[Any, bool, list[str] | None]] = {}
    source_by_id: dict[str, tuple[str, str]] = {}
    for entry_id, role, source in batch:
        plan, is_json, units, literals = make_gemini_plan(
            source, entry_id, force_segmented=force_segmented
        )
        for unit in units:
            unit["role"] = role
        prepared.extend(units)
        plans[entry_id] = (plan, is_json, literals)
        source_by_id[entry_id] = (role, source)
    if prepared:
        result = request_units(prepared) if request_units else gemini_request(prepared, model)
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
        except ValueError as error:
            if defer_invalid:
                print(f"deferred invalid translation {entry_id}: {error}", flush=True)
                continue
            if force_segmented or literals is None:
                raise
            # A long multi-item response may associate a marker with the wrong
            # array element even when the schema count is valid. Retry the
            # affected entry alone with its full sentence context first;
            # segment into prose spans only if that single-item response still
            # cannot preserve its markers.
            completed.update(
                translate_gemini_batch(
                    [(entry_id, role, source)],
                    model,
                    force_segmented=len(batch) == 1,
                    defer_invalid=defer_invalid,
                    request_units=request_units,
                )
            )
    return completed


def translate_gemini_resilient(
    batch: list[tuple[str, str, str]],
    model: str,
    *,
    force_segmented: bool = False,
    defer_invalid: bool = False,
    request_units: Any | None = None,
) -> dict[str, str]:
    try:
        return translate_gemini_batch(
            batch,
            model,
            force_segmented=force_segmented,
            defer_invalid=defer_invalid,
            request_units=request_units,
        )
    except urllib.error.HTTPError:
        # Quota/server errors should be handled by the request retry policy or
        # by resuming the checkpoint with another configured model.
        raise
    except Exception:
        if len(batch) == 1:
            return translate_gemini_batch(
                batch,
                model,
                force_segmented=True,
                request_units=request_units,
            )
        midpoint = len(batch) // 2
        completed = translate_gemini_resilient(
            batch[:midpoint],
            model,
            force_segmented=force_segmented,
            defer_invalid=defer_invalid,
            request_units=request_units,
        )
        completed.update(
            translate_gemini_resilient(
                batch[midpoint:],
                model,
                force_segmented=force_segmented,
                defer_invalid=defer_invalid,
                request_units=request_units,
            )
        )
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
    parser.add_argument(
        "--provider",
        choices=("argos", "claude", "gemini", "google"),
        default="argos",
    )
    parser.add_argument("--gemini-model", default="gemini-2.5-flash")
    parser.add_argument("--claude-model", default="sonnet")
    parser.add_argument("--batch-items", type=int, default=24)
    parser.add_argument("--batch-chars", type=int, default=24000)
    parser.add_argument("--batch-units", type=int, default=350)
    parser.add_argument("--batch-delay", type=float, default=0)
    parser.add_argument("--retranslate-invalid", action="store_true")
    parser.add_argument(
        "--force-retranslate-all",
        action="store_true",
        help="Discard the existing checkpoint in memory and rebuild every entry.",
    )
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--force-segmented", action="store_true")
    parser.add_argument("--defer-invalid", action="store_true")
    parser.add_argument(
        "--merge-shard",
        action="append",
        type=Path,
        default=[],
        help="Merge a complete set of disjoint translation checkpoints and exit.",
    )
    args = parser.parse_args()

    if args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count:
        raise ValueError("shard-index must be within [0, shard-count)")

    metadata, expected = load_run(args.run_id)
    output_path = args.output.resolve()
    entries: dict[str, Any] = {}
    if output_path.exists():
        existing = read_json(output_path)
        if existing.get("runId") != args.run_id or existing.get("locale") != "ko":
            raise ValueError(f"incompatible translation checkpoint: {output_path}")
        if not args.force_retranslate_all:
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

    if args.merge_shard:
        merged: dict[str, Any] = {}
        for shard_path in args.merge_shard:
            shard = read_json(shard_path.resolve())
            for field, expected_value in (
                ("schemaVersion", 1),
                ("datasetId", DATASET_ID),
                ("locale", "ko"),
                ("model", "GPT-5"),
                ("domainId", metadata["domain"]["id"]),
                ("runId", args.run_id),
            ):
                if shard.get(field) != expected_value:
                    raise ValueError(f"incompatible shard {shard_path}: {field}")
            for entry_id, entry in shard.get("entries", {}).items():
                if entry_id in merged:
                    raise ValueError(f"duplicate entry across shards: {entry_id}")
                merged[entry_id] = entry
        missing = set(expected) - set(merged)
        extra = set(merged) - set(expected)
        if missing or extra:
            raise ValueError(
                f"merged shard coverage mismatch: missing={len(missing)} extra={len(extra)}"
            )
        entries = merged
        write_json_atomic(output_path, payload())
        print(f"{args.run_id}: merged {len(entries)}/{len(expected)} translations")
        return 0

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

    target_ids = [
        entry_id
        for position, entry_id in enumerate(sorted(expected))
        if position % args.shard_count == args.shard_index
    ]
    completed = sum(entry_id in entries for entry_id in target_ids)
    total = len(target_ids)
    print(f"{args.run_id}: {completed}/{total} translations already present", flush=True)
    pending = [entry_id for entry_id in target_ids if entry_id not in entries]
    deferred_ids: set[str] = set()
    while pending:
        batch_ids: list[str] = []
        batch_chars = 0
        batch_units = 0
        for entry_id in pending:
            _role, content = source_by_id[entry_id]
            if args.provider in {"claude", "gemini"}:
                unit_count = len(
                    make_gemini_plan(
                        content,
                        entry_id,
                        force_segmented=args.force_segmented,
                    )[2]
                )
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
                translations = translate_gemini_resilient(
                    batch,
                    args.gemini_model,
                    force_segmented=args.force_segmented,
                    defer_invalid=args.defer_invalid,
                )
            elif args.provider == "claude":
                translations = translate_gemini_resilient(
                    batch,
                    args.claude_model,
                    force_segmented=args.force_segmented,
                    defer_invalid=args.defer_invalid,
                    request_units=lambda items: claude_request(
                        items, args.claude_model
                    ),
                )
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
        translated_ids = [entry_id for entry_id in batch_ids if entry_id in translations]
        missing_batch_ids = set(batch_ids) - set(translated_ids)
        if missing_batch_ids and not args.defer_invalid:
            raise ValueError(
                f"translation batch omitted {len(missing_batch_ids)} entries"
            )
        deferred_ids.update(missing_batch_ids)
        for entry_id in translated_ids:
            role, content = source_by_id[entry_id]
            _entry_id, source_hash = message_id(role, content)
            entries[entry_id] = {
                "role": role,
                "sourceHash": source_hash,
                "content": translations[entry_id],
            }
        completed += len(translated_ids)
        pending = pending[len(batch_ids) :]
        if completed % args.checkpoint_every < len(translated_ids) or not pending:
            write_json_atomic(output_path, payload())
            print(f"{args.run_id}: {completed}/{total}", flush=True)
        if pending and args.batch_delay > 0:
            time.sleep(args.batch_delay)

    write_json_atomic(output_path, payload())
    print(
        f"{args.run_id}: complete ({completed}/{total} translated, {len(deferred_ids)} deferred)",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
