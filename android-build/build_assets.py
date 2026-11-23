"""构建 Android assets：从 Next standalone 产物 + public + bootstrap.js 生成 libretv.zip

注意：只按「路径前缀」排除，绝不能按目录名排除（此前 `/XD typescript` 误删了
next/dist/lib/typescript，导致运行时 Cannot find module required-packages）。
"""
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(ROOT)

STANDALONE = os.path.join(PROJ, "libretv", ".next", "standalone")
STATIC = os.path.join(PROJ, "libretv", ".next", "static")
PUBLIC = os.path.join(PROJ, "libretv", "public")
BOOTSTRAP = os.path.join(ROOT, "bootstrap.js")
OUT_DIR = os.path.join(ROOT, "assets-out")
ZIP_PATH = os.path.join(PROJ, "apk", "app", "src", "main", "assets", "libretv.zip")

# 仅这些前缀丢弃：sharp / @img 是 win32 平台的二进制，Android 上无用（约为 0 体积）
EXCLUDE_PREFIXES = (
    "node_modules/sharp/",
    "node_modules/@img/",
)

# nodejs-mobile 的 V8 未编译 ICU，不支持正则的 Unicode 属性转义（\p{...}），
# 一遇到就 SyntaxError: Invalid property name in character class。这里改写成等价 ASCII 类。
PROP_MAP = {
    "ID_Start": "A-Za-z_",
    "ID_Continue": "A-Za-z0-9_",
    "L": "A-Za-z",
    "Alpha": "A-Za-z",
    "Lu": "A-Z",
    "Ll": "a-z",
    "N": "0-9",
    "Nd": "0-9",
    "P": "!-/:-@[-`{-~",
    "S": "$+<=>^`|~",
    "Z": " \\t\\n\\r",
    "Extended_Pictographic": "\\u2190-\\u2BFF\\uD83C\\uDF00-\\uD83E\\uDDFF",
    "Emoji_Component": "\\u2190-\\u2BFF",
}


def patch_unicode_props(src):
    """把 \\p{Name} / \\\\p{Name} 换成 ASCII 等价写法，返回 (新文本, 替换次数)"""
    out = []
    i = 0
    n = len(src)
    count = 0
    in_class = False
    while i < n:
        ch = src[i]

        if ch == "\\":
            j = i
            while j < n and src[j] == "\\":
                j += 1
            run = j - i
            if j + 1 < n and src[j] in "pP" and src[j + 1] == "{":
                end = src.find("}", j + 2)
                if end != -1:
                    name = src[j + 2:end]
                    body = PROP_MAP.get(name)
                    if body is not None:
                        # 反斜杠只是 \p{...} 语法的一部分（字符串形式 \\p{...} 亦然），整体丢弃
                        out.append(body if in_class else "[" + body + "]")
                        i = end + 1
                        count += 1
                        continue
            out.append(src[i:j])
            i = j
            continue

        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        out.append(ch)
        i += 1

    return "".join(out), count


def patch_tree(root):
    files = 0
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if not name.endswith(".js"):
                continue
            full = os.path.join(dirpath, name)
            try:
                with open(full, "r", encoding="utf-8") as fh:
                    src = fh.read()
            except (UnicodeDecodeError, OSError):
                continue
            if "\\p{" not in src and "\\P{" not in src:
                continue
            new, cnt = patch_unicode_props(src)
            if cnt:
                with open(full, "w", encoding="utf-8", newline="") as fh:
                    fh.write(new)
                files += 1
                total += cnt
    return files, total


def should_skip(rel):
    return any(rel.startswith(p) for p in EXCLUDE_PREFIXES)


def copy_tree(src, dst, prefix=""):
    count = 0
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            rel = prefix + rel
            if should_skip(rel):
                continue
            target = os.path.join(dst, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(full, target)
            count += 1
    return count


def main():
    if not os.path.isdir(STANDALONE):
        print("standalone missing:", STANDALONE)
        return 1
    if not os.path.isfile(BOOTSTRAP):
        print("bootstrap missing:", BOOTSTRAP)
        return 1

    if os.path.isdir(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR, exist_ok=True)

    n1 = copy_tree(STANDALONE, OUT_DIR)
    # standalone 产物不含 .next/static，必须手动补齐，否则 JS/CSS 全部 404、页面白屏
    ns = copy_tree(STATIC, OUT_DIR, prefix=".next/static/")
    n2 = copy_tree(PUBLIC, OUT_DIR, prefix="public/")
    shutil.copy2(BOOTSTRAP, os.path.join(OUT_DIR, "bootstrap.js"))
    print("standalone=%d static=%d public=%d bootstrap=1" % (n1, ns, n2))

    pf, pc = patch_tree(OUT_DIR)
    print("unicode-prop patch: %d files, %d replacements" % (pf, pc))

    # 关键文件自检
    required = [
        "server.js",
        "bootstrap.js",
        "node_modules/next/dist/lib/typescript/required-packages.js",
        "node_modules/next/dist/build/next-config-ts/transpile-config.js",
        "node_modules/typescript/lib/typescript.js",
    ]
    for rel in required:
        if not os.path.isfile(os.path.join(OUT_DIR, rel.replace("/", os.sep))):
            print("!! MISSING", rel)
            return 1
    if not os.path.isdir(os.path.join(OUT_DIR, ".next", "static")):
        print("!! MISSING .next/static")
        return 1

    os.makedirs(os.path.dirname(ZIP_PATH), exist_ok=True)
    count = 0
    raw = 0
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dirpath, dirnames, filenames in os.walk(OUT_DIR):
            dirnames.sort()
            for name in sorted(filenames):
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, OUT_DIR).replace(os.sep, "/")
                if rel.endswith("libretv.zip"):
                    continue
                z.write(full, rel)
                count += 1
                raw += os.path.getsize(full)

    print("files=%d raw=%.1fMB zip=%.1fMB -> %s"
          % (count, raw / 1048576.0, os.path.getsize(ZIP_PATH) / 1048576.0, ZIP_PATH))
    return 0


if __name__ == "__main__":
    sys.exit(main())
