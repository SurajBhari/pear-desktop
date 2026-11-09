"""Reproduce the vendored file from verified upstream bytes and LOCAL.patch."""

import argparse
import hashlib
from pathlib import Path
import subprocess
import tempfile
from urllib.request import urlopen

COMMIT = "47c5508bf9d994cdeab30a94673f3771f41d8aaf"
SOURCE_SHA256 = "5779b2dc6ba843a4a77e610541041e12903782df3a82c9ee10684d2d4a59b752"
LICENSE_SHA256 = "ce863258536133a2cdc1d8d24e5802f7d0b2f7bdacec5ac7781ace374c2267a5"
URL = f"https://raw.githubusercontent.com/zerodytrash/Simple-YouTube-Age-Restriction-Bypass/{COMMIT}/dist/Simple-YouTube-Age-Restriction-Bypass.user.js"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", type=Path, help="Use an already downloaded upstream source (offline).")
parser.add_argument("--check", action="store_true", help="Verify reproducibility without changing bypass.js.")
args = parser.parse_args()
directory = Path(__file__).resolve().parent
source = args.source.read_bytes() if args.source else urlopen(URL, timeout=30).read()
if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
    raise SystemExit("Upstream source SHA-256 differs from the pinned source.")
if hashlib.sha256((directory / "LICENSE").read_bytes()).hexdigest() != LICENSE_SHA256:
    raise SystemExit("Vendored LICENSE differs from the pinned upstream MIT license.")

with tempfile.TemporaryDirectory(prefix="pear-age-vendor-") as temporary:
    raw = Path(temporary) / "upstream.user.js"
    output = Path(temporary) / "bypass.js"
    raw.write_bytes(source)
    subprocess.run(
        ["patch", "-o", str(output), str(raw), str(directory / "LOCAL.patch")],
        check=True, capture_output=True,
    )
    reproduced = output.read_bytes()

if args.check:
    if reproduced != (directory / "bypass.js").read_bytes():
        raise SystemExit("Vendored bypass.js does not match the pinned source plus LOCAL.patch.")
    print("Pinned source, license, and local patch reproduce bypass.js exactly.")
else:
    (directory / "bypass.js").write_bytes(reproduced)
    print("Rebuilt bypass.js from pinned source and LOCAL.patch.")
