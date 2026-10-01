#!/usr/bin/env python3
"""
Builds the two self-hosted fonts of 你来的那晚 (spec §2.1, D-8, D-9) into src/assets/fonts/.

  nawan-serif-400.woff2        family "Nawan Serif"
      Noto Serif SC Regular (SIL OFL 1.1), subset to exactly the characters of DISPLAY_STRINGS plus
      「T A ？ ·」 and the space, renamed. Budget: target 24 KB, hard limit 30 KB.
  cormorant-lining-500.woff2   family "Cormorant Lining"
      Cormorant Garamond Medium 500 (SIL OFL 1.1) with lnum + tnum frozen into the default glyphs
      (opentype-feature-freezer), subset to 「0-9 . : · - space」, renamed. Target ≈6 KB.

Only the two woff2 files are committed. The sources are not.

Setup (once). Homebrew's Python refuses `pip install --user`, so a throwaway venv in .cache/ is simplest:
    python3 -m venv .cache/pyfont
    .cache/pyfont/bin/pip install fonttools brotli opentype-feature-freezer
  (anywhere else: pip install --user fonttools brotli opentype-feature-freezer)

Sources:
    mkdir -p .cache/fonts-src
    curl -L -o .cache/fonts-src/NotoSerifSC-Regular.otf \\
      https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/SubsetOTF/SC/NotoSerifSC-Regular.otf
    Cormorant Garamond 500 comes from the @fontsource/cormorant-garamond devDependency (npm install):
      node_modules/@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-normal.woff2

Usage (from the repo root):
    .cache/pyfont/bin/python tools/subset-fonts.py
    .cache/pyfont/bin/python tools/subset-fonts.py --noto PATH.otf --cormorant PATH.woff2 --out src/assets/fonts
    .cache/pyfont/bin/python tools/subset-fonts.py --check      # only verify the committed woff2 files

The display strings are the spec §2.1 list, united with DISPLAY_STRINGS from src/js/copy.js when that file
exists, so adding a display string to copy.js and re-running this script is all it takes. tools/build.mjs
fails the build when a display string uses a glyph the committed subset does not have.
"""

import argparse
import io
import os
import re
import sys

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
except ImportError:  # pragma: no cover
    sys.exit('fontTools is missing. See the setup notes at the top of tools/subset-fonts.py.')

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# spec §2.1: the only strings ever set in the display serif
SPEC_DISPLAY_STRINGS = [
    '你来的那晚',
    '这是你来的那晚',
    '两个人的星空',
    '你是哪一天来到这个世界的？',
    'TA 是哪一天出生的？',
    '用这个生日吗？',
    '那一夜',
    '关于',
]
NAWAN_EXTRA = 'TA？· '          # 「T A ？ ·」 + the space
LINING_CHARS = '0123456789.:·- '  # spec §2.1 --f-num

DEFAULT_NOTO = os.path.join(ROOT, '.cache/fonts-src/NotoSerifSC-Regular.otf')
DEFAULT_CORMORANT = os.path.join(ROOT, 'node_modules/@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-normal.woff2')
DEFAULT_OUT = os.path.join(ROOT, 'src/assets/fonts')

NAWAN_FILE = 'nawan-serif-400.woff2'
LINING_FILE = 'cormorant-lining-500.woff2'
NAWAN_TARGET, NAWAN_LIMIT = 24 * 1024, 30 * 1024
LINING_LIMIT = 10 * 1024

OFL_NOTICE = ('This Font Software is licensed under the SIL Open Font License, Version 1.1. '
              'This license is available with a FAQ at: https://openfontlicense.org')


def copy_display_strings():
    """DISPLAY_STRINGS from src/js/copy.js (array literal of quoted strings), or [] if absent."""
    path = os.path.join(ROOT, 'src/js/copy.js')
    if not os.path.exists(path):
        return []
    src = open(path, encoding='utf-8').read()
    m = re.search(r'export\s+const\s+DISPLAY_STRINGS\s*=\s*(?:Object\.freeze\(\s*)?\[([\s\S]*?)\]', src)
    if not m:
        return []
    out = []
    for q in re.finditer(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"|`((?:[^`\\]|\\.)*)`", m.group(1)):
        out.append(next(g for g in q.groups() if g is not None))
    return out


def display_chars():
    from_copy = copy_display_strings()
    strings = list(dict.fromkeys(SPEC_DISPLAY_STRINGS + from_copy))
    extra = [s for s in from_copy if s not in SPEC_DISPLAY_STRINGS]
    chars = sorted(set(''.join(strings) + NAWAN_EXTRA), key=ord)
    return strings, extra, chars


