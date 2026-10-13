#!/usr/bin/env python3
"""Build public documentation with the locked Zensical version, excluding drafts."""

from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import tomllib


def build():
    root = Path(__file__).resolve().parent.parent
    config_path = root / "zensical.toml"
    config_text = config_path.read_text()
    config = tomllib.loads(config_text)
    drafts = config.get("extra", {}).get("draft_docs", [])
    if not isinstance(drafts, list):
        raise ValueError("extra.draft_docs must be a list of docs-relative file paths")
    for draft in drafts:
        path = PurePosixPath(draft)
        if (
            path.is_absolute()
            or ".." in path.parts
            or str(path) != draft
            or not (root / "docs" / draft).is_file()
        ):
            raise ValueError(f"Invalid or missing documentation draft: {draft}")

    # Keep source docs untouched. The stock builder sees only the public input
    # tree, so drafts cannot enter HTML, search, sitemap, or copied assets.
    with tempfile.TemporaryDirectory(prefix="aidlc-docs-") as directory:
        staging = Path(directory)
        shutil.copytree(root / "docs", staging / "docs")
        for draft in drafts:
            (staging / "docs" / draft).unlink()
        (staging / "zensical.toml").write_text(config_text)
        subprocess.run(
            [sys.executable, "-m", "zensical", "build", *sys.argv[1:]],
            cwd=staging,
            check=True,
        )
        # Replace generated output only after a successful build. A prior local
        # preview must not leave draft pages in the next public artifact.
        destination = root / "site"
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(staging / "site", destination)


if __name__ == "__main__":
    build()
