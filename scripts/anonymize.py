#!/usr/bin/env python3
"""Deterministic anonymizer for the Otodoke evaluation set.

Reads real RFC822 mails from ``fixtures/raw/eml/*.eml`` (git-ignored) plus
``fixtures/raw/inventory.csv`` (message_id,date,from_address,subject,source,stage)
and writes anonymized copies to::

    fixtures/anonymized/<source>/<yyyy-mm-dd>_<stage>_<shortid>.eml
    fixtures/anonymized/<source>/<yyyy-mm-dd>_<stage>_<shortid>.txt   (decoded body)
    fixtures/anonymized/<source>/<yyyy-mm-dd>_<stage>_<shortid>.json  (sidecar for the demo loader:
        file, source, stage, message_id, date, from, from_name, subject, text, html)
    fixtures/anonymized/index.csv                                    (file,source,stage,date,from,subject)

<yyyy-mm-dd> is the Date header's calendar day in Japan time.

This file is meant to be public. It contains NO personal data: every real value
(names, addresses, phone numbers, e-mail addresses, extra literals) is read from
the git-ignored mapping file ``fixtures/raw/anonymize-map.json``. The same file
caches the per-value fake order / tracking numbers so that runs are reproducible
and the same real order number always becomes the same fake one across mails
(the app merges 注文 -> 発送 -> 配達 mails by order number).

Mapping file layout (``seeds`` is written by hand once; the rest is managed here)::

    {
      "salt": "<random hex, created on first run>",
      "seeds": {
        "persons": [{
          "family": "...", "given": "...", "family_kana": "...", "given_kana": "...",
          "family_latin": "...", "given_latin": ["...", "..."],
          "fake": {"family": "山田", "given": "太郎", "family_kana": "ヤマダ",
                   "given_kana": "タロウ", "family_latin": "Yamada", "given_latin": "Taro"}
        }],
        "emails": ["..."],            # recipient addresses  -> user@example.com
        "email_locals": ["..."],      # their local parts on their own -> user
        "phones": ["0XXXXXXXXXX"],    # digits only, any written format is matched
        "addresses": [{               # every component is optional, list = spelling variants
          "postal": ["NNN-NNNN"], "pref": "..県", "city": ["..."], "town": ["..."],
          "block": ["..."], "building": ["..."]
        }],
        "primary_prefecture": "..県", # maps to 東京都 in "NAME - 県" lines
        "allowed_postal": ["NNN-NNNN"],  # public company postal codes the self-check may ignore
        "literals": {"real text": "fake text"}  # anything else to replace verbatim
      },
      "ids": {"<normalized real id>": "<normalized fake id>"},
      "prefectures": {"<real>": "<fake>"},
      "files": {"<raw message id>": "<shortid>"}
    }

Usage::

    python3 scripts/anonymize.py               # anonymize + self-check
    python3 scripts/anonymize.py --check-only  # only run the self-check on existing output

Standard library only.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import html as html_lib
import json
import os
import re
import secrets
import sys
import unicodedata
from email import message_from_bytes, policy
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import format_datetime, formataddr, getaddresses, parseaddr, parsedate_to_datetime
from datetime import timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "fixtures" / "raw"
OUT_DIR = ROOT / "fixtures" / "anonymized"
MAP_PATH = RAW_DIR / "anonymize-map.json"

FAKE_EMAIL = "user@example.com"
FAKE_EMAIL_LOCAL = "user"
FAKE_ADDRESS = {
    "postal": "100-0001",
    "pref": "東京都",
    "city": "千代田区",
    "town": "千代田",
    "block": "1-1",
    "building": "サンプルマンション101",
}
FAKE_BRANCH = "千代田"
# Fake prefectures for "NAME - 県" lines whose prefecture is not the primary one.
FAKE_OTHER_PREFS = ["大阪府", "福岡県", "北海道", "京都府", "沖縄県", "広島県", "宮城県"]
PERSONAL_MAIL_DOMAINS = (
    "gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "yahoo.co.jp",
    "ymail.ne.jp", "outlook.com", "outlook.jp", "hotmail.com", "hotmail.co.jp", "live.jp",
    "docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp", "i.softbank.jp", "nifty.com",
)
# Hosts whose URL paths carry per-recipient tokens (short links, tracking pixels,
# presigned delivery photos). Opaque path segments on them are replaced by same-shape fakes.
TOKEN_PATH_HOSTS = re.compile(
    r"(^|\.)(s3[.\-][a-z0-9.\-]*amazonaws\.com|s\.uniqlo\.com|vt\.tiktok\.com|r10\.to|"
    r"r\.rakuten\.co\.jp|2o7\.net|count\.premium-water\.net|tiktokv\.com|"
    r"ml\.kuronekoyamato\.co\.jp|shop\.tiktok\.com|web-sg\.tiktok\.com)$"
)
# CDN hosts that only serve public product images; leave their paths alone.
PUBLIC_ASSET_HOSTS = re.compile(
    r"(^|\.)(media-amazon\.com|ibyteimg\.com|tiktokcdn\.com|ttwstatic\.com|r10s\.jp|"
    r"rakuten-static\.com|thumbnail\.image\.rakuten\.co\.jp|img\.premium-water\.net|w3\.org)$"
)

BIDI = "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
INVISIBLE_RE = re.compile("[\u034f\u200b\u200c\u200d\u2060\ufeff\u00ad\u2007\u2063" + BIDI + "]")
WS = "[ \t\u3000]"  # horizontal whitespace incl. ideographic space
HYPHENS = "-－−‐‑―ー–"


# ---------------------------------------------------------------------------
# small text helpers
# ---------------------------------------------------------------------------

def to_half(s: str) -> str:
    return unicodedata.normalize("NFKC", s)


def is_full(ch: str) -> bool:
    return "！" <= ch <= "～"


def full_of(ch: str) -> str:
    return chr(ord(ch) + 0xFEE0) if "!" <= ch <= "~" else ch


def char_class(ch: str) -> str:
    """Regex class accepting half/full width spellings of one character."""
    if ch.isspace() or ch == "\u3000":
        return f"{WS}*"
    if ch in HYPHENS:
        return "[" + re.escape(HYPHENS) + "]"
    if "!" <= ch <= "~":
        alts = {ch, full_of(ch)}
        if ch.isalpha():
            alts |= {ch.swapcase(), full_of(ch.swapcase())}
        return "[" + "".join(re.escape(a) for a in sorted(alts)) + "]"
    if is_full(ch):
        return char_class(chr(ord(ch) - 0xFEE0))
    if ch in "・･":
        return "[・･]"
    return re.escape(ch)


def fuzzy(s: str, gap: str = r"[\s\u3000]*") -> str:
    """Width-insensitive pattern for ``s`` allowing whitespace (also line breaks) between chars."""
    parts = [char_class(c) for c in s if not (c.isspace() or c == "\u3000")]
    return gap.join(parts)


# full-width katakana -> half-width katakana (half-width name spellings)
_HALF_KANA: dict[str, str] = {}
for _cp in range(0xFF66, 0xFF9E):
    _HALF_KANA[unicodedata.normalize("NFKC", chr(_cp))] = chr(_cp)
for _base, _h in list(_HALF_KANA.items()):
    for _mark, _hm in (("\u3099", "ﾞ"), ("\u309a", "ﾟ")):
        _comp = unicodedata.normalize("NFC", _base + _mark)
        if _comp != _base + _mark and len(_comp) == 1:
            _HALF_KANA[_comp] = _h + _hm
_HALF_KANA["ー"] = "ｰ"


def half_kana(s: str) -> str:
    return "".join(_HALF_KANA.get(c, c) for c in s)


def keep_width(template: str, fake: str) -> str:
    """Render ``fake`` full-width if ``template`` uses full-width digits/letters."""
    if any(is_full(c) for c in template):
        return "".join(full_of(c) for c in fake)
    return fake


# ---------------------------------------------------------------------------
# MIME decoding
# ---------------------------------------------------------------------------

CHARSET_FALLBACKS = {
    "iso-2022-jp": ["iso2022_jp", "iso2022_jp_ext", "iso2022_jp_2004", "iso2022_jp_3", "iso2022jp_cp932"],
    "shift_jis": ["cp932", "shift_jis_2004", "shift_jis"],
    "shift-jis": ["cp932", "shift_jis_2004"],
    "sjis": ["cp932"],
    "x-sjis": ["cp932"],
    "cp932": ["cp932"],
    "euc-jp": ["euc_jis_2004", "euc_jp", "cp932"],
    "utf-8": ["utf-8", "cp932"],
    "us-ascii": ["utf-8"],
}


def decode_iso2022jp_cp932(data: bytes) -> str:
    """ISO-2022-JP as Microsoft/Outlook writes it (CP50220): JIS X 0208 plus the NEC / IBM
    extension rows (①, ㈱, Ⅱ ...), which Python's iso2022 codecs reject. Each JIS pair is
    mapped to Shift_JIS and decoded with cp932."""
    out = bytearray()
    mode = "ascii"
    i = 0
    while i < len(data):
        b = data[i]
        if b == 0x1B:
            seq = data[i + 1:i + 3]
            if seq in (b"$B", b"$@"):
                mode = "jis"
            elif seq == b"(I":
                mode = "kana"
            elif seq in (b"(B", b"(J"):
                mode = "ascii"
            else:
                raise UnicodeDecodeError("iso2022jp_cp932", data, i, i + 3, "unknown escape")
            i += 3
            continue
        if b in (0x0A, 0x0D):
            out.append(b)
            i += 1
            continue
        if mode == "jis":
            j1, j2 = b, data[i + 1]
            s1 = ((j1 + 1) >> 1) + (0x70 if j1 <= 0x5E else 0xB0)
            s2 = j2 + (0x1F if j1 % 2 else 0x7E)
            if j1 % 2 and s2 >= 0x7F:
                s2 += 1
            out += bytes((s1, s2))
            i += 2
        elif mode == "kana":
            out.append(b + 0x80)
            i += 1
        else:
            out.append(b)
            i += 1
    return out.decode("cp932")


def decode_bytes(data: bytes, charset: str | None) -> str:
    cs = (charset or "utf-8").lower().strip('"')
    for codec in CHARSET_FALLBACKS.get(cs, [cs, "utf-8"]):
        try:
            if codec == "iso2022jp_cp932":
                return decode_iso2022jp_cp932(data)
            return data.decode(codec)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode(CHARSET_FALLBACKS.get(cs, ["utf-8"])[0], errors="replace")


def decode_header_value(raw: str | None) -> str:
    if raw is None:
        return ""
    out = []
    for chunk, cs in decode_header(raw):
        if isinstance(chunk, bytes):
            out.append(decode_bytes(chunk, cs))
        else:
            out.append(chunk)
    text = "".join(out)
    return re.sub(r"\s*\r?\n\s+", " ", text).strip()


def read_mail(path: Path) -> dict:
    msg = message_from_bytes(path.read_bytes(), policy=policy.compat32)
    plain = html_body = None
    skipped = 0
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        disp = (part.get("Content-Disposition") or "").lower()
        if ctype not in ("text/plain", "text/html") or disp.startswith("attachment"):
            skipped += 1
            continue
        payload = part.get_payload(decode=True) or b""
        text = decode_bytes(payload, part.get_content_charset()).replace("\r\n", "\n").replace("\r", "\n")
        if ctype == "text/plain" and plain is None:
            plain = text
        elif ctype == "text/html" and html_body is None:
            html_body = text
    headers = {}
    for name in ("From", "To", "Reply-To", "Subject", "Date", "Message-ID"):
        if msg[name] is not None:
            headers[name] = decode_header_value(str(msg[name])) if name != "Date" else str(msg[name]).strip()
    return {"headers": headers, "plain": plain, "html": html_body, "skipped_parts": skipped}


class HtmlToText(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section",
             "article", "header", "footer", "hr", "dd", "dt", "ul", "ol", "blockquote", "center"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("style", "script", "head", "title"):
            self.skip += 1
        if tag in self.BLOCK:
            self.out.append("\n")
        elif tag in ("td", "th"):
            self.out.append(" ")
        elif tag == "img":
            alt = (dict(attrs).get("alt") or "").strip()
            if alt and not self.skip:
                self.out.append(f"[{alt}]")

    def handle_endtag(self, tag):
        if tag in ("style", "script", "head", "title"):
            self.skip = max(0, self.skip - 1)
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)

    def text(self) -> str:
        t = "".join(self.out).replace("\xa0", " ")
        t = INVISIBLE_RE.sub("", t)
        t = re.sub(r"[ \t\r\f\v]+", " ", t)
        t = re.sub(r" *\n *", "\n", t)
        t = re.sub(r"\n{3,}", "\n\n", t)
        return t.strip() + "\n"


def html_to_text(src: str) -> str:
    p = HtmlToText()
    p.feed(src)
    p.close()
    return p.text()


# ---------------------------------------------------------------------------
# ID discovery (order / tracking / customer numbers)
# ---------------------------------------------------------------------------

_B = f"[{BIDI}]*"
ORDER_LABEL = (r"(?:注文番号|注文受付番号|受注番号|オーダーID|注文ID|お客様番号|会員番号|受付番号|"
               r"Order\s*(?:ID|No\.?|Number))")
TRACK_LABEL = (r"(?:伝票番号|問い合わせ番号|問合せ番号|問い合せ番号|追跡番号|送り状No\.?|送り状番号|"
               r"お荷物番号|荷物番号|お問い合せ送り状No\.?|okurijoNo|Tracking\s*(?:No\.?|Number|ID))")
ID_PATTERNS = [
    # label + value on the same line or the next line
    re.compile(ORDER_LABEL + r"[^\S\n]*[:：=\]】]?[^\S\n]*(?:\n[^\S\n]*)?" + _B
               + r"(?P<v>[A-Za-z0-9][A-Za-z0-9\-]{3,40})"),
    re.compile(TRACK_LABEL + r"[^\d\n]{0,24}(?:\n[^\S\n]*)?(?:【\d+】)?" + _B
               + r"(?P<v>\d[\d\-]{8,20}\d)"),
    # formats that are unambiguous without a label
    re.compile(r"(?<![\w\-])(?P<v>(?:\d{3}|D\d{2})-\d{7}-\d{7})(?![\w\-])"),      # Amazon
    re.compile(r"(?<![\w\-])(?P<v>\d{6}-\d{8}-\d{10})(?![\w\-])"),                 # Rakuten
    re.compile(r"(?<![\w\-])(?P<v>\d{4}-\d{4}-\d{4})(?![\w\-])"),                  # Yamato / JP Post
    re.compile(r"(?<![\w\-.])(?P<v>\d{12})(?![\w\-])"),                             # 12-digit tracking
]


def norm_id(v: str) -> str:
    return re.sub(r"[\-\s]", "", to_half(v)).upper()


def looks_like_id(v: str) -> bool:
    n = norm_id(v)
    if len(n) < 5 or not re.search(r"\d", n):
        return False
    if not re.fullmatch(r"[A-Z0-9]+", n):
        return False
    if re.fullmatch(r"0[789]0\d{8}", n):  # mobile phone, handled elsewhere
        return False
    if re.fullmatch(r"\d{4}", n) or re.fullmatch(r"(19|20)\d{6}", n):  # years / plain dates
        return False
    return True


def discover_ids(text: str) -> set[str]:
    found = set()
    for pat in ID_PATTERNS:
        for m in pat.finditer(text):
            v = m.group("v").strip("-")
            if looks_like_id(v):
                found.add(norm_id(v))
    return found


class IdMapper:
    def __init__(self, salt: str, cache: dict[str, str]):
        self.salt = salt.encode()
        self.map = cache
        self.used = set(cache.values())
        self.real: set[str] = set(cache.keys())

    def _stream(self, key: str, counter: int):
        i = 0
        while True:
            digest = hmac.new(self.salt, f"{key}|{counter}|{i}".encode(), hashlib.sha256).digest()
            yield from digest
            i += 1

    def _make(self, real: str, counter: int) -> str:
        s = self._stream(real, counter)
        keep = 0
        if re.fullmatch(r"(\d{3}|D\d{2})\d{14}", real):      # Amazon: keep marketplace prefix
            keep = 3
        elif re.fullmatch(r"\d{24}", real):                    # Rakuten: keep shop id + date
            keep = 14
        else:                                                  # keep leading letters + first digit
            m = re.match(r"[A-Z]*\d?", real)
            keep = len(m.group(0)) if m else 0
        out = list(real[:keep])
        for ch in real[keep:]:
            b = next(s)
            out.append(str(b % 10) if ch.isdigit() else ch)
        return self.invalidate("".join(out))

    @staticmethod
    def invalidate(fake: str) -> str:
        """Force a 10-14 digit fake number to FAIL the mod-7 check digit (Yamato / Sagawa / JP Post).

        A fake that passes the check could belong to a real parcel, and this repo is public. It is applied
        to every such fake, whether or not the real number passed (a random fake passes 1 time in 10), and
        also to values read back from the saved map. (v + 1) % 10 is never equal to v, which is in 0..6.
        """
        if re.fullmatch(r"\d{10,14}", fake) and int(fake[:-1]) % 7 == int(fake[-1]):
            return fake[:-1] + str((int(fake[:-1]) % 7 + 1) % 10)
        return fake

    def fake_for(self, real: str) -> str:
        if real in self.map:
            # the saved map may already hold a valid-check fake: fix it in the map itself before use
            fixed = self.invalidate(self.map[real])
            if fixed != self.map[real]:
                self.map[real] = fixed
                self.used.add(fixed)
            return fixed
        counter = 0
        while True:
            fake = self._make(real, counter)
            if fake != real and fake not in self.used and fake not in self.real:
                break
            counter += 1
        self.map[real] = fake
        self.used.add(fake)
        return fake

    def register(self, real: str) -> None:
        self.real.add(real)


def render_like(occurrence: str, fake_norm: str) -> str:
    """Lay ``fake_norm`` out like ``occurrence`` (same separators, same width)."""
    out = []
    it = iter(fake_norm)
    for ch in occurrence:
        if ch in HYPHENS or ch.isspace():
            out.append(ch)
            continue
        f = next(it, "0")
        out.append(full_of(f) if is_full(ch) else f)
    return "".join(out)


TOKEN_RE = re.compile(r"(?<![A-Za-z0-9０-９Ａ-Ｚａ-ｚ])[A-Za-z0-9０-９Ａ-Ｚａ-ｚ][A-Za-z0-9０-９Ａ-Ｚａ-ｚ\-－]*[A-Za-z0-9０-９Ａ-Ｚａ-ｚ]")


# ---------------------------------------------------------------------------
# the anonymizer
# ---------------------------------------------------------------------------

class Anonymizer:
    def __init__(self, mapping: dict):
        self.mapping = mapping
        seeds = mapping["seeds"]
        self.seeds = seeds
        self.ids = IdMapper(mapping["salt"], mapping.setdefault("ids", {}))
        self.prefs = mapping.setdefault("prefectures", {})
        primary = seeds.get("primary_prefecture")
        if primary:
            self.prefs.setdefault(primary, "東京都")
        self._build()

    # -- pattern construction -------------------------------------------------
    def _build(self) -> None:
        s = self.seeds
        self.literals = [(re.compile(fuzzy(k, gap="")), v)
                         for k, v in sorted(s.get("literals", {}).items(), key=lambda kv: -len(kv[0]))]

        emails = sorted(s.get("emails", []), key=len, reverse=True)
        self.email_res = [re.compile(re.escape(e), re.I) for e in emails]
        locals_ = sorted(s.get("email_locals", []), key=len, reverse=True)
        self.local_res = [re.compile(r"(?<![\w.])" + re.escape(l) + r"(?![\w])", re.I) for l in locals_]
        doms = "|".join(re.escape(d) for d in PERSONAL_MAIL_DOMAINS)
        self.personal_email_re = re.compile(r"[A-Za-z0-9._%+\-]+@(?:" + doms + r")(?![\w.\-])", re.I)

        # persons: (pattern, replacement-builder)
        self.name_rules: list[tuple[re.Pattern, object]] = []
        lone_rules: list[tuple[re.Pattern, str]] = []
        sep = f"(?P<sep>{WS}*)"
        for p in s.get("persons", []):
            fk = p["fake"]
            pairs = [
                (p.get("family"), p.get("given"), fk["family"], fk["given"], False),
                (p.get("family_kana"), p.get("given_kana"), fk["family_kana"], fk["given_kana"], False),
            ]
            if p.get("family_kana") and p.get("given_kana"):
                pairs.append((half_kana(p["family_kana"]), half_kana(p["given_kana"]),
                              half_kana(fk["family_kana"]), half_kana(fk["given_kana"]), False))
            for gl in p.get("given_latin", []) or []:
                pairs.append((p.get("family_latin"), gl, fk["family_latin"], fk["given_latin"], True))
            for fam, giv, ffam, fgiv, latin in pairs:
                if not fam or not giv:
                    continue
                flags = re.I if latin else 0
                pat = re.compile(re.escape(fam) + sep + re.escape(giv), flags)
                self.name_rules.append((pat, (ffam, fgiv)))
                if latin:  # "Taro Yamada" order too
                    pat2 = re.compile(re.escape(giv) + r"(?P<sep>[ \u3000,]*)" + re.escape(fam), flags)
                    self.name_rules.append((pat2, (fgiv, ffam)))
            # lone parts
            if p.get("given"):
                lone_rules.append((re.compile(re.escape(p["given"])), fk["given"]))
            if p.get("family"):
                lone_rules.append((re.compile(re.escape(p["family"])), fk["family"]))
            if p.get("given_kana"):
                lone_rules.append((re.compile(re.escape(p["given_kana"])), fk["given_kana"]))
                lone_rules.append((re.compile(re.escape(half_kana(p["given_kana"]))), half_kana(fk["given_kana"])))
            if p.get("family_kana"):  # kana family names are also brand names: only before 様
                lone_rules.append((re.compile(re.escape(p["family_kana"]) + f"(?={WS}*(?:様|さま|さん))"),
                                   fk["family_kana"]))
            for gl in p.get("given_latin", []) or []:
                lone_rules.append((re.compile(r"(?<![A-Za-z])" + re.escape(gl) + r"(?![A-Za-z])", re.I),
                                   fk["given_latin"]))
        self.lone_rules = lone_rules
        self.fake_full_names = sorted({f"{p['fake']['family']}{WS}*{p['fake']['given']}"
                                       for p in s.get("persons", [])})

        # addresses: linear passes. Strong components (postal / city / building / town of 3+ chars)
        # are replaced wherever they appear; weak ones (prefecture / block / short town) only when
        # they sit next to an already replaced strong component.
        gap = r"(?:[\s\u3000]|&nbsp;|<[^>]{0,300}>){0,12}"
        self.addr_gap = gap
        self.addr_strong: list[tuple[re.Pattern, str]] = []
        self.addr_weak: list[tuple[re.Pattern, str]] = []
        self.addr_trunc = []
        self.postals = []

        def variants(a: dict, key: str) -> list[str]:
            vals = a.get(key)
            return sorted([vals] if isinstance(vals, str) else (vals or []), key=len, reverse=True)

        fa = FAKE_ADDRESS
        for a in s.get("addresses", []):
            for v in variants(a, "postal"):
                d = re.sub(r"\D", "", to_half(v))
                self.postals.append(re.compile(r"(?<![0-9０-９])" + fuzzy(d[:3]) + "[" + re.escape(HYPHENS)
                                               + r"]?" + fuzzy(d[3:]) + r"(?![0-9０-９])"))
            for v in variants(a, "building"):
                self.addr_strong.append((re.compile(fuzzy(v)), "building"))
            for v in variants(a, "city"):
                self.addr_strong.append((re.compile(fuzzy(v)), "city"))
            for v in variants(a, "town"):
                if len(re.sub(r"\s", "", v)) >= 3:
                    self.addr_strong.append((re.compile(fuzzy(v)), "town"))
                else:  # short town names only right after the (already faked) city
                    self.addr_weak.append((re.compile("(" + re.escape(fa["city"]) + gap + ")" + fuzzy(v)), "town"))
            for v in variants(a, "block"):
                self.addr_weak.append((re.compile("(" + re.escape(fa["town"]) + "|" + re.escape(fa["city"]) + ")("
                                                  + gap + ")" + fuzzy(v) + r"(?![0-9０-９])"), "block-after"))
                self.addr_weak.append((re.compile(r"(?<![0-9０-９])" + fuzzy(v) + "(" + gap + ")(?=" +
                                                  re.escape(fa["building"][:4]) + ")"), "block-before"))
            if a.get("pref"):
                pref = re.escape(a["pref"])
                self.addr_weak.append((re.compile(pref + "(" + gap + ")(?=" + re.escape(fa["city"]) + ")"), "pref"))
                self.addr_weak.append((re.compile("(" + fa["postal"] + "|" + fa["postal"].replace("-", "") + ")(" + gap
                                                  + ")" + pref), "pref-after-postal"))
            for key in ("building", "town", "city"):
                for v in variants(a, key):
                    plain = re.sub(r"[\s\u3000]", "", v)
                    for n in range(len(plain) - 1, 2, -1):
                        self.addr_trunc.append((re.compile(fuzzy(plain[:n]) + r"(?=\.\.\.|…)"),
                                                fa[key][: max(2, min(n, len(fa[key])))]))

        # phones
        self.phone_res = []
        for ph in s.get("phones", []):
            d = re.sub(r"\D", "", ph)
            body = d[1:] if d.startswith("0") else d
            seps = r"[\s\-－−ー()（）]*"
            pat = (r"(?<![0-9０-９])(?:\(?\+81\)?" + seps + r")?0?" +
                   seps.join(char_class(c) for c in body) + r"(?![0-9０-９])")
            self.phone_res.append(re.compile(pat))
        self.mobile_re = re.compile(
            r"(?<![0-9０-９\-])(?P<pre>(?:\(\+81\)|\+81[\-\s]?)?)(?P<num>(?:(?<=\+81)|(?<=\+81[\-\s])|(?<=\)))?"
            r"[0０]?[789７８９][0０](?:[\-－−\s]?[0-9０-９]{4}){2})(?![0-9０-９\-])")

    # -- individual passes ------------------------------------------------------
    def _urls(self, text: str) -> str:
        def fix(m: re.Match) -> str:
            url = m.group(0)
            tail = ""
            while url and url[-1] in ")）」』]>.,、。":
                tail = url[-1] + tail
                url = url[:-1]
            try:
                parts = urlsplit(url.replace("&amp;", "&"))
            except ValueError:
                return m.group(0)
            host = (parts.hostname or "").lower()
            path = parts.path
            if host and not PUBLIC_ASSET_HOSTS.search(host):
                segs = path.split("/")
                for i, seg in enumerate(segs):
                    opaque = (re.search(r"\d", seg) or re.search(r"[a-z].*[A-Z]|[A-Z].*[a-z]", seg))
                    if TOKEN_PATH_HOSTS.search(host) and len(seg) >= 5 and opaque and "." not in seg:
                        segs[i] = self._scramble(seg)
                    elif (len(seg) >= 20 and re.fullmatch(r"[A-Za-z0-9_\-=%]+", seg)
                          and re.search(r"\d", seg) and re.search(r"[A-Za-z]", seg)):
                        segs[i] = self._scramble(seg)
                path = "/".join(segs)
            return urlunsplit((parts.scheme, parts.netloc, path, "", "")) + tail

        text = re.sub(r"https?://[^\s\"'<>]+", fix, text)
        # relative links rendered in plain text, e.g. "(/some-path?ref_=...)"
        text = re.sub(r"(\(/[^\s()?]*)\?[^\s()]*\)", r"\1)", text)
        return text

    def _scramble(self, seg: str) -> str:
        digest = hmac.new(self.mapping["salt"].encode(), ("seg|" + seg).encode(), hashlib.sha256).digest()
        digest = digest * (len(seg) // len(digest) + 1)
        out = []
        for ch, b in zip(seg, digest):
            if ch.isdigit():
                out.append(str(b % 10))
            elif ch.islower() and ch.isascii():
                out.append(chr(ord("a") + b % 26))
            elif ch.isupper() and ch.isascii():
                out.append(chr(ord("A") + b % 26))
            else:
                out.append(ch)
        return "".join(out)

    def _emails(self, text: str) -> str:
        for r in self.email_res:
            text = r.sub(FAKE_EMAIL, text)
        text = self.personal_email_re.sub(FAKE_EMAIL, text)
        for r in self.local_res:
            text = r.sub(FAKE_EMAIL_LOCAL, text)
        return text

    def _names(self, text: str) -> str:
        for pat, (a, b) in self.name_rules:
            text = pat.sub(lambda m, a=a, b=b: a + m.group("sep") + b, text)
        for pat, rep in self.lone_rules:
            text = pat.sub(rep, text)
        return text

    def _addresses(self, text: str) -> str:
        fa = FAKE_ADDRESS
        for rx in self.postals:
            text = rx.sub(lambda m: keep_width(m.group(0), FAKE_ADDRESS["postal"] if re.search(
                "[" + re.escape(HYPHENS) + "]", m.group(0)) else FAKE_ADDRESS["postal"].replace("-", "")), text)
        for rx, key in self.addr_strong:
            text = rx.sub(lambda m, key=key: keep_width(m.group(0), fa[key]), text)
        for rx, kind in self.addr_weak:
            if kind == "town":
                text = rx.sub(lambda m: m.group(1) + fa["town"], text)
            elif kind == "block-after":
                text = rx.sub(lambda m: m.group(1) + m.group(2) + keep_width(m.group(0)[len(m.group(1) + m.group(2)):],
                                                                             fa["block"]), text)
            elif kind == "block-before":
                text = rx.sub(lambda m: keep_width(m.group(0), fa["block"]) + m.group(1), text)
            elif kind == "pref":
                text = rx.sub(lambda m: fa["pref"] + m.group(1), text)
            elif kind == "pref-after-postal":
                text = rx.sub(lambda m: m.group(1) + m.group(2) + fa["pref"], text)
        for rx, fake in self.addr_trunc:
            text = rx.sub(fake, text)
        # "山田太郎 - (prefecture)" (Amazon ship-to line): map the prefecture
        if self.fake_full_names:
            names = "|".join(self.fake_full_names)
            pat = re.compile(r"((?:" + names + r")(?:\s|&nbsp;|<[^>]{0,300}>)*[\-－‐](?:\s|&nbsp;|<[^>]{0,300}>)*)"
                             r"(?P<pref>[^\s<>&]{2,3}?[都道府県])")
            text = pat.sub(lambda m: m.group(1) + self._pref(m.group("pref")), text)
        return text

    def _pref(self, real: str) -> str:
        if real not in self.prefs:
            used = set(self.prefs.values())
            self.prefs[real] = next((p for p in FAKE_OTHER_PREFS if p not in used), "東京都")
        return self.prefs[real]

    def _phones(self, text: str) -> str:
        def zero(m: re.Match) -> str:
            s = m.group(0)
            # rewrite: keep "+81"/"(+81)" prefix, then 0?90 + zeros
            pre = re.match(r"\(?\+81\)?[\s\-－−ー()（）]*", s)
            p = pre.group(0) if pre else ""
            rest = s[len(p):]
            res, n = [], 0
            digits_total = sum(c.isdigit() for c in rest)
            has_zero = digits_total == 11
            for ch in rest:
                if ch.isdigit():
                    idx = n if has_zero else n + 1
                    fake = "090"[idx] if idx < 3 else "0"
                    res.append(full_of(fake) if is_full(ch) else fake)
                    n += 1
                else:
                    res.append(ch)
            return p + "".join(res)
        for r in self.phone_res:
            text = r.sub(zero, text)
        text = self.mobile_re.sub(zero, text)
        return text

    def _branches(self, text: str) -> str:
        generic = ("配達担当", "配達", "担当", "最寄", "最寄り", "最寄りの", "各", "当", "同", "○○", "〇〇", "配達郵便局")
        def rep(m: re.Match) -> str:
            name = m.group(1)
            if name in generic or name.endswith("担当") or name.endswith("配達") or "○" in name:
                return m.group(0)
            return FAKE_BRANCH + m.group(2)
        text = re.sub(r"(?<![一-龥ァ-ヶー])([一-龥ァ-ヶー○〇]{1,8}?)(営業所|郵便局)", rep, text)
        text = re.sub(r"(営業所番号[：:]\s*)(\d+)", lambda m: m.group(1) + "0" * len(m.group(2)), text)
        return text

    def _ids(self, text: str) -> str:
        def rep(m: re.Match) -> str:
            tok = m.group(0)
            key = norm_id(tok)
            if key in self.ids.map:
                return render_like(tok, self.ids.map[key])
            lead = re.match(r"[A-Za-zＡ-Ｚａ-ｚ]+", tok)
            if lead:
                tail = tok[lead.end():]
                if norm_id(tail) in self.ids.map:
                    return lead.group(0) + render_like(tail, self.ids.map[norm_id(tail)])
            return tok
        return TOKEN_RE.sub(rep, text)

    def _tokens(self, text: str) -> str:
        """Long opaque alphanumeric tokens outside URLs (log ids, tracking hashes)."""
        def rep(m: re.Match) -> str:
            tok = m.group(0)
            if re.search(r"\d", tok) and re.search(r"[A-Za-z]", tok):
                return self._scramble(tok)
            return tok
        return re.sub(r"(?<![A-Za-z0-9/%=_\-.])[A-Za-z0-9]{24,}(?![A-Za-z0-9/%=_\-.])", rep, text)

    def _cards(self, text: str) -> str:
        # one-time codes such as a delivery-box PIN (宅配ボックス 暗証番号)
        text = re.sub(r"((?:暗証番号|認証番号|確認コード|ワンタイムパスワード|PIN)(?:\s|<[^>]{0,300}>|&nbsp;|[:：])*)([0-9０-９]{3,8})",
                      lambda m: m.group(1) + keep_width(m.group(2), "0" * len(m.group(2))), text)
        text = re.sub(r"((?:下|末尾)[4４]桁|末尾)([^0-9０-９\n]{0,8})([0-9０-９]{4})",
                      lambda m: m.group(1) + m.group(2) + keep_width(m.group(3), "0000"), text)
        text = re.sub(r"((?:[*＊xX×]{4}[\-\s]?){1,3})([0-9]{4})(?![0-9])", lambda m: m.group(1) + "0000", text)
        return text

    def _literals(self, text: str) -> str:
        for rx, rep in self.literals:
            text = rx.sub(rep, text)
        return text

    # -- public -----------------------------------------------------------------
    def text(self, s: str | None) -> str | None:
        if s is None:
            return None
        s = self._urls(s)
        s = self._literals(s)
        s = self._emails(s)
        s = self._names(s)
        s = self._addresses(s)
        s = self._phones(s)
        s = self._branches(s)
        s = self._ids(s)
        s = self._tokens(s)
        s = self._cards(s)
        return s

    def address_header(self, value: str) -> str:
        pairs = getaddresses([value])
        out = []
        for name, addr in pairs:
            name = self.text(name) or ""
            addr = self.text(addr) or ""
            out.append(formataddr((name, addr)) if name else addr)
        return ", ".join(out)


# ---------------------------------------------------------------------------
# writing
# ---------------------------------------------------------------------------

def choose_cte(text: str) -> str:
    return "8bit" if all(len(line.encode("utf-8")) <= 900 for line in text.split("\n")) else "quoted-printable"


def build_eml(headers: dict, plain: str | None, html_body: str | None, boundary: str) -> bytes:
    msg = EmailMessage(policy=policy.default)
    for name in ("From", "To", "Reply-To", "Subject", "Date", "Message-ID"):
        if headers.get(name):
            msg[name] = headers[name]
    msg["X-Otodoke-Anonymized"] = "scripts/anonymize.py"
    if plain is not None:
        msg.set_content(plain, subtype="plain", charset="utf-8", cte=choose_cte(plain))
        if html_body is not None:
            msg.add_alternative(html_body, subtype="html", charset="utf-8", cte=choose_cte(html_body))
    elif html_body is not None:
        msg.set_content(html_body, subtype="html", charset="utf-8", cte=choose_cte(html_body))
    else:
        msg.set_content("", subtype="plain", charset="utf-8")
    if msg.is_multipart():
        msg.set_boundary(boundary)  # deterministic output: same input -> byte-identical file
    return msg.as_bytes(policy=policy.default.clone(max_line_length=998))


def jst_date(date_header: str | None) -> str | None:
    """Calendar date of the Date header in Japan time (Amazon / Yamato send in UTC)."""
    if not date_header:
        return None
    try:
        dt = parsedate_to_datetime(date_header)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone(timedelta(hours=9))).date().isoformat()


def iso_date(date_header: str | None) -> str | None:
    """Date header as ISO 8601 keeping its own UTC offset."""
    if not date_header:
        return None
    try:
        dt = parsedate_to_datetime(date_header)
    except (TypeError, ValueError):
        return None
    return dt.isoformat() if dt.tzinfo else dt.replace(tzinfo=timezone.utc).isoformat()


def demo_message_id(salt: str, out_name: str) -> str:
    """Made-up Message-ID built from the output file name only, never from the real value."""
    h = hmac.new(salt.encode(), ("msgid|" + out_name).encode(), hashlib.sha256).hexdigest()[:12]
    return f"<demo-{h}@example.invalid>"


def round_date_to_minute(date_header: str) -> str:
    """Date header with the seconds set to 00 (the exact send time can identify a real order)."""
    try:
        dt = parsedate_to_datetime(date_header)
    except (TypeError, ValueError):
        return date_header
    return format_datetime(dt.replace(second=0, microsecond=0))


def short_id(salt: str, mid: str) -> str:
    return hmac.new(salt.encode(), ("file|" + mid).encode(), hashlib.sha256).hexdigest()[:8]


def load_mapping() -> dict:
    if not MAP_PATH.exists():
        sys.exit(f"[anonymize] mapping file not found: {MAP_PATH.relative_to(ROOT)}\n"
                 "Create it with a 'seeds' section (see the docstring of this script).")
    mapping = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    if not mapping.get("seeds", {}).get("persons"):
        sys.exit("[anonymize] mapping file has no seeds.persons — refusing to run without seeds.")
    if not mapping.get("salt"):
        mapping["salt"] = secrets.token_hex(16)
    mapping.setdefault("ids", {})
    mapping.setdefault("files", {})
    return mapping


def save_mapping(mapping: dict) -> None:
    MAP_PATH.write_text(json.dumps(mapping, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
                        encoding="utf-8")


def run(args) -> int:
    mapping = load_mapping()
    inventory = {}
    with open(RAW_DIR / "inventory.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            inventory[row["message_id"]] = row

    eml_paths = sorted((RAW_DIR / "eml").glob("*.eml"))
    mails = {}
    for p in eml_paths:
        mid = p.stem
        if mid not in inventory:
            print(f"[anonymize] WARN {p.name} not in inventory.csv, skipped")
            continue
        mails[mid] = read_mail(p)

    anon = Anonymizer(mapping)
    # pass 1: discover every order / tracking / customer number across the whole set
    discovered = set()
    for m in mails.values():
        blob = "\n".join(filter(None, [m["headers"].get("Subject"), m["plain"],
                                       html_to_text(m["html"]) if m["html"] else None]))
        discovered |= discover_ids(blob)
    for real in sorted(discovered):
        anon.ids.register(real)
    for real in sorted(discovered):
        anon.ids.fake_for(real)

    # pass 2: write anonymized files
    written = {}
    index_rows = []
    for mid, m in sorted(mails.items(), key=lambda kv: (inventory[kv[0]]["date"], kv[0])):
        row = inventory[mid]
        sid = mapping["files"].get(mid) or short_id(mapping["salt"], mid)
        mapping["files"][mid] = sid
        day = jst_date(m["headers"].get("Date")) or row["date"]
        rel = Path(row["source"]) / f"{day}_{row['stage']}_{sid}"
        headers = {}
        for k, v in m["headers"].items():
            if k in ("From", "To", "Reply-To"):
                headers[k] = anon.address_header(v)
            elif k == "Message-ID":
                # whole value becomes <demo-<hash>@example.invalid>; the hash comes from the OUTPUT file
                # name, so the real Message-ID is not recoverable from it
                headers[k] = demo_message_id(mapping["salt"], rel.as_posix())
            elif k == "Date":
                headers[k] = round_date_to_minute(v)
            else:
                headers[k] = anon.text(v)
        plain = anon.text(m["plain"])
        html_body = anon.text(m["html"])
        if plain is not None and plain.strip():
            body_text = plain if plain.endswith("\n") else plain + "\n"
        elif html_body is not None:
            body_text = html_to_text(html_body)
        else:
            body_text = ""
        out_eml = OUT_DIR / rel.with_suffix(".eml")
        out_txt = OUT_DIR / rel.with_suffix(".txt")
        out_eml.parent.mkdir(parents=True, exist_ok=True)
        out_eml.write_bytes(build_eml(headers, plain, html_body, f"=_otodoke_{sid}"))
        out_txt.write_text(body_text, encoding="utf-8")
        from_name, from_addr = parseaddr(headers.get("From", ""))
        sidecar = {
            "file": rel.with_suffix(".eml").as_posix(),
            "source": row["source"],
            "stage": row["stage"],
            "message_id": headers.get("Message-ID") or None,
            "date": iso_date(headers.get("Date")),
            "from": from_addr.lower(),
            "from_name": decode_header_value(from_name) or None,
            "subject": headers.get("Subject", ""),
            "text": plain,
            "html": html_body,
        }
        out_eml.with_suffix(".json").write_text(
            json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        written[str(rel.with_suffix(".eml"))] = row["source"]
        index_rows.append({"file": rel.with_suffix(".eml").as_posix(), "source": row["source"],
                           "stage": row["stage"], "date": day, "from": from_addr.lower(),
                           "subject": headers.get("Subject", "")})

    # remove stale outputs from previous runs (only .eml/.txt we own)
    keep = set()
    for r in written:
        keep.add(OUT_DIR / r)
        keep.add((OUT_DIR / r).with_suffix(".txt"))
        keep.add((OUT_DIR / r).with_suffix(".json"))
    for p in OUT_DIR.glob("*/*"):
        if p.suffix in (".eml", ".txt", ".json") and p not in keep:
            p.unlink()

    with open(OUT_DIR / "index.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["file", "source", "stage", "date", "from", "subject"])
        w.writeheader()
        w.writerows(index_rows)

    save_mapping(mapping)
    counts: dict[str, int] = {}
    for src in written.values():
        counts[src] = counts.get(src, 0) + 1
    print(f"[anonymize] wrote {len(written)} mails: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    print(f"[anonymize] id map: {len(mapping['ids'])} values")
    return self_check(mapping)


# ---------------------------------------------------------------------------
# self-check
# ---------------------------------------------------------------------------

def mask(s: str) -> str:
    return s[:1] + "*" * max(0, len(s) - 2) + s[-1:] if len(s) > 2 else "**"


def self_check(mapping: dict) -> int:
    seeds = mapping["seeds"]
    checks: list[tuple[str, re.Pattern]] = []
    for p in seeds.get("persons", []):
        if p.get("family") and p.get("given"):
            checks.append(("name", re.compile(fuzzy(p["family"]) + r"[\s\u3000]*" + fuzzy(p["given"]))))
        for k in ("family", "given", "given_kana"):
            if p.get(k):
                checks.append((f"name:{k}", re.compile(re.escape(p[k]))))
                checks.append((f"name:{k}:half", re.compile(re.escape(half_kana(p[k])))))
        if p.get("family_kana"):
            checks.append(("name:family_kana", re.compile(re.escape(p["family_kana"]) + f"{WS}*(?:様|さま|さん|{WS}*" +
                                                        re.escape(p.get("given_kana") or "#") + ")")))
        for gl in p.get("given_latin", []) or []:
            checks.append(("name:latin", re.compile(r"(?<![A-Za-z])" + re.escape(gl) + r"(?![A-Za-z])", re.I)))
    for e in seeds.get("emails", []):
        checks.append(("email", re.compile(re.escape(e), re.I)))
    for l in seeds.get("email_locals", []):
        checks.append(("email-local", re.compile(re.escape(l), re.I)))
    doms = "|".join(re.escape(d) for d in PERSONAL_MAIL_DOMAINS)
    checks.append(("personal-email", re.compile(r"[A-Za-z0-9._%+\-]+@(?:" + doms + r")\b", re.I)))
    for ph in seeds.get("phones", []):
        d = re.sub(r"\D", "", ph)
        checks.append(("phone", re.compile(r"[\s\-－−ー()（）]*".join(char_class(c) for c in d[1:]))))
    checks.append(("one-time-code", re.compile(r"暗証番号[\s:：]*(?![0０]{3,8}(?![0-9０-９]))[0-9０-９]{3,8}")))
    checks.append(("mobile", re.compile(r"(?<![0-9０-９])0[789]0[\-－\s]?(?!0000)\d{4}[\-－\s]?\d{4}(?![0-9])")))
    allowed_postal = {re.sub(r"\D", "", to_half(x)) for x in seeds.get("allowed_postal", [])}
    allowed_postal.add(re.sub(r"\D", "", FAKE_ADDRESS["postal"]))
    postal_re = re.compile(r"〒[ \u3000]*([0-9０-９]{3}[" + re.escape(HYPHENS) + r"]?[0-9０-９]{4})")
    for a in seeds.get("addresses", []):
        for key in ("postal", "city", "town", "building"):
            vals = a.get(key)
            for v in ([vals] if isinstance(vals, str) else vals or []):
                if key == "postal":
                    d = re.sub(r"\D", "", to_half(v))
                    checks.append(("postal", re.compile(fuzzy(d[:3]) + "[" + re.escape(HYPHENS) + "]?" + fuzzy(d[3:]))))
                else:
                    plain = re.sub(r"[\s\u3000]", "", v)
                    if len(plain) < 3:  # e.g. a one-character town name: too generic to grep for
                        continue
                    checks.append((f"address:{key}", re.compile(fuzzy(plain))))
                    # distinctive fragments (first 4 chars) also must not survive
                    if len(plain) >= 6 and not re.fullmatch(r"[\d\-]+", plain[:4]):
                        checks.append((f"address:{key}-fragment", re.compile(fuzzy(plain[:4]))))
    for k in seeds.get("literals", {}):
        checks.append(("literal", re.compile(fuzzy(k, gap=""))))
    long_ids = [k for k in mapping.get("ids", {}) if len(k) >= 8]
    short_ids = {k for k in mapping.get("ids", {}) if len(k) < 8}
    long_ids_re = re.compile("|".join(re.escape(k) for k in sorted(long_ids, key=len, reverse=True))) if long_ids else None
    fake_names = [p["fake"]["family"] + p["fake"]["given"] for p in seeds.get("persons", [])]
    pref_after_name = re.compile(r"(?:" + "|".join(re.escape(n) for n in fake_names) + r")\s*-\s*("
                                 + "|".join(re.escape(x) for x in mapping.get("prefectures", {})) + r")") \
        if mapping.get("prefectures") and fake_names else None

    failures: list[str] = []
    warnings: dict[str, int] = {}
    files = (sorted(OUT_DIR.glob("*/*.eml")) + sorted(OUT_DIR.glob("*/*.txt")) + sorted(OUT_DIR.glob("*/*.json"))
             + [OUT_DIR / "index.csv"])
    for path in files:
        raw = path.read_bytes()
        views = [raw.decode("utf-8", errors="replace")]
        if path.suffix == ".eml":
            msg = message_from_bytes(raw, policy=policy.default)
            views.append("\n".join(f"{k}: {v}" for k, v in msg.items()))
            for part in msg.walk():
                if part.is_multipart():
                    continue
                body = part.get_content()
                views.append(body)
                if part.get_content_type() == "text/html":
                    views.append(html_to_text(body))
                    views.append(html_lib.unescape(body))
        if path.suffix == ".json":
            data = json.loads(raw.decode("utf-8"))
            views.append("\n".join(str(v) for v in data.values() if v is not None))
            if data.get("html"):
                views.append(html_to_text(data["html"]))
                views.append(html_lib.unescape(data["html"]))
        rel = path.relative_to(OUT_DIR)
        for view in views:
            for kind, rx in checks:
                m = rx.search(view)
                if m:
                    failures.append(f"{rel}: {kind} -> {mask(m.group(0))}")
            for m in postal_re.finditer(view):
                if re.sub(r"\D", "", to_half(m.group(1))) not in allowed_postal:
                    failures.append(f"{rel}: postal(generic) -> {mask(m.group(1))}")
            flat = re.sub(r"[\-－\s]", "", to_half(view)).upper()
            if long_ids_re:
                m = long_ids_re.search(flat)
                if m:
                    failures.append(f"{rel}: real-id -> {mask(m.group(0))}")
            for tok in TOKEN_RE.findall(view):
                if norm_id(tok) in short_ids:
                    failures.append(f"{rel}: real-id(short) -> {mask(tok)}")
            if pref_after_name:
                m = pref_after_name.search(view)
                if m and mapping["prefectures"].get(m.group(1)) != m.group(1):
                    failures.append(f"{rel}: real prefecture after name -> {m.group(1)[:1]}*")
            for m in re.finditer(r"https?://[^\s\"'<>]+\?[^\s\"'<>]+", view):
                warnings["url-with-query"] = warnings.get("url-with-query", 0) + 1
    failures = sorted(set(failures))
    print(f"[self-check] scanned {len(files)} files with {len(checks)} seed patterns + id map")
    for k, v in warnings.items():
        print(f"[self-check] WARN {k}: {v}")
    if failures:
        print(f"[self-check] FAIL: {len(failures)} leak(s)")
        for f in failures[:200]:
            print("   ", f)
        return 1
    print("[self-check] PASS: no real name / postal code / phone / e-mail / address / id found")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check-only", action="store_true", help="only run the self-check")
    args = ap.parse_args()
    if args.check_only:
        return self_check(load_mapping())
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
