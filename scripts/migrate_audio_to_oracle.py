#!/usr/bin/env python3
# =============================================================================
# migrate_audio_to_oracle.py — move separated songs from Supabase Storage to
# the Oracle media server, recompressing on the way.
# =============================================================================
# Run by .github/workflows/migrate-audio-to-oracle.yml (Actions tab -> Run
# workflow). For every song folder in the Supabase bucket "separated-audio"
# that has instrumental.mp3 + vocals.mp3:
#   1. skip the upload if the media server already has both files;
#   2. otherwise download both, re-encode (instrumental 112 kbps stereo,
#      vocals 64 kbps mono — the same format new songs get), check the
#      durations still match, upload with signed PUT URLs, and confirm the
#      server holds exactly the uploaded bytes;
#   3. then delete the two MP3s from Supabase (pitch.json, lyrics and the
#      rest of the folder stay).
# A song is deleted from Supabase only after step 2 is confirmed, so a failed
# or interrupted run loses nothing; just run it again (finished songs are
# skipped). Folders with only one of the two MP3s are reported, not touched.
#
# Environment:
#   SUPABASE_SERVICE_ROLE_KEY  (required)   MEDIA_UPLOAD_SECRET (required)
#   DRY_RUN=true|false   LIMIT=<n songs, 0 = all>   DELETE_FROM_SUPABASE=true|false
# Needs: Python 3.10+, ffmpeg/ffprobe. Standard library only.
# =============================================================================

import concurrent.futures
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ukkicbsuyskkkluhpqrx.supabase.co").rstrip("/")
MEDIA_BASE = os.environ.get("MEDIA_BASE", "https://media.karaokeparty.in").rstrip("/")
BUCKET = "separated-audio"
FILES = ("instrumental.mp3", "vocals.mp3")
ENCODE = {
    "instrumental.mp3": ["-codec:a", "libmp3lame", "-b:a", "112k"],
    "vocals.mp3": ["-ac", "1", "-codec:a", "libmp3lame", "-b:a", "64k"],
}
WORKERS = 3
URL_TTL_S = 3600


def env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name, "").strip().lower()
    return default if v == "" else v in ("1", "true", "yes")


KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SECRET = os.environ.get("MEDIA_UPLOAD_SECRET", "")
DRY_RUN = env_bool("DRY_RUN", True)
DELETE = env_bool("DELETE_FROM_SUPABASE", True)
LIMIT = int(os.environ.get("LIMIT", "0") or 0)
CA_FILE = os.environ.get("MEDIA_CA_FILE")  # tests only (self-signed local server)


# ─── HTTP helpers ──────────────────────────────────────────────────────────
def _ctx(url: str):
    if CA_FILE and url.startswith(MEDIA_BASE):
        import ssl
        c = ssl.create_default_context(cafile=CA_FILE)
        return c
    return None


def http(method: str, url: str, body: bytes | None = None, headers: dict | None = None, timeout: int = 120):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=_ctx(url)) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == 2:
                return e.code, dict(e.headers), e.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == 2:
                raise RuntimeError(f"{method} {url.split('?')[0]}: {e}") from e
        time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def supa(method: str, path: str, payload=None):
    headers = {"Authorization": f"Bearer {KEY}", "apikey": KEY}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    return http(method, f"{SUPABASE_URL}/storage/v1/{path}", body, headers)


def sign(method: str, track: str, file: str) -> str:
    exp = int(time.time()) + URL_TTL_S
    sig = hmac.new(SECRET.encode(), f"{method}\n{track}/{file}\n{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{MEDIA_BASE}/api/upload/{track}/{file}?exp={exp}&sig={sig}"


# ─── Supabase listing ──────────────────────────────────────────────────────
def list_prefix(prefix: str) -> list[dict]:
    out, offset = [], 0
    while True:
        status, _, body = supa("POST", f"object/list/{BUCKET}", {
            "prefix": prefix, "limit": 1000, "offset": offset, "sortBy": {"column": "name", "order": "asc"},
        })
        if status != 200:
            raise RuntimeError(f"Supabase list '{prefix}' failed: {status} {body[:200]!r}")
        page = json.loads(body)
        out.extend(page)
        if len(page) < 1000:
            return out
        offset += 1000


def media_ready(ids: list[str]) -> set[str]:
    ready = set()
    for i in range(0, len(ids), 50):
        status, _, body = http("POST", f"{MEDIA_BASE}/api/exists", json.dumps({"ids": ids[i:i + 50]}).encode(),
                               {"Content-Type": "application/json"}, timeout=30)
        if status != 200:
            raise RuntimeError(f"media server /api/exists answered {status}")
        ready.update(json.loads(body)["ready"])
    return ready


# ─── Audio ─────────────────────────────────────────────────────────────────
def duration(path: str) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True, timeout=120)
    return float(r.stdout.strip())


def recompress(src: str, dst: str, file: str):
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vn", *ENCODE[file], dst],
                       capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {file}: {r.stderr[-300:]}")
    a, b = duration(src), duration(dst)
    if abs(a - b) > 0.5:
        raise RuntimeError(f"{file}: duration changed {a:.2f}s -> {b:.2f}s")