def set_name(font, name_id, value):
    name = font['name']
    name.removeNames(nameID=name_id)
    name.setName(value, name_id, 3, 1, 0x409)


def rename(font, family, ps_family, weight_name, version, description):
    """Renames a font per the OFL (a Modified Version must not keep the original family name).
    The family is the whole name browsers and canvas see ("Nawan Serif", "Cormorant Lining"); the weight
    only appears in the full and PostScript names, and the subfamily stays "Regular"."""
    ps = f'{ps_family}-{weight_name}'
    full = f'{family} {weight_name}'
    set_name(font, 1, family)
    set_name(font, 2, 'Regular')
    set_name(font, 3, f'{version};NAWAN;{ps}')
    set_name(font, 4, full)
    set_name(font, 5, f'Version {version}')
    set_name(font, 6, ps)
    set_name(font, 10, description)
    for nid in (16, 17, 18, 21, 22, 25):
        font['name'].removeNames(nameID=nid)
    if not font['name'].getName(13, 3, 1, 0x409):
        set_name(font, 13, OFL_NOTICE)
    if not font['name'].getName(14, 3, 1, 0x409):
        set_name(font, 14, 'https://openfontlicense.org')
    if 'CFF ' in font:
        cff = font['CFF '].cff
        old = cff.fontNames[0]
        top = cff.topDictIndex[0]
        cff.fontNames[0] = ps
        top.FullName = full
        top.FamilyName = family
        if hasattr(top, 'FDArray'):
            for fd in top.FDArray:
                if getattr(fd, 'FontName', None):
                    fd.FontName = fd.FontName.replace(old, ps)


def to_woff2_bytes(font):
    font.recalcTimestamp = False   # keep head.modified from the source: identical input → identical file
    font.flavor = 'woff2'
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def build_nawan(src, out_dir):
    strings, extra, chars = display_chars()
    text = ''.join(chars)
    font = TTFont(src, lazy=False)
    version = f"{font['head'].fontRevision:.3f}"
    cmap = font.getBestCmap()
    missing = [c for c in chars if ord(c) not in cmap]
    if missing:
        sys.exit(f'Noto Serif SC lacks {missing!r}')

    opts = subset.Options()
    opts.flavor = None
    # horizontal kerning for 「TA」 and the vertical forms for the vertical intro title (vertical-rl upright)
    opts.layout_features = ['kern', 'vert', 'vrt2', 'vkrn']
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opts.name_languages = [0x409]
    opts.name_legacy = False
    opts.hinting = False           # CFF hints: ignored on iOS/Android, cost bytes
    opts.desubroutinize = True     # compresses better in woff2
    opts.notdef_outline = False
    opts.recalc_timestamp = False  # reproducible output
    opts.drop_tables += ['DSIG', 'meta']
    sub = subset.Subsetter(opts)
    sub.populate(text=text)
    sub.subset(font)

    rename(font, 'Nawan Serif', 'NawanSerif', 'Regular', version,
           'Subset of Noto Serif SC Regular for the fixed display strings of 你来的那晚. '
           'Modified Version under the SIL OFL 1.1; not the original Noto Serif SC.')
    data = to_woff2_bytes(font)
    dest = os.path.join(out_dir, NAWAN_FILE)
    open(dest, 'wb').write(data)
    print(f'{NAWAN_FILE}: {len(data)} bytes ({len(data) / 1024:.1f} KB), {len(font.getGlyphOrder())} glyphs, '
          f'{len(chars)} characters: {text!r}')
    if extra:
        print(f'  + display strings from copy.js beyond the spec list: {extra!r}')
    if len(data) > NAWAN_LIMIT:
        sys.exit(f'{NAWAN_FILE} is {len(data)} bytes, over the {NAWAN_LIMIT}-byte limit (spec D-9)')
    if len(data) > NAWAN_TARGET:
        print(f'  note: over the {NAWAN_TARGET}-byte target (spec §2.1), within the {NAWAN_LIMIT}-byte limit')
    return dest


