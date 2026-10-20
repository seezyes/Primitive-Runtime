#!/usr/bin/env python3
"""Regenerate the exact source diff without copying build caches or making commits."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

BASE = Path(__file__).resolve().parent
ROOT = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=BASE, text=True).strip())

def files(tree: Path, include_new: bool):
    prefix = tree.relative_to(ROOT).as_posix() + "/"
    args = ["git", "ls-files", "-z", "--cached"]
    if include_new:
        args += ["--others", "--exclude-standard"]
    args += ["--", prefix]
    for item in sorted(set(subprocess.check_output(args, cwd=ROOT).split(b"\0"))):
        if not item:
            continue
        relative = Path(os.fsdecode(item)).relative_to(prefix)
        if any(p in {"target", "node_modules", ".git"} for p in relative.parts):
            continue
        if relative.name.startswith(".") and ".mp4." in relative.name:
            continue
        source = tree / relative
        if source.exists() or source.is_symlink():
            yield relative, source

def copy(tree: Path, destination: Path, include_new: bool):
    for relative, source in files(tree, include_new):
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target, follow_symlinks=False)

with tempfile.TemporaryDirectory(prefix="primitive-jcode-patch-") as directory:
    staging = Path(directory)
    subprocess.run(["git", "init", "-q"], cwd=staging, check=True)
    copy(BASE / "upstream", staging, False)
    subprocess.run(["git", "add", "-A"], cwd=staging, check=True)
    tree = subprocess.check_output(["git", "write-tree"], cwd=staging, text=True).strip()
    for child in staging.iterdir():
        if child.name == ".git":
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    copy(BASE / "modified", staging, True)
    subprocess.run(["git", "add", "-N", "."], cwd=staging, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", tree, "--", "."], cwd=staging)
    output = BASE / "patches" / "jcode-modifications.patch"
    output.parent.mkdir(exist_ok=True)
    output.write_bytes(patch)
    # Verify the delivered patch against exactly the sanitized reference, without
    # committing or touching either real source tree. Tree comparison covers
    # contents, additions, deletions, executable bits, and symlink targets.
    subprocess.run(["git", "add", "-A"], cwd=staging, check=True)
    expected = subprocess.check_output(["git", "write-tree"], cwd=staging, text=True).strip()
    subprocess.run(["git", "read-tree", "--reset", "-u", tree], cwd=staging, check=True)
    subprocess.run(["git", "apply", "--index", str(output)], cwd=staging, check=True)
    actual = subprocess.check_output(["git", "write-tree"], cwd=staging, text=True).strip()
    if actual != expected:
        raise RuntimeError("Generated patch does not reproduce the controlled modified source tree")
    print(f"Wrote {output.name}: {len(patch)} bytes; clean-reference apply verified ({actual})")