# ─── One song ──────────────────────────────────────────────────────────────
def migrate(track: str, on_media: bool, stored_bytes: int) -> dict:
    res = {"track": track, "before": 0, "after": 0, "uploaded": False, "deleted": False}
    if DRY_RUN:
        # No downloads in a dry run (they would count against Supabase's
        # monthly egress twice); report what is stored now.
        res["before"] = 0 if on_media else stored_bytes
        return res
    if not on_media:
        with tempfile.TemporaryDirectory() as d:
            for file in FILES:
                status, _, body = supa("GET", f"object/{BUCKET}/{track}/{file}")
                if status != 200:
                    raise RuntimeError(f"download {file} failed: {status}")
                src, dst = os.path.join(d, "in_" + file), os.path.join(d, file)
                with open(src, "wb") as f:
                    f.write(body)
                res["before"] += len(body)
                recompress(src, dst, file)
                res["after"] += os.path.getsize(dst)
            # vocals first, instrumental last (both present = song ready)
            for file in ("vocals.mp3", "instrumental.mp3"):
                data = open(os.path.join(d, file), "rb").read()
                status, _, body = http("PUT", sign("PUT", track, file), data, {"Content-Type": "audio/mpeg"}, timeout=300)
                if status != 201:
                    raise RuntimeError(f"upload {file} failed: {status} {body[:200]!r}")
                status, headers, _ = http("HEAD", f"{MEDIA_BASE}/audio/{track}/{file}", timeout=30)
                size = int({k.lower(): v for k, v in headers.items()}.get("content-length", -1))
                if status != 200 or size != len(data):
                    raise RuntimeError(f"verify {file} failed: HTTP {status}, {size} bytes on server vs {len(data)} sent")
            res["uploaded"] = True
    if DELETE:
        status, _, body = supa("DELETE", f"object/{BUCKET}", {"prefixes": [f"{track}/{f}" for f in FILES]})
        if status != 200:
            raise RuntimeError(f"Supabase delete failed: {status} {body[:200]!r}")
        res["deleted"] = True
    return res


def main() -> int:
    if not KEY or not SECRET:
        print("Missing SUPABASE_SERVICE_ROLE_KEY or MEDIA_UPLOAD_SECRET (GitHub repo secrets).")
        return 2
    mode = "DRY RUN (nothing uploaded or deleted)" if DRY_RUN else ("move" if DELETE else "copy (Supabase files kept)")
    print(f"Mode: {mode}; limit: {LIMIT or 'all'}")

    status, _, body = http("GET", f"{MEDIA_BASE}/api/health", timeout=20)
    health = json.loads(body) if status == 200 else {}
    if not health.get("ok"):
        print(f"Media server not healthy: {status} {body[:200]!r}")
        return 2
    print(f"Media server: {health['freeBytes'] / 1e9:.1f} GB free")

    folders = [e["name"] for e in list_prefix("") if e.get("id") is None]  # folders have no id
    candidates, partial, sizes = [], [], {}
    for name in folders:
        entries = {e["name"]: e for e in list_prefix(name)}
        if all(f in entries for f in FILES):
            candidates.append(name)
            sizes[name] = sum(int((entries[f].get("metadata") or {}).get("size") or 0) for f in FILES)
        elif any(f in entries for f in FILES):
            partial.append(name)
    if LIMIT:
        candidates = candidates[:LIMIT]
    print(f"{len(folders)} song folders in Supabase; {len(candidates)} with audio to move; "
          f"{len(partial)} with only one MP3 (left alone)")
    if not candidates:
        return 0
    ready = media_ready(candidates)

    done, failed = [], []
    with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
        futs = {pool.submit(migrate, t, t in ready, sizes[t]): t for t in candidates}
        for fut in concurrent.futures.as_completed(futs):
            t = futs[fut]
            try:
                r = fut.result()
                done.append(r)
                note = ("already on media" if t in ready
                        else f"{r['before'] // 1024} KB in Supabase (would move)" if DRY_RUN
                        else f"{r['before'] // 1024} KB -> {r['after'] // 1024} KB")
                print(f"  ok   {t}: {note}{'; removed from Supabase' if r['deleted'] else ''}")
            except Exception as e:
                failed.append((t, str(e)))
                print(f"  FAIL {t}: {e}")

    before = sum(r["before"] for r in done)
    after = sum(r["after"] for r in done)
    lines = [
        f"### Audio migration — {mode}",
        f"- Songs processed: **{len(done)}**, failed: **{len(failed)}**, already on media: {len(ready)}",
        (f"- Audio to move: {before / 1e6:.1f} MB in Supabase (about {before * 0.69 / 1e6:.0f} MB after recompression)"
         if DRY_RUN else
         f"- Recompressed: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB"
         + (f" ({100 * (1 - after / before):.0f}% smaller)" if before else "")),
        f"- Removed from Supabase: {sum(r['deleted'] for r in done)} songs",
    ]
    if partial:
        lines.append(f"- Folders with only one MP3 (not touched): {', '.join(partial[:30])}")
    for t, e in failed:
        lines.append(f"- FAILED `{t}`: {e}")
    summary = "\n".join(lines)
    print("\n" + summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(summary + "\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
