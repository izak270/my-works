#!/usr/bin/env python3
"""TTFT (time-to-first-token) latency benchmark for Groq and Cerebras.

Measures, per provider/model, over N streamed chat completions:
  - TTFT: request sent -> first content token received
  - total generation time and output tokens/sec
Reports min / median / p90 / max and prints a markdown summary table.

Requires env vars: GROQ_API_KEY, CEREBRAS_API_KEY
Uses only the Python standard library (no pip installs needed).
"""

import json
import os
import ssl
import statistics
import sys
import time
import urllib.request

RUNS = int(os.environ.get("BENCH_RUNS", "10"))
MAX_TOKENS = int(os.environ.get("BENCH_MAX_TOKENS", "256"))
PROMPT = os.environ.get(
    "BENCH_PROMPT",
    "Explain in about 150 words why the sky is blue.",
)

PROVIDERS = [
    {
        "name": "Groq",
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "key_env": "GROQ_API_KEY",
        "models": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    },
    {
        "name": "Cerebras",
        "url": "https://api.cerebras.ai/v1/chat/completions",
        "key_env": "CEREBRAS_API_KEY",
        "models": ["llama-3.3-70b", "llama3.1-8b"],
    },
]


def stream_once(url, key, model):
    """Run one streamed completion; return (ttft_s, total_s, n_tokens)."""
    body = json.dumps(
        {
            "model": model,
            "stream": True,
            "max_tokens": MAX_TOKENS,
            "messages": [{"role": "user", "content": PROMPT}],
        }
    ).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    ctx = ssl.create_default_context(
        cafile=os.environ.get("SSL_CERT_FILE") or None
    )
    t0 = time.perf_counter()
    ttft = None
    n_tokens = 0
    with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue
            delta = chunk.get("choices", [{}])[0].get("delta", {})
            if delta.get("content"):
                if ttft is None:
                    ttft = time.perf_counter() - t0
                n_tokens += 1
    total = time.perf_counter() - t0
    return ttft, total, n_tokens


def pctl(values, p):
    values = sorted(values)
    idx = min(len(values) - 1, round(p / 100 * (len(values) - 1)))
    return values[idx]


def main():
    rows = []
    for prov in PROVIDERS:
        key = os.environ.get(prov["key_env"])
        if not key:
            print(f"!! {prov['name']}: missing {prov['key_env']}, skipping", file=sys.stderr)
            continue
        for model in prov["models"]:
            ttfts, totals, rates = [], [], []
            print(f"-- {prov['name']} / {model}: {RUNS} runs", file=sys.stderr)
            for i in range(RUNS):
                try:
                    ttft, total, toks = stream_once(prov["url"], key, model)
                except Exception as e:
                    print(f"   run {i + 1}: ERROR {e}", file=sys.stderr)
                    continue
                if ttft is None:
                    continue
                ttfts.append(ttft)
                totals.append(total)
                gen_time = total - ttft
                if gen_time > 0 and toks > 1:
                    rates.append((toks - 1) / gen_time)
                print(
                    f"   run {i + 1}: ttft={ttft * 1000:.0f}ms total={total:.2f}s chunks={toks}",
                    file=sys.stderr,
                )
            if not ttfts:
                rows.append((prov["name"], model, None))
                continue
            rows.append(
                (
                    prov["name"],
                    model,
                    {
                        "runs": len(ttfts),
                        "ttft_min": min(ttfts),
                        "ttft_med": statistics.median(ttfts),
                        "ttft_p90": pctl(ttfts, 90),
                        "ttft_max": max(ttfts),
                        "total_med": statistics.median(totals),
                        "rate_med": statistics.median(rates) if rates else 0,
                    },
                )
            )

    print("\n## TTFT Benchmark Results")
    print(f"\nPrompt: `{PROMPT}` | max_tokens={MAX_TOKENS} | runs per model={RUNS}\n")
    print("| Provider | Model | Runs | TTFT min | TTFT median | TTFT p90 | TTFT max | Total (median) | Chunks/sec (median) |")
    print("|---|---|---|---|---|---|---|---|---|")
    for name, model, s in rows:
        if s is None:
            print(f"| {name} | {model} | 0 | - | - | - | - | - | all runs failed |")
            continue
        print(
            f"| {name} | {model} | {s['runs']} "
            f"| {s['ttft_min'] * 1000:.0f} ms | {s['ttft_med'] * 1000:.0f} ms "
            f"| {s['ttft_p90'] * 1000:.0f} ms | {s['ttft_max'] * 1000:.0f} ms "
            f"| {s['total_med']:.2f} s | {s['rate_med']:.0f} |"
        )


if __name__ == "__main__":
    main()