def freeze(src, features):
    """Applies the single substitutions of `features` to the cmap (opentype-feature-freezer)."""
    import logging
    logging.getLogger('opentype_feature_freezer').setLevel(logging.ERROR)  # unmapped .lf→.tf chains are expected
    try:
        from opentype_feature_freezer import RemapByOTL
        from opentype_feature_freezer.cli import parseOptions
    except ImportError:
        sys.exit('opentype-feature-freezer is missing. See the setup notes at the top of this file.')
    p = RemapByOTL(parseOptions(['-f', features, src]))
    p.openFont()
    if not p.success:
        sys.exit(f'cannot open {src}')
    p.remapByOTL()
    if not p.success:
        sys.exit('feature freezing failed')
    return p.ttx


def build_lining(src, out_dir):
    font = freeze(src, 'lnum,tnum')
    version = f"{font['head'].fontRevision:.3f}"
    cmap = font.getBestCmap()
    frozen = {c: cmap.get(ord(c)) for c in LINING_CHARS}
    if None in frozen.values():
        sys.exit(f'Cormorant lacks some of {LINING_CHARS!r}: {frozen}')

    opts = subset.Options()
    opts.flavor = None
    opts.layout_features = []      # everything needed is frozen into the cmap; no kerning between figures
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opts.name_languages = [0x409]
    opts.name_legacy = False
    opts.hinting = False
    opts.notdef_outline = False
    opts.recalc_timestamp = False
    opts.drop_tables += ['DSIG', 'STAT', 'meta', 'GSUB', 'GPOS', 'GDEF']
    sub = subset.Subsetter(opts)
    sub.populate(text=LINING_CHARS)
    sub.subset(font)

    rename(font, 'Cormorant Lining', 'CormorantLining', 'Medium', version,
           'Cormorant Garamond Medium with lining tabular figures frozen, subset to 0-9 . : · - space, '
           'for 你来的那晚. Modified Version under the SIL OFL 1.1; not the original Cormorant Garamond.')
    font['OS/2'].usWeightClass = 500
    data = to_woff2_bytes(font)
    dest = os.path.join(out_dir, LINING_FILE)
    open(dest, 'wb').write(data)
    widths = {font['hmtx'][font.getBestCmap()[ord(c)]][0] for c in '0123456789'}
    print(f'{LINING_FILE}: {len(data)} bytes ({len(data) / 1024:.1f} KB), {len(font.getGlyphOrder())} glyphs, '
          f'digit advance widths {sorted(widths)}')
    print('  frozen cmap: ' + ', '.join(f'{c!r}→{g}' for c, g in frozen.items()))
    if len(widths) != 1:
        sys.exit('digits are not tabular after freezing tnum')
    if len(data) > LINING_LIMIT:
        sys.exit(f'{LINING_FILE} is {len(data)} bytes, over {LINING_LIMIT}')
    return dest


def check(out_dir):
    """Verifies the committed files: family names, coverage, sizes."""
    ok = True
    _, _, chars = display_chars()
    for fname, family, need, limit in ((NAWAN_FILE, 'Nawan Serif', chars, NAWAN_LIMIT),
                                       (LINING_FILE, 'Cormorant Lining', LINING_CHARS, LINING_LIMIT)):
        path = os.path.join(out_dir, fname)
        if not os.path.exists(path):
            print(f'MISSING {path}')
            ok = False
            continue
        font = TTFont(path)
        cmap = font.getBestCmap()
        fam = font['name'].getDebugName(1)
        miss = [c for c in need if ord(c) not in cmap]
        size = os.path.getsize(path)
        print(f'{fname}: family {fam!r}, {size} bytes, {len(cmap)} code points, missing {miss!r}')
        ok = ok and fam == family and not miss and size <= limit
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--noto', default=DEFAULT_NOTO, help='Noto Serif SC Regular .otf (notofonts/noto-cjk)')
    ap.add_argument('--cormorant', default=DEFAULT_CORMORANT, help='Cormorant Garamond 500 (.woff2/.ttf/.otf)')
    ap.add_argument('--out', default=DEFAULT_OUT, help='output directory (default src/assets/fonts)')
    ap.add_argument('--check', action='store_true', help='only verify the existing output files')
    a = ap.parse_args()
    if a.check:
        sys.exit(0 if check(a.out) else 1)
    for p, what in ((a.noto, '--noto'), (a.cormorant, '--cormorant')):
        if not os.path.exists(p):
            sys.exit(f'{what} source not found: {p}\nSee the download notes at the top of tools/subset-fonts.py.')
    os.makedirs(a.out, exist_ok=True)
    build_nawan(a.noto, a.out)
    build_lining(a.cormorant, a.out)
    if not check(a.out):
        sys.exit(1)


if __name__ == '__main__':
    main()
