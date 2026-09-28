"""Stage official stable Windows Codex beside existing installations, verifying npm integrity."""
from pathlib import Path, PurePosixPath
import argparse
import base64
import hashlib
import io
import json
import tarfile
import urllib.request


def stage(output, version="0.157.1"):
    output = output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use an empty staging directory; prior evidence is never overwritten")
    output.mkdir(parents=True, exist_ok=True)
    metadata_url = f"https://registry.npmjs.org/@openai/codex/{version}-win32-x64"
    metadata = json.load(urllib.request.urlopen(metadata_url, timeout=30))
    dist = metadata["dist"]
    if not dist["tarball"].startswith("https://registry.npmjs.org/@openai/codex/-/"):
        raise ValueError("Unexpected package origin")
    archive = urllib.request.urlopen(dist["tarball"], timeout=90).read()
    expected = "sha512-" + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    if expected != dist["integrity"]:
        raise ValueError("npm integrity mismatch")
    (output / "package.tgz").write_bytes(archive)
    files = []
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != "package" or any(p in ("..", ".") or ":" in p or "\\" in p for p in parts):
                raise ValueError("Unsafe archive path")
            target = output.joinpath(*parts).resolve()
            if not target.is_relative_to(output) or member.issym() or member.islnk():
                raise ValueError("Archive escape/link refused")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                data = tar.extractfile(member).read()
                target.write_bytes(data)
                files.append({"path": str(target.relative_to(output)), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            else:
                raise ValueError("Unexpected archive entry type")
    manifest = {"version": version, "metadataUrl": metadata_url, "tarball": dist["tarball"],
                "integrity": expected, "files": files, "installed": False}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    stage(args.output)
