"""Local-only regression tests. No inference or server requests."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("vision_probe", Path(__file__).parents[1] / "scripts/vision-probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
DESCRIPTOR = {"scene": "beach", "people": 2, "objects": ["umbrella"], "layout": "umbrella left", "distinctive_details": ["red umbrella"]}


class FakeClient:
    calls = 0
    def verify_model(self):
        pass
    def infer(self, content, kind):
        self.calls += 1
        value = dict(DESCRIPTOR) if kind == "descriptor" else {"relation": "uncertain", "reason": "Synthetic descriptions only"}
        return {"ok": True, "parsed": value, "raw": json.dumps(value), "finish_reason": "stop", "elapsed_s": .1}


class ProbeTests(unittest.TestCase):
    def test_only_loopback_and_no_redirects(self):
        self.assertEqual(probe.local_base("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1")
        for address in ["https://example.com/v1", "http://localhost.evil/v1", "http://user@localhost/v1", "http://localhost/v1?key=x"]:
            with self.assertRaises(ValueError):
                probe.local_base(address)
        with self.assertRaises(ValueError):
            probe.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com")

    def test_strict_json_and_schema_reject_hallucinated_vector_or_truncation(self):
        self.assertEqual(probe.parse_output(json.dumps(DESCRIPTOR), "descriptor"), DESCRIPTOR)
        for output in ['```json\n{}\n```', '{"scene":', '[0.1,0.2]', json.dumps({**DESCRIPTOR, "people": True})]:
            with self.assertRaises(ValueError):
                probe.parse_output(output, "descriptor")
        with self.assertRaises(ValueError):
            probe.parse_output('{"relation":"identical","reason":"yes"}', "pair")

    def test_single_entire_json_fence_is_accepted_but_prose_or_multiple_outputs_are_not(self):
        raw = json.dumps(DESCRIPTOR)
        fenced = "```json\n" + raw + "\n```"
        self.assertEqual(probe.parse_output(fenced, "descriptor"), DESCRIPTOR)
        self.assertEqual(probe.unwrap_output(fenced)[1], "json_fence")
        self.assertEqual(probe.unwrap_output(raw)[1], "raw_json")
        for value in ["Here is the result: " + fenced, fenced + "\n" + fenced,
                      raw + "\n" + raw, "```json\n{\n```", "<think>reason</think>" + raw]:
            with self.assertRaises(ValueError):
                probe.parse_output(value, "descriptor")

    def test_cache_identity_includes_content_model_prompt_and_settings(self):
        settings = {"max_tokens": 256, "structured": False, "temperature": 0}
        key = probe.cache_key("one", "model-a", settings)
        self.assertNotEqual(key, probe.cache_key("two", "model-a", settings))
        self.assertNotEqual(key, probe.cache_key("one", "model-b", settings))
        self.assertNotEqual(key, probe.cache_key("one", "model-a", {**settings, "structured": True}))
        previous = probe.PROMPT_VERSION
        try:
            probe.PROMPT_VERSION = "new-prompt"
            self.assertNotEqual(key, probe.cache_key("one", "model-a", settings))
        finally:
            probe.PROMPT_VERSION = previous

    def test_second_run_reuses_cached_analysis_and_invalid_cache_recomputes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "fixture.png").write_bytes(b"synthetic-test-bytes")
            image = {"id": "a", "path": "fixture.png", "sha256": hashlib.sha256(b"synthetic-test-bytes").hexdigest()}
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"images": [image], "pairs": []}))
            args = argparse.Namespace(fixtures=manifest, max_images=20, base_url="http://localhost:1234/v1", model="test", timeout=1,
                max_tokens=256, structured=False, cache=root / "cache.json", output=root / "result.json", descriptors_only=True, skip_direct=False, limit_pairs=4)
            first = FakeClient()
            self.assertEqual(probe.run(args, first)["summary"]["inference_calls"], 1)
            second = FakeClient()
            report = probe.run(args, second)
            self.assertEqual(report["summary"]["descriptor_cache_hits"], 1)
            self.assertEqual(second.calls, 0)
            self.assertEqual(args.cache.stat().st_mode & 0o777, 0o600)
            cache = json.loads(args.cache.read_text())
            next(iter(cache.values()))["parsed"] = {"invalid": True}
            args.cache.write_text(json.dumps(cache))
            third = FakeClient()
            self.assertEqual(probe.run(args, third)["summary"]["inference_calls"], 1)

    def test_timeout_halts_before_subsequent_images_or_pair_requests(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "a.png").write_bytes(b"a")
            images = [{"id": str(i), "path": "a.png", "sha256": hashlib.sha256(b"a").hexdigest()} for i in range(2)]
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"images": images, "pairs": [{"a": "0", "b": "1", "expected": "same_photo"}]}))
            args = argparse.Namespace(fixtures=manifest, max_images=20, base_url="http://localhost:1234/v1", model="test", timeout=1,
                max_tokens=256, structured=False, cache=root / "cache.json", output=root / "result.json", descriptors_only=False, skip_direct=False, limit_pairs=4)
            client = FakeClient()
            def timeout(*_):
                client.calls += 1
                return {"ok": False, "halt": True, "error": "timed out"}
            client.infer = timeout
            result = probe.run(args, client)
            self.assertEqual(client.calls, 1)
            self.assertTrue(result["summary"]["halted_after_timeout"])
            self.assertEqual(result["pairs"], [])

    def test_native_adapter_sends_images_without_reasoning_and_detects_token_limit(self):
        client = probe.Client("http://localhost:1234/v1", "test", 1,
                             {"api": "native", "max_tokens": 256, "structured": False})
        captured = []
        def respond(path, body=None):
            captured.append((path, body))
            return {"output": [{"type": "message", "content": json.dumps(DESCRIPTOR)}],
                    "stats": {"total_output_tokens": 50, "reasoning_output_tokens": 0}}
        client.request = respond
        content = [{"type": "text", "text": "describe"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}]
        result = client.infer(content, "descriptor")
        self.assertTrue(result["ok"])
        self.assertEqual(result["finish_reason"], "not_reported")
        self.assertEqual(result["output_wrapper"], "raw_json")
        self.assertEqual(captured[0][0], "/api/v1/chat")
        self.assertEqual(captured[0][1]["reasoning"], "off")
        self.assertFalse(captured[0][1]["store"])
        self.assertEqual(captured[0][1]["input"][1]["data_url"], "data:image/png;base64,AA==")
        client.request = lambda *_: {"output": [{"type": "message", "content": json.dumps(DESCRIPTOR)}], "stats": {"total_output_tokens": 256}}
        self.assertFalse(client.infer(content, "descriptor")["ok"])

    def test_real_pair_baseline_works_on_python39(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "a.png").write_bytes(b"a")
            digest = hashlib.sha256(b"a").hexdigest()
            images = [{"id": str(i), "path": "a.png", "sha256": digest, "dhash": value}
                      for i, value in enumerate(["0000000000000000", "0000000000000003"])]
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"images": images, "pairs": [{"a": "0", "b": "1", "expected": "same_photo"}]}))
            args = argparse.Namespace(fixtures=manifest, max_images=20, base_url="http://localhost:1234/v1", model="test", timeout=1,
                max_tokens=256, structured=False, cache=root / "cache.json", output=root / "result.json", descriptors_only=False, skip_direct=True, limit_pairs=4)
            client = FakeClient()
            result = probe.run(args, client)
            self.assertEqual(result["pairs"][0]["baselines"]["dhash_hamming"], 2)
            self.assertTrue(result["pairs"][0]["baselines"]["sha256_equal"])

    def test_fixture_bytes_and_path_are_validated(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "a.png").write_bytes(b"a")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"images": [{"id": "a", "path": "a.png", "sha256": "wrong"}]}))
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                probe.load_fixtures(manifest, 20)
            manifest.write_text(json.dumps({"images": [{"id": "a", "path": "../outside.png"}]}))
            with self.assertRaisesRegex(ValueError, "escapes"):
                probe.load_fixtures(manifest, 20)

    def test_infer_records_malformed_truncated_and_http_failures(self):
        client = probe.Client("http://localhost:1234/v1", "test", 1, {"max_tokens": 10, "structured": False})
        client.request = lambda *_: {"choices": [{"message": {"content": json.dumps(DESCRIPTOR)}, "finish_reason": "length"}]}
        result = client.infer([], "descriptor")
        self.assertFalse(result["ok"])
        self.assertIn("finish normally", result["error"])
        client.request = lambda *_: {"choices": [{"message": {"content": "not-json"}, "finish_reason": "stop"}]}
        self.assertFalse(client.infer([], "descriptor")["ok"])
        self.assertEqual(client.calls, 2)


if __name__ == "__main__":
    unittest.main()
