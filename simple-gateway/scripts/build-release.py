#!/usr/bin/env python3
"""Build a local, reproducible function ZIP. Does not upload or deploy anything."""
import hashlib
import json
from pathlib import Path
import subprocess
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
SOURCES = ("index.js", "workflow.js", "ephemeral.js", "selftest.js",
           "recovery-selftest.js", "package.json", "package-lock.json")


def git(*args):
    return subprocess.check_output(["git", "-C", str(REPO), *args], text=True).strip()


def main():
    if git("status", "--porcelain", "--untracked-files=normal"):
        raise SystemExit("Commit source changes before packaging; refusing a dirty source tree")
    package = json.loads((ROOT / "package.json").read_text())
    lock = json.loads((ROOT / "package-lock.json").read_text())
    versions = {}
    for name in package["dependencies"]:
        actual = json.loads((ROOT / "node_modules" / name / "package.json").read_text())["version"]
        if actual != lock["packages"]["node_modules/" + name]["version"]:
            raise SystemExit("Dependency differs from lock: " + name + "; run npm ci")
        versions[name] = actual
    commit = git("rev-parse", "HEAD")
    epoch = int(git("show", "-s", "--format=%ct", "HEAD"))
    stamp = time.gmtime(max(epoch, 315532800))[:6]
    out = ROOT / "build"
    out.mkdir(exist_ok=True)
    target = out / (package["name"] + "-" + package["version"] + "-" + commit[:12] + ".zip")
    manifest = {"source_commit": commit, "version": package["version"],
                "runtime": "nodejs22", "dependencies": versions,
                "entrypoint": "index.handler", "gateway_enabled_default": False,
                "deployment_performed": False}
    files = [ROOT / path for path in SOURCES]
    files += sorted(p for p in (ROOT / "node_modules").rglob("*") if p.is_file() and not p.is_symlink())
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        def add(name, body):
            info = zipfile.ZipInfo(name, stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, body)
        for path in sorted(files):
            add(path.relative_to(ROOT).as_posix(), path.read_bytes())
        add("RELEASE-MANIFEST.json", (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode())
    sha = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix(".zip.sha256").write_text(sha + "  " + target.name + "\n")
    manifest.update(archive=target.name, sha256=sha, bytes=target.stat().st_size)
    target.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
