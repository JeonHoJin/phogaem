#!/usr/bin/env python3
"""Bounded local Gemma vision probe with content-addressed descriptor caching.

This is a synthetic experiment, not a validated duplicate detector. No model
management, external API, database writes, or application background jobs.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PROMPT_VERSION = "phogaem-vision-descriptor-v1"
RELATIONS = {"same_photo", "similar_scene", "different", "uncertain"}
DESCRIPTOR_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "scene": {"type": "string"}, "people": {"type": "integer", "minimum": 0},
        "objects": {"type": "array", "items": {"type": "string"}},
        "layout": {"type": "string"},
        "distinctive_details": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["scene", "people", "objects", "layout", "distinctive_details"],
}
PAIR_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"relation": {"type": "string", "enum": sorted(RELATIONS)},
                   "reason": {"type": "string"}},
    "required": ["relation", "reason"],
}
DESCRIPTOR_PROMPT = (
    "Describe only what is visibly present in this image. Output one compact JSON object, "
    "no markdown or reasoning: {\"scene\":\"short scene description\",\"people\":0,"
    "\"objects\":[\"visible object\"],\"layout\":\"positions and composition\","
    "\"distinctive_details\":[\"specific visible detail\"]}. "
    "Count visible people carefully. Do not infer location or identities."
)
PAIR_PROMPT = (
    "Compare A and B. same_photo means the SAME underlying image, allowing JPEG "
    "recompression, resize or a small crop. similar_scene means related subjects or "
    "composition but visible differences such as people count or object positions. "
    "different means a different viewpoint or composition, even if both scenes are beaches. similar_scene requires the same capture setup with minor pose, count or position changes. Use uncertain if evidence is insufficient. "
    "Output ONLY compact JSON {\"relation\":\"same_photo|similar_scene|different|uncertain\","
    "\"reason\":\"one short evidence-based sentence\"}."
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Redirects are disabled for local model requests")


def local_base(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path.rstrip("/") != "/v1"):
        raise ValueError("base URL must be an HTTP loopback /v1 endpoint")
    return value.rstrip("/")


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def unwrap_output(content: str) -> tuple[str, str]:
    text = content.strip()
    # A single whole-response JSON fence is presentation, not additional evidence.
    # Prose, multiple fences, reasoning blocks, and partial JSON stay invalid.
    fence = re.fullmatch(r"```json[ \t]*\r?\n([\s\S]*?)\r?\n```", text, re.IGNORECASE)
    return (fence.group(1), "json_fence") if fence else (text, "raw_json")


def parse_output(content: str, kind: str) -> dict:
    text, _wrapper = unwrap_output(content)
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("Model output must be a JSON object")
    if kind == "descriptor":
        if set(data) != set(DESCRIPTOR_SCHEMA["required"]):
            raise ValueError("Descriptor keys do not match the schema")
        if not isinstance(data["scene"], str) or not isinstance(data["layout"], str):
            raise ValueError("Descriptor scene/layout must be strings")
        if type(data["people"]) is not int or data["people"] < 0:
            raise ValueError("Descriptor people must be a nonnegative integer")
        for key in ("objects", "distinctive_details"):
            if not isinstance(data[key], list) or not all(isinstance(item, str) for item in data[key]):
                raise ValueError(f"Descriptor {key} must contain strings")
    elif set(data) != {"relation", "reason"} or data["relation"] not in RELATIONS or not isinstance(data["reason"], str):
        raise ValueError("Invalid pair relation/reason")
    return data


def cache_key(digest: str, model: str, settings: dict) -> str:
    identity = {"sha256": digest, "model": model, "prompt_version": PROMPT_VERSION, "settings": settings}
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def read_cache(path: Path) -> dict:
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError("Cache must be an object")
    return data


def load_fixtures(path: Path, maximum: int) -> tuple[list[dict], list[dict]]:
    manifest = json.loads(path.read_text())
    root = path.resolve().parent
    images = []
    seen = set()
    for source in manifest["images"][:maximum]:
        image = dict(source)
        if image["id"] in seen:
            raise ValueError("Duplicate fixture id")
        seen.add(image["id"])
        file = (root / image["path"]).resolve()
        if not file.is_relative_to(root):
            raise ValueError("Fixture path escapes manifest directory")
        content = file.read_bytes()
        if len(content) > 5 * 1024 * 1024:
            raise ValueError("Fixture is larger than the 5MiB experiment limit")
        digest = hashlib.sha256(content).hexdigest()
        if image.get("sha256") != digest:
            raise ValueError(f"Fixture hash mismatch: {image['id']}")
        kind = mimetypes.guess_type(file.name)[0]
        if kind not in {"image/png", "image/jpeg", "image/webp"}:
            raise ValueError("Experiment accepts only PNG/JPEG/WebP fixtures")
        image["data_url"] = f"data:{kind};base64," + base64.b64encode(content).decode()
        images.append(image)
    return images, manifest.get("pairs", [])


class Client:
    def __init__(self, base: str, model: str, timeout: float, settings: dict):
        self.base, self.model, self.timeout, self.settings = local_base(base), model, timeout, settings
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.calls = 0
        self.api = settings.get("api", "openai")

    def request(self, path: str, body: dict | None = None) -> dict:
        url = self.base.removesuffix("/v1") + path if path.startswith("/api/v1/") else self.base + path
        request = urllib.request.Request(url,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"content-type": "application/json"} if body is not None else {})
        with self.opener.open(request, timeout=self.timeout) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Model response exceeds experiment limit")
        return json.loads(raw)

    def verify_model(self) -> None:
        native = self.api == "native"
        models = self.request("/api/v1/models" if native else "/models").get("models" if native else "data", [])
        selected = next((item for item in models if item.get("key" if native else "id") == self.model), None)
        if selected is None:
            raise ValueError(f"Model is not available locally: {self.model}")
        self.metadata = {key: selected[key] for key in ("key", "id", "format", "quantization", "selected_variant", "size_bytes") if key in selected}

    def infer(self, content: list[dict], kind: str) -> dict:
        self.calls += 1
        started = time.monotonic()
        result = {"ok": False}
        if self.api == "native":
            inputs = [({"type": "text", "content": item["text"]} if item["type"] == "text" else
                       {"type": "image", "data_url": item["image_url"]["url"]}) for item in content]
            body = {"model": self.model, "input": inputs, "reasoning": "off",
                    "max_output_tokens": self.settings["max_tokens"], "temperature": 0, "store": False}
        else:
            body = {"model": self.model, "messages": [{"role": "user", "content": content}],
                    "temperature": 0, "max_tokens": self.settings["max_tokens"], "stream": False}
            if self.settings.get("reasoning_effort") is not None:
                body["reasoning_effort"] = self.settings["reasoning_effort"]
            if self.settings["structured"]:
                body["response_format"] = {"type": "json_schema", "json_schema": {
                    "name": kind, "strict": True,
                    "schema": DESCRIPTOR_SCHEMA if kind == "descriptor" else PAIR_SCHEMA}}
        try:
            response = self.request("/api/v1/chat" if self.api == "native" else "/chat/completions", body)
            if self.api == "native":
                output = response.get("output", [])
                raw = "\n".join(item["content"] for item in output if item.get("type") == "message")
                stats = response.get("stats", {})
                result.update(raw=raw, reasoning=[item for item in output if item.get("type") == "reasoning"],
                              finish_reason="not_reported", usage=stats)
                if stats.get("total_output_tokens", 0) >= self.settings["max_tokens"]:
                    raise ValueError("Native output reached token budget; treat as potentially truncated")
            else:
                choice = response["choices"][0]
                result.update(raw=choice["message"].get("content", ""),
                              reasoning=choice["message"].get("reasoning_content"),
                              finish_reason=choice.get("finish_reason"), usage=response.get("usage", {}))
                if choice.get("finish_reason") != "stop":
                    raise ValueError("Model output did not finish normally")
            _text, result["output_wrapper"] = unwrap_output(result["raw"])
            result["parsed"] = parse_output(result["raw"], kind)
            result["ok"] = True
        except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
            if isinstance(error, urllib.error.HTTPError):
                result["error"] = f"HTTP {error.code}: {error.read(2048).decode(errors='replace')}"
            else:
                result["error"] = f"{type(error).__name__}: {error}"
            cause = getattr(error, "reason", error)
            if isinstance(cause, TimeoutError) or "timed out" in str(cause).lower():
                # A timed-out server may still be generating. Do not enqueue more work.
                result["halt"] = True
        result["elapsed_s"] = round(time.monotonic() - started, 3)
        return result


def image_input(image: dict) -> dict:
    return {"type": "image_url", "image_url": {"url": image["data_url"]}}


def run(args, client: Client | None = None) -> dict:
    settings = {"max_tokens": args.max_tokens, "structured": args.structured, "temperature": 0,
                "reasoning_effort": getattr(args, "reasoning_effort", None),
                "api": getattr(args, "api", "openai"), "native_reasoning": "off"}
    if settings["api"] == "native" and args.structured:
        raise ValueError("--structured is only supported by the openai adapter; native uses a JSON prompt")
    client = client or Client(args.base_url, args.model, args.timeout, settings)
    client.verify_model()
    images, pairs = load_fixtures(args.fixtures, args.max_images)
    cache = read_cache(args.cache)
    result = {"model": args.model, "runtime_model": getattr(client, "metadata", {}), "prompt_version": PROMPT_VERSION, "settings": settings,
              "limitations": "Small synthetic fixture probe; not a calibrated real-photo accuracy benchmark. Descriptors are not image embeddings.",
              "descriptors": [], "pairs": [], "summary": {}}
    descriptors = {}
    cache_hits = 0
    halted = False
    for image in images:
        key = cache_key(image["sha256"], args.model, settings)
        cached = cache.get(key)
        try:
            parsed = parse_output(json.dumps(cached["parsed"]), "descriptor") if cached else None
        except (KeyError, ValueError, TypeError):
            parsed = None
        if parsed is not None:
            record = {"ok": True, "parsed": parsed, "cache_hit": True, "elapsed_s": 0}
            cache_hits += 1
        else:
            record = client.infer([{"type": "text", "text": DESCRIPTOR_PROMPT}, image_input(image)], "descriptor")
            record["cache_hit"] = False
            if record["ok"]:
                cache[key] = {"parsed": record["parsed"], "model": args.model,
                              "sha256": image["sha256"], "prompt_version": PROMPT_VERSION, "settings": settings}
                atomic_json(args.cache, cache)
        if record["ok"]:
            descriptors[image["id"]] = record["parsed"]
        result["descriptors"].append({"id": image["id"], "sha256": image["sha256"],
                                      "expected": image.get("expected"), **record})
        atomic_json(args.output, result)
        if record.get("halt"):
            halted = True
            break
    lookup = {image["id"]: image for image in images}
    if not args.descriptors_only and not halted:
        for pair in pairs[:args.limit_pairs]:
            if pair["a"] not in lookup or pair["b"] not in lookup:
                continue
            a, b = lookup[pair["a"]], lookup[pair["b"]]
            baseline = {"sha256_equal": a["sha256"] == b["sha256"]}
            if a.get("dhash") is not None and b.get("dhash") is not None:
                baseline["dhash_hamming"] = bin(int(a["dhash"], 16) ^ int(b["dhash"], 16)).count("1")
            entry = {**pair, "baselines": baseline}
            if pair["a"] in descriptors and pair["b"] in descriptors:
                # Text-only comparison demonstrates what can and cannot be recovered from cached descriptions.
                prompt = PAIR_PROMPT + " Only these cached descriptions are available, so do not invent missing visual detail.\nA=" + json.dumps(descriptors[pair["a"]]) + "\nB=" + json.dumps(descriptors[pair["b"]])
                entry["descriptor_comparison"] = client.infer([{"type": "text", "text": prompt}], "pair")
            if entry.get("descriptor_comparison", {}).get("halt"):
                halted = True
            if not args.skip_direct and not halted:
                entry["direct_comparison"] = client.infer([
                    {"type": "text", "text": PAIR_PROMPT + " First image is A; second image is B."},
                    image_input(a), image_input(b)], "pair")
            result["pairs"].append(entry)
            atomic_json(args.output, result)
            if halted or entry.get("direct_comparison", {}).get("halt"):
                halted = True
                break
    result["summary"] = {"images": len(images), "descriptor_cache_hits": cache_hits,
                         "successful_descriptors": len(descriptors), "inference_calls": client.calls,
                         "pairs": len(result["pairs"]), "halted_after_timeout": halted}
    atomic_json(args.output, result)
    return result


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:1234/v1")
    parser.add_argument("--model", default="google/gemma-4-e4b")
    parser.add_argument("--api", choices=["native", "openai"], default="native")
    parser.add_argument("--output", type=Path, default=Path(".local/gemma-vision/results.json"))
    parser.add_argument("--cache", type=Path, default=Path(".local/gemma-vision/cache.json"))
    parser.add_argument("--max-images", type=int, default=20)
    parser.add_argument("--limit-pairs", type=int, default=4)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--reasoning-effort", choices=["none", "low", "medium", "high"],
                        help="Optional runtime-specific reasoning_effort; verify support before use")
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--structured", action="store_true")
    parser.add_argument("--descriptors-only", action="store_true")
    parser.add_argument("--skip-direct", action="store_true", help="Only compare cached descriptors; do not send pairs of images")
    args = parser.parse_args()
    if not 1 <= args.max_images <= 20 or not 0 <= args.limit_pairs <= 20 or not 1 <= args.max_tokens <= 1024 or not 1 <= args.timeout <= 120:
        parser.error("Limits: images 1..20, pairs 0..20, tokens 1..1024, timeout 1..120 seconds")
    return args


if __name__ == "__main__":
    try:
        report = run(arguments())
        print(json.dumps(report["summary"], ensure_ascii=False))
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(f"Vision probe failed: {error}")
