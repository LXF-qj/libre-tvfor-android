"""把 assets/libretv 目录打包成 assets/libretv.zip（条目名统一用正斜杠，供 Android ZipInputStream 解压）"""
import os
import sys
import zipfile

src = sys.argv[1]
dst = sys.argv[2]

if not os.path.isdir(src):
    print("source dir missing:", src)
    sys.exit(1)

count = 0
total = 0
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, src).replace("\\", "/")
            if rel.endswith("libretv.zip"):
                continue
            try:
                z.write(full, rel)
                count += 1
                total += os.path.getsize(full)
            except Exception as exc:  # noqa: BLE001
                print("skip", rel, exc)

print("files=%d raw=%.1fMB zip=%.1fMB" % (count, total / 1048576.0, os.path.getsize(dst) / 1048576.0))
