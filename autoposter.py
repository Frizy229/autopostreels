#!/usr/bin/env python3
"""Instagram Reels (и TikTok) autoposter.

В queue/ лежат папки: одна папка = одно длинное видео = рилсы на один день.
В папке: 01.mp4 + 01.txt (описание) + 01.jpg (обложка), 02.mp4 ... Каждый день берётся
следующая папка, её рилсы публикуются равномерно с day_start до day_end, затем папка
переезжает в posted/.

Команды:
  python autoposter.py post            опубликовать рилсы, время которых подошло (запускать раз в час)
  python autoposter.py post --dry-run  показать, что будет опубликовано, без публикации
  python autoposter.py check           проверить токен и аккаунт
  python autoposter.py refresh-token   продлить токен (и сохранить в GitHub Secret, если задан GH_PAT)

Переменные окружения (секреты):
  IG_TOKEN     токен доступа Instagram (обязателен)
  IG_USER_ID   ID аккаунта Instagram (обязателен для post/check)
  IG_API_HOST  необязательно: graph.instagram.com или graph.facebook.com
               (по умолчанию определяется по токену: IGAA... -> instagram, EAA... -> facebook)
  FB_APP_ID / FB_APP_SECRET  только для продления токена типа EAA (Facebook Login)
  GH_PAT       необязательно: GitHub токен с правом Secrets: write, чтобы сохранять продлённый токен
  TT_CLIENT_KEY / TT_CLIENT_SECRET  ключи приложения TikTok (только если в config.json есть аккаунт TikTok)

TikTok (аккаунт в config.json с "platform": "tiktok"):
  python autoposter.py tiktok-url ИМЯ                    ссылка для входа в TikTok
  python autoposter.py tiktok-connect ИМЯ --code АДРЕС   обменять код на токен и сохранить его в секрет
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import sys
import time
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests

ROOT = pathlib.Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
STATE_PATH = ROOT / "state.json"

DEFAULT_CONFIG = {
    "queue_dir": "queue",            # здесь лежат папки: одна папка = рилсы на один день
    "posted_dir": "posted",          # сюда переносятся полностью опубликованные папки
    "timezone": "Europe/Moscow",
    "day_start": "10:00",            # первый рилс дня
    "day_end": "22:00",              # последний рилс дня; остальные равномерно между ними
    "max_posts_per_run": 3,          # защита: не больше стольких публикаций за один запуск
    "caption_template": "{text}\n\n{hashtags}",
    "hashtags": "",                  # хэштеги, которые добавляются к каждому ролику
    "default_text": "",              # подпись, если у видео нет .txt
    "cover": "auto",                 # auto | github_raw | temp_link | frame
    "thumb_offset_ms": 1000,         # кадр для обложки (мс), если нет .jpg
    "share_to_feed": True,           # показывать рилс в сетке профиля
    "accounts": [],                  # список аккаунтов, см. README; пусто = один аккаунт (IG_TOKEN, IG_USER_ID)
    "api_version": "v23.0",
    "tiktok_redirect_uri": "",       # адрес возврата после входа в TikTok (как в настройках приложения TikTok)
    "tiktok_client_key": "",         # Client key приложения TikTok (не секрет, виден в ссылке входа)
    "status_timeout_sec": 900,
    # Раздельные очереди по соцсетям (виджет: разделы Instagram и TikTok). queue/ остаётся общей для всех.
    "lanes": {
        "instagram": {"queue_dir": "queue-instagram", "posted_dir": "posted-instagram"},
        "tiktok": {"queue_dir": "queue-tiktok", "posted_dir": "posted-tiktok"},
    },
    "paused": [],                    # соцсети на паузе: ["instagram"], ["tiktok"]
    # Тексты, которые сами прикрепляются при заливе (их же можно задать на папку файлом texts.json):
    # caption: подпись, если у видео нет своей; footer: строка в конец каждой подписи;
    # hashtags: хэштеги (вместо общих "hashtags"); comment: первый комментарий (только Instagram);
    # use_pinned_comment: брать комментарий из раздела PINNED COMMENT: в .txt
    "texts": {"instagram": {}, "tiktok": {}},
}

NETWORKS = ("instagram", "tiktok")
TEXT_KEYS = ("caption", "footer", "hashtags", "comment", "use_pinned_comment")

IG_CAPTION_LIMIT = 2200
IG_HASHTAG_LIMIT = 30


# ---------------------------------------------------------------- utils

def log(msg: str) -> None:
    print(f"[{dt.datetime.now(dt.timezone.utc):%Y-%m-%d %H:%M:%S}Z] {msg}", flush=True)


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    return cfg


def load_state() -> dict:
    if STATE_PATH.exists():
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    else:
        state = {}
    state.setdefault("posted", {})
    state.setdefault("skipped", {})
    return state


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def env(name: str, required: bool = True) -> str:
    val = os.environ.get(name, "").strip()
    if required and not val:
        sys.exit(f"Ошибка: не задана переменная окружения {name} (добавьте её в GitHub Secrets).")
    return val


def mask(secret: str) -> None:
    """Скрыть значение в логах GitHub Actions."""
    if secret and os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{secret}", flush=True)


# ---------------------------------------------------------------- accounts

ACTIVE_ACCOUNTS: list[dict] = [{"name": "main", "token_env": "IG_TOKEN", "user_id_env": "IG_USER_ID", "primary": True}]


def secret(name: str) -> str:
    """Секрет из переменной окружения или из ALL_SECRETS (JSON со всеми секретами репозитория)."""
    val = os.environ.get(name, "").strip()
    if val:
        return val
    try:
        return str(json.loads(os.environ.get("ALL_SECRETS") or "{}").get(name, "")).strip()
    except ValueError:
        return ""


def configure_accounts(cfg: dict) -> list[dict]:
    """Какие аккаунты сейчас работают: первый обязателен, остальные включаются, когда задан их токен."""
    global ACTIVE_ACCOUNTS
    raw = cfg.get("accounts") or []
    if not raw:
        # старый формат: без списка работает один аккаунт IG_TOKEN. Новая копия (например, у друга) без токена: аккаунтов нет
        raw = [{"name": "main"}] if secret("IG_TOKEN") else []
        if not raw:
            log("В config.json нет аккаунтов: добавьте их в виджете (кнопка «+» у аккаунтов).")
    out = []
    for i, a in enumerate(raw):
        platform = (a.get("platform") or "instagram").lower()
        acc = {"name": a.get("name") or f"acc{i + 1}",
               "token_env": a.get("token_env") or ("IG_TOKEN" if i == 0 else f"IG_TOKEN_{i + 1}"),
               "user_id_env": a.get("user_id_env") or ("IG_USER_ID" if i == 0 else f"IG_USER_ID_{i + 1}"),
               "user_id": str(a.get("user_id") or ""),
               "platform": platform,
               "primary": i == 0}
        if platform == "tiktok":
            acc.update(token_env=a.get("token_env") or tt_secret_name(acc["name"]),
                       mode=(a.get("mode") or "inbox").lower(),
                       privacy=a.get("privacy") or "PUBLIC_TO_EVERYONE",
                       client_key_env=a.get("client_key_env") or "TT_CLIENT_KEY",
                       client_secret_env=a.get("client_secret_env") or "TT_CLIENT_SECRET",
                       disable_comment=bool(a.get("disable_comment", False)),
                       disable_duet=bool(a.get("disable_duet", False)),
                       disable_stitch=bool(a.get("disable_stitch", False)),
                       is_aigc=bool(a.get("is_aigc", False)))
        if not acc["primary"] and not secret(acc["token_env"]):
            log(f"Аккаунт «{acc['name']}»: нет секрета {acc['token_env']}, пропускаю.")
            continue
        out.append(acc)
    ACTIVE_ACCOUNTS = out
    return out


def secret_suffix(name: str) -> str:
    """Часть имени секрета из ника: в именах секретов GitHub можно только латиницу, цифры и _."""
    return re.sub(r"[^A-Z0-9_]", "_", str(name).upper()).strip("_") or "ACC"


def tt_secret_name(name: str) -> str:
    return f"TT_TOKEN_{secret_suffix(name)}"


def note_token(state: dict, acc: dict, ok: bool, error: str = "", expires: str = "") -> bool:
    """Состояние токена аккаунта для виджета: state['tokens'][имя]. Меняем запись только когда что-то изменилось
    (иначе каждый запуск давал бы коммит). Возвращает True, если запись изменилась."""
    tokens = state.setdefault("tokens", {})
    old = tokens.get(acc["name"]) or {}
    row = {"ok": ok}
    if error:
        row["error"] = str(error)[:300]
    if expires:
        row["expires"] = expires
    row["since"] = old.get("since") if old.get("ok") == ok and old.get("since") else dt.date.today().isoformat()
    if row == old:
        return False
    tokens[acc["name"]] = row
    return True


def acc_posted(state: dict, acc: dict) -> dict:
    """Опубликованные рилсы аккаунта. Для первого аккаунта это state['posted'] (как раньше)."""
    if acc["primary"]:
        return state["posted"]
    return state.setdefault("posted_acc", {}).setdefault(acc["name"], {})


def acc_key(acc: dict, item_id: str) -> str:
    return item_id if acc["primary"] else f"{acc['name']}|{item_id}"


def acc_done(state: dict, acc: dict, item_id: str) -> bool:
    return item_id in acc_posted(state, acc) or acc_key(acc, item_id) in state["skipped"]


def make_ig(acc: dict, cfg: dict) -> "Instagram | TikTok":
    token = secret(acc["token_env"])
    if not token:
        sys.exit(f"Ошибка: не задан секрет {acc['token_env']} (аккаунт «{acc['name']}»).")
    mask(token)
    if acc.get("platform") == "tiktok":
        return TikTok(acc, token, cfg)
    return Instagram(token, secret(acc["user_id_env"]) or acc.get("user_id", ""), cfg)


def save_github_secret(name: str, value: str) -> bool:
    """Записать секрет репозитория через gh (нужен GH_PAT с правом Secrets: Read and write)."""
    pat, repo = secret("GH_PAT"), os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not (pat and repo):
        log(f"GH_PAT не задан: не могу сохранить секрет {name}.")
        return False
    res = subprocess.run(["gh", "secret", "set", name, "--repo", repo, "--body", value],
                         env={**os.environ, "GH_TOKEN": pat}, capture_output=True, text=True)
    if res.returncode != 0:
        log(f"Не удалось сохранить секрет {name}: {res.stderr.strip()[:300]}")
        return False
    log(f"Секрет {name} сохранён.")
    return True


# ---------------------------------------------------------------- caption

def build_caption(cfg: dict, text: str, texts: dict | None = None) -> str:
    """Подпись к ролику. texts: тексты сети/папки (см. resolve_texts): подпись по умолчанию, хвост, хэштеги."""
    texts = texts or {}
    text = (text or texts.get("caption") or cfg.get("default_text") or "").strip()
    if (texts.get("footer") or "").strip():
        text = f"{text}\n\n{texts['footer'].strip()}".strip()
    tags = texts["hashtags"] if "hashtags" in texts else cfg.get("hashtags", "")
    caption = cfg["caption_template"].format(text=text, hashtags=tags or "")
    # убрать лишние пустые строки
    out: list[str] = []
    for ln in (ln.rstrip() for ln in caption.splitlines()):
        if ln == "" and (not out or out[-1] == ""):
            continue
        out.append(ln)
    caption = "\n".join(out).strip()

    # Instagram: максимум 30 хэштегов, лишние убираем с конца
    count = 0

    def _tag(m: re.Match) -> str:
        nonlocal count
        count += 1
        return m.group(0) if count <= IG_HASHTAG_LIMIT else ""

    caption = re.sub(r"(?<!\S)#\w+", _tag, caption)

    limit = min(int(cfg.get("caption_max_len", IG_CAPTION_LIMIT)), IG_CAPTION_LIMIT)
    if len(caption) > limit:
        caption = caption[: limit - 1].rstrip() + "…"
    return caption


# ---------------------------------------------------------------- queue

VIDEO_EXT = (".mp4", ".mov")
COVER_EXT = (".jpg", ".jpeg", ".png")


def parse_txt(text: str) -> tuple[str, str]:
    """Вернуть (подпись, имя файла обложки).

    Простой .txt: весь текст = подпись.
    Формат с разделами (TITLE:, DESCRIPTION..., REELS CAPTION (Instagram):, COVER: ...):
    подпись берётся из раздела REELS CAPTION, обложка из строки COVER:.
    """
    cover = ""
    m = re.search(r"^\s*COVER:\s*(\S+)", text, re.M | re.I)
    if m:
        cover = m.group(1)
    m = re.search(r"^\s*REELS CAPTION[^\n]*:\s*\n(.*?)(?=^\s*COVER\b|^\s*REELS CAPTION|^[A-Z][A-Z ()/]+:\s*$|\Z)",
                  text, re.M | re.S)
    if m:
        return m.group(1).strip(), cover
    if cover:
        text = re.sub(r"^\s*COVER\b.*$", "", text, flags=re.M | re.I)
    return text.strip(), cover


def parse_covers(text: str) -> dict[str, str]:
    """Обложки по аккаунтам: строки вида «COVER (Instagram @имя): файл.jpg»."""
    out = {}
    for m in re.finditer(r"^\s*COVER\s*\(([^)]*)\)\s*:\s*(\S+)", text, re.M | re.I):
        for name in re.findall(r"@([\w.]+)", m.group(1)):
            out[name.lower()] = m.group(2)
    return out


def parse_captions(text: str) -> list[tuple[str, str]]:
    """Все блоки REELS CAPTION: [(заголовок, текст)]. Заголовок вида «REELS CAPTION (Instagram @имя):»."""
    out = []
    for m in re.finditer(r"^\s*(REELS CAPTION[^\n]*):\s*\n(.*?)(?=^\s*COVER\b|^\s*REELS CAPTION|^[A-Z][A-Z ()/@._-]+:\s*$|\Z)",
                         text, re.M | re.S):
        out.append((m.group(1), m.group(2).strip()))
    return out


def caption_for(item: dict, acc: dict, index: int) -> str:
    """Подпись для аккаунта: блок, где в заголовке есть имя аккаунта; иначе блок без имён
    нужного порядка; иначе общий текст."""
    caps = item.get("captions") or []
    name = acc["name"].lower().lstrip("@")
    for head, body in caps:
        if name and name in head.lower():
            return body
    if acc.get("platform") == "tiktok":
        for head, body in caps:
            if "tiktok" in head.lower() and "@" not in head:
                return body
    plain = [b for h, b in caps if "@" not in h and "tiktok" not in h.lower()]
    if plain:
        return plain[0] if len(plain) == 1 or index >= len(plain) else plain[index]
    return item["text"]


def parse_section(text: str, names: tuple[str, ...]) -> str:
    """Текст раздела «ИМЯ:» из .txt (до следующего заголовка вида «ЗАГЛАВНЫЕ:»)."""
    for name in names:
        m = re.search(rf"^\s*{re.escape(name)}\s*:\s*\n(.*?)(?=^[A-Z][A-Z0-9 ]*(?:\([^)\n]*\))?\s*:\s*$|\Z)", text, re.M | re.S)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return ""


def load_folder_texts(*dirs: pathlib.Path) -> dict:
    """texts.json папки дня и подпапки аккаунта (подпапка важнее). Плоские ключи действуют на все сети,
    ключи "instagram"/"tiktok" только на свою сеть."""
    out: dict = {}
    for d in dirs:
        f = d / "texts.json"
        if not f.is_file():
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            log(f"{f.relative_to(ROOT) if f.is_relative_to(ROOT) else f}: не читается, тексты папки не применяю.")
            continue
        if not isinstance(data, dict):
            continue
        out.update({k: v for k, v in data.items() if k in TEXT_KEYS})
        for net in NETWORKS:
            if isinstance(data.get(net), dict):
                out.setdefault(net, {}).update({k: v for k, v in data[net].items() if k in TEXT_KEYS})
    return out


def resolve_texts(cfg: dict, item: dict, acc: dict) -> dict:
    """Тексты для аккаунта: настройки сети в config.json → texts.json папки → texts.json для этой сети."""
    net = acc.get("platform") or "instagram"
    out = {k: v for k, v in ((cfg.get("texts") or {}).get(net) or {}).items() if k in TEXT_KEYS}
    folder = item.get("texts") or {}
    out.update({k: v for k, v in folder.items() if k in TEXT_KEYS})
    out.update(folder.get(net) or {})
    return {k: (v.strip() if isinstance(v, str) else v) for k, v in out.items()}


def comment_for(item: dict, acc: dict, texts: dict) -> str:
    """Первый комментарий (только Instagram): раздел COMMENT: в .txt ролика, иначе текст папки/сети."""
    if acc.get("platform") == "tiktok":
        return ""  # TikTok не даёт программам писать комментарии
    raw = item.get("raw") or ""
    own = parse_section(raw, ("INSTAGRAM COMMENT", "FIRST COMMENT", "COMMENT"))
    if not own and texts.get("use_pinned_comment"):
        own = parse_section(raw, ("PINNED COMMENT",))
    return (own or texts.get("comment") or "").strip()[:2200]


def first_number(name: str) -> str:
    m = re.search(r"\d+", name)
    return m.group(0).lstrip("0") or "0" if m else ""


def find_cover(video: pathlib.Path, named: str) -> pathlib.Path | None:
    folder = video.parent
    if named and (folder / named).is_file():
        return folder / named
    for e in COVER_EXT + tuple(x.upper() for x in COVER_EXT):
        if video.with_suffix(e).exists():
            return video.with_suffix(e)
    # cover-4.jpg для short-4-....mp4
    num = first_number(video.stem)
    if num:
        for img in sorted(folder.iterdir()):
            if img.suffix.lower() in COVER_EXT and first_number(img.stem) == num:
                return img
    return None


def match_account(name: str) -> dict | None:
    """Подпапка -> аккаунт: имя подпапки равно имени аккаунта (можно с @) или содержит его."""
    n = name.lower().lstrip("@")
    for acc in ACTIVE_ACCOUNTS:
        if acc["name"].lower() == n:
            return acc
    hits = [acc for acc in ACTIVE_ACCOUNTS if acc["name"].lower() in n]
    return max(hits, key=lambda x: len(x["name"])) if hits else None


def _videos(d: pathlib.Path) -> list[pathlib.Path]:
    return sorted(p for p in d.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXT)


def _subdirs(folder: pathlib.Path) -> list[pathlib.Path]:
    return sorted(p for p in folder.iterdir() if p.is_dir() and not p.name.startswith(".") and _videos(p))


def has_videos(folder: pathlib.Path) -> bool:
    return bool(_videos(folder)) or bool(_subdirs(folder))


def load_tt_settings(video: pathlib.Path) -> dict | None:
    """Настройки поста TikTok, подтверждённые человеком в виджете: <имя>.tiktok.json рядом с видео."""
    f = video.with_suffix(".tiktok.json")
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        log(f"{f.name}: не читается, ролик пойдёт в черновики.")
        return None
    return data if isinstance(data, dict) else None


def tt_post_info(settings: dict, caption: str, creator: dict) -> dict:
    """post_info для прямой публикации из подтверждённых настроек. Любое нарушение правил TikTok -> ValueError."""
    if not settings.get("consent"):
        raise ValueError("нет подтверждения пользователя (consent)")
    privacy = settings.get("privacy_level") or ""
    options = creator.get("privacy_level_options") or []
    if not privacy:
        raise ValueError("не выбрана приватность")
    if options and privacy not in options:
        raise ValueError(f"приватность {privacy} недоступна (доступно: {', '.join(options)})")
    commercial = settings.get("commercial") or {}
    own, branded = bool(commercial.get("your_brand")), bool(commercial.get("branded"))
    if commercial.get("on") and not (own or branded):
        raise ValueError("коммерческий контент включён, но не выбран тип")
    if branded and privacy == "SELF_ONLY":
        raise ValueError("брендированный контент нельзя сделать приватным")
    return {
        "title": str(settings.get("title") or caption)[:2200],
        "privacy_level": privacy,
        "disable_comment": bool(settings.get("disable_comment", True)) or bool(creator.get("comment_disabled")),
        "disable_duet": bool(settings.get("disable_duet", True)) or bool(creator.get("duet_disabled")),
        "disable_stitch": bool(settings.get("disable_stitch", True)) or bool(creator.get("stitch_disabled")),
        "brand_content_toggle": branded,
        "brand_organic_toggle": own,
        "video_cover_timestamp_ms": 1000,
        "is_aigc": bool(settings.get("is_aigc", False)),
    }


def _dir_items(d: pathlib.Path, prefix: str, state: dict, accounts: list[dict], group: str,
               texts: dict | None = None) -> list[dict]:
    items = []
    for video in _videos(d):
        key = f"{prefix}/{video.name}"
        pending = [a for a in accounts if not acc_done(state, a, key)]
        if not pending:
            continue
        txt = video.with_suffix(".txt")
        raw = txt.read_text(encoding="utf-8-sig") if txt.exists() else ""
        caption, cover_name = parse_txt(raw)
        items.append({
            "tiktok": load_tt_settings(video),
            "id": key,
            "plan_key": key.split("/", 1)[1],   # путь внутри папки дня: имя файла или «подпапка/файл»
            "group": group,                      # рилсы одного аккаунта планируются отдельно
            "video": video,
            "txt": txt if txt.exists() else None,
            "cover": find_cover(video, cover_name),
            "text": caption,
            "raw": raw,
            "texts": texts or {},
            "captions": parse_captions(raw),
            "covers": parse_covers(raw),
            "pending": pending,
        })
    return items


# ---------------------------------------------------------------- lanes (очереди по соцсетям)

def lanes(cfg: dict) -> list[dict]:
    """Очереди: общая queue/ (во все аккаунты) и отдельные для каждой соцсети (только её аккаунты).
    У каждой очереди своё расписание: своя папка дня, свой план."""
    out = [{"name": "", "prefix": "", "queue_dir": cfg["queue_dir"], "posted_dir": cfg["posted_dir"]}]
    conf = cfg.get("lanes") or {}
    for net in NETWORKS:
        c = conf.get(net) or {}
        out.append({"name": net, "prefix": f"{net}:",
                    "queue_dir": c.get("queue_dir") or f"queue-{net}",
                    "posted_dir": c.get("posted_dir") or f"posted-{net}"})
    return out


def _lane(cfg: dict, lane: dict | None) -> dict:
    return lane if lane else lanes(cfg)[0]


def lane_accounts(lane: dict | None) -> list[dict]:
    if not lane or not lane.get("name"):
        return ACTIVE_ACCOUNTS
    return [a for a in ACTIVE_ACCOUNTS if (a.get("platform") or "instagram") == lane["name"]]


def lane_slot(state: dict, lane: dict | None) -> dict:
    """Где хранится расписание очереди: для общей прямо в state (как раньше), иначе state["lanes"][сеть]."""
    if not lane or not lane.get("name"):
        return state
    return state.setdefault("lanes", {}).setdefault(lane["name"], {})


def lane_paused(cfg: dict, lane: dict | None) -> bool:
    """Соцсеть на паузе: её очередь стоит. Общая очередь стоит, если на паузе любая сеть, у которой есть аккаунты."""
    paused = {str(x).lower() for x in (cfg.get("paused") or [])}
    if not paused:
        return False
    if lane and lane.get("name"):
        return lane["name"] in paused
    nets = {(a.get("platform") or "instagram") for a in ACTIVE_ACCOUNTS}
    return bool(nets & paused)


def lane_of_id(cfg: dict, item_id: str) -> dict:
    for ln in lanes(cfg)[1:]:
        if item_id.startswith(ln["prefix"]):
            return ln
    return lanes(cfg)[0]


def folder_items(folder: pathlib.Path, state: dict, lane: dict | None = None) -> list[dict]:
    """Рилсы папки дня. Два формата:
    1) плоская папка: все рилсы идут во все аккаунты очереди;
    2) папка с подпапками по аккаунтам (имя подпапки = имя аккаунта): каждый аккаунт получает только свои рилсы."""
    accounts = lane_accounts(lane)
    if not accounts:
        return []
    prefix = (lane or {}).get("prefix", "") + folder.name
    items = _dir_items(folder, prefix, state, accounts, "", load_folder_texts(folder))
    for sub in _subdirs(folder):
        acc = match_account(sub.name)
        if acc is None or acc not in accounts:
            log(f"Подпапка {folder.name}/{sub.name}: нет такого аккаунта в этой очереди (или нет его токена), пропускаю.")
            continue
        items += _dir_items(sub, f"{prefix}/{sub.name}", state, [acc], acc["name"], load_folder_texts(folder, sub))
    return items


def build_plan(items: list[dict], start: dt.datetime, end: dt.datetime) -> dict:
    """План дня: рилсы каждого аккаунта равномерно от start до end независимо друг от друга."""
    groups: dict[str, list[str]] = {}
    for it in items:
        groups.setdefault(it.get("group", ""), []).append(it["plan_key"])
    plan: dict = {}
    for names in groups.values():
        plan.update(make_plan(names, start, end))
    return plan


def queue_folders(cfg: dict, lane: dict | None = None) -> list[pathlib.Path]:
    q = ROOT / _lane(cfg, lane)["queue_dir"]
    return sorted(p for p in q.iterdir() if p.is_dir() and not p.name.startswith(".")) if q.exists() else []


def at_time(day: dt.date, hhmm: str, tz) -> dt.datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return dt.datetime.combine(day, dt.time(h, m), tzinfo=tz)


def make_plan(names: list[str], start: dt.datetime, end: dt.datetime) -> dict:
    """Равномерно раскидать рилсы между start и end."""
    n = len(names)
    step = (end - start) / (n - 1) if n > 1 and end > start else dt.timedelta(0)
    return {name: (start + step * i).isoformat(timespec="minutes") for i, name in enumerate(names)}


def repo_is_public() -> bool:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not repo:
        return False
    try:
        r = requests.get(f"https://api.github.com/repos/{repo}", timeout=20)
        return r.ok and not r.json().get("private", True)
    except requests.RequestException:
        return False


def cover_url_for(cfg: dict, cover: pathlib.Path | None) -> str:
    """Instagram забирает обложку только по публичной ссылке."""
    mode = cfg.get("cover", "auto")
    if cover is None or mode == "frame":
        return ""
    if mode in ("auto", "github_raw") and repo_is_public():
        repo = os.environ["GITHUB_REPOSITORY"]
        ref = os.environ.get("GITHUB_SHA") or os.environ.get("GITHUB_REF_NAME", "main")
        rel = cover.relative_to(ROOT).as_posix()
        return f"https://raw.githubusercontent.com/{repo}/{ref}/{quote(rel)}"
    if mode in ("auto", "temp_link"):
        # временная ссылка на 1 час (litterbox.catbox.moe), после публикации не нужна
        try:
            with cover.open("rb") as f:
                r = requests.post("https://litterbox.catbox.moe/resources/internals/api.php",
                                  data={"reqtype": "fileupload", "time": "1h"},
                                  files={"fileToUpload": (cover.name, f)}, timeout=120)
            url = r.text.strip()
            if r.ok and url.startswith("https://"):
                return url
            log(f"Временная ссылка для обложки не получилась: {r.status_code} {url[:200]}")
        except requests.RequestException as e:
            log(f"Временная ссылка для обложки не получилась: {e}")
    log("Обложка будет взята кадром из видео.")
    return ""


def group_loose_files(cfg: dict, now: dt.datetime, lane: dict | None = None) -> None:
    """Файлы, загруженные прямо в queue/ без папки, собрать в новую папку."""
    qd = _lane(cfg, lane)["queue_dir"]
    q = ROOT / qd
    loose = [p for p in q.iterdir() if p.is_file() and not p.name.startswith(".")] if q.exists() else []
    if not any(p.suffix.lower() in VIDEO_EXT for p in loose):
        return
    dest = q / f"{now:%Y%m%d_%H%M}_upload"
    dest.mkdir(exist_ok=True)
    for f in loose:
        f.rename(dest / f.name)
    log(f"Файлы без папки собраны в {qd}/{dest.name}/")


def finish_folder(cfg: dict, folder: pathlib.Path, lane: dict | None = None) -> None:
    pd = _lane(cfg, lane)["posted_dir"]
    dest = ROOT / pd
    dest.mkdir(exist_ok=True)
    target = dest / folder.name
    if target.exists():
        target = dest / f"{folder.name}_{dt.datetime.now():%Y%m%d%H%M%S}"
    folder.rename(target)
    log(f"Папка {folder.name} опубликована полностью и перенесена в {pd}/")


def sweep_finished(cfg: dict, state: dict, lane: dict | None = None) -> None:
    """Перенести в posted/ все папки, где каждый рилс уже опубликован или пропущен."""
    if not lane_accounts(lane):
        return  # у очереди нет аккаунтов: ничего не трогаем, иначе все папки «закончатся» сами собой
    slot = lane_slot(state, lane)
    for f in queue_folders(cfg, lane):
        if has_videos(f) and not folder_items(f, state, lane):
            finish_folder(cfg, f, lane)
            if (slot.get("active") or {}).get("folder") == f.name:
                slot["active"] = None


def schedule(cfg: dict, state: dict, now: dt.datetime,
             lane: dict | None = None) -> tuple[pathlib.Path | None, list[dict]]:
    """Решить, какая папка сегодня в работе и какие рилсы пора публиковать (для одной очереди)."""
    tz = now.tzinfo
    today = now.date()
    start, end = at_time(today, cfg["day_start"], tz), at_time(today, cfg["day_end"], tz)
    ln = _lane(cfg, lane)
    slot = lane_slot(state, lane)
    if not lane_accounts(lane):
        return None, []
    if lane_paused(cfg, lane):
        if not slot.get("paused"):
            log(f"Очередь {ln['queue_dir']}: на паузе.")
        slot["paused"] = True
        return None, []
    resumed = slot.pop("paused", False)
    active = slot.get("active")
    folder = None
    items_of = lambda f: folder_items(f, state, lane)  # noqa: E731

    if active:
        folder = ROOT / ln["queue_dir"] / active["folder"]
        if not folder.is_dir():
            log(f"Папка {active['folder']} пропала из очереди, перехожу к следующей.")
            slot["active"] = active = folder = None
        elif not items_of(folder):
            finish_folder(cfg, folder, lane)
            slot["active"] = active = folder = None

    if active and active["date"] != today.isoformat() and not ln["name"]:
        # общая очередь: TikTok не должен её держать. Если рилс вчера вышел везде, кроме TikTok, пропускаем его там
        for it in items_of(folder):
            if all(a.get("platform") == "tiktok" for a in it["pending"]):
                for acc in it["pending"]:
                    state["skipped"][acc_key(acc, it["id"])] = "TikTok: не успели опубликовать за день"
                    log(f"{it['id']}: в TikTok @{acc['name']} не вышел за день, пропускаю.")
        if not items_of(folder):
            finish_folder(cfg, folder, lane)
            slot["active"] = active = folder = None
    if active and (active["date"] != today.isoformat() or resumed):
        # остались рилсы со вчера (или очередь сняли с паузы): раскидываем остаток на сегодня с текущего момента
        if now < start:
            return None, []
        left = items_of(folder)
        active.update(date=today.isoformat(), plan=build_plan(left, max(now, start), max(end, now)))
        log(f"Папка {folder.name}: {'после паузы ' if resumed else ''}переношу {len(left)} оставшихся рилсов на сегодня.")

    if not active:
        if slot.get("last_started") == today.isoformat() or not (start <= now < end):
            return None, []
        for candidate in queue_folders(cfg, lane):
            items = items_of(candidate)
            if items:
                folder = candidate
                first = start if now - start < dt.timedelta(hours=1) else now
                plan = build_plan(items, first, end)
                slot["active"] = active = {"folder": folder.name, "date": today.isoformat(), "plan": plan}
                slot["last_started"] = today.isoformat()
                log(f"Сегодня публикую папку {ln['queue_dir']}/{folder.name}: {len(items)} рилсов, "
                    f"время: {', '.join(t[11:16] for t in plan.values())}")
                break
        else:
            return None, []

    plan = active["plan"]
    due = [i for i in items_of(folder)
           if dt.datetime.fromisoformat(plan.get(i["plan_key"], now.isoformat())) <= now]
    return folder, due


# ---------------------------------------------------------------- Instagram API

class Instagram:
    def __init__(self, token: str, user_id: str, cfg: dict):
        self.token = token
        self.user_id = user_id
        host = os.environ.get("IG_API_HOST", "").strip()
        if not host:
            host = "graph.facebook.com" if token.startswith("EAA") else "graph.instagram.com"
        self.host = host
        self.base = f"https://{host}/{cfg['api_version']}"
        self.version = cfg["api_version"]
        self.timeout = int(cfg["status_timeout_sec"])

    def _req(self, method: str, url: str, **kw) -> dict:
        params = kw.pop("params", {}) or {}
        params["access_token"] = self.token
        for attempt in range(4):
            try:
                r = requests.request(method, url, params=params, timeout=120, **kw)
            except requests.RequestException as e:
                err = str(e)
            else:
                data = r.json() if r.content else {}
                if r.ok and "error" not in data:
                    return data
                err = json.dumps(data.get("error", data), ensure_ascii=False)
                # временные ошибки повторяем, остальные сразу отдаём
                transient = r.status_code >= 500 or (data.get("error", {}) or {}).get("is_transient")
                if not transient:
                    raise RuntimeError(f"Instagram API {r.status_code}: {err}")
            time.sleep(2 ** (attempt + 1))
        raise RuntimeError(f"Instagram API: {err}")

    def whoami(self) -> dict:
        """Узнать аккаунт по токену. Для Instagram Login берём user_id из /me,
        так надёжнее, чем ID из секрета."""
        if self.host == "graph.instagram.com":
            me = self._req("GET", f"{self.base}/me", params={"fields": "user_id,username,account_type,media_count"})
            real = str(me.get("user_id") or "")
            if real and real != self.user_id:
                log(f"IG_USER_ID из секрета не совпадает с аккаунтом токена, использую {real}.")
                self.user_id = real
            me["id"] = real or me.get("id")
            return me
        try:
            return self._req("GET", f"{self.base}/{self.user_id}",
                             params={"fields": "id,username,media_count"})
        except RuntimeError:
            self.diagnose_facebook()
            raise

    def diagnose_facebook(self) -> None:
        """Подсказка, чего не хватает токену Facebook Login."""
        uid = self.user_id
        log(f"IG_USER_ID: длина {len(uid)}, только цифры: {uid.isdigit()}, начало {uid[:4]}…, "
            f"совпадает с dayzerorules: {uid == '17841431768361264'}")
        for path in (f"{uid}?fields=id", f"{uid}/content_publishing_limit"):
            try:
                self._req("GET", f"{self.base}/{path}")
                log(f"GET {path.replace(uid, '<id>')}: OK")
            except RuntimeError as e:
                log(f"GET {path.replace(uid, '<id>')}: {str(e)[:160]}")
        try:
            me = self._req("GET", f"{self.base}/me", params={"fields": "id,name"})
            log(f"Токен выдан на: {me.get('name')} (тип: Facebook)")
            perms = self._req("GET", f"{self.base}/me/permissions").get("data", [])
            granted = sorted(p["permission"] for p in perms if p.get("status") == "granted")
            log(f"Разрешения токена: {', '.join(granted) or 'нет'}")
            need = {"instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"}
            if need - set(granted):
                log(f"НЕ ХВАТАЕТ разрешений: {', '.join(sorted(need - set(granted)))}")
            if "instagram_manage_comments" not in granted:
                log("Для авто-комментариев нужно ещё разрешение instagram_manage_comments (без него рилсы выходят, "
                    "но комментарий не добавится).")
            pages = self._req("GET", f"{self.base}/me/accounts",
                              params={"fields": "name,instagram_business_account{id,username}"}).get("data", [])
            if not pages:
                log("Токен не видит ни одной страницы Facebook. Instagram должен быть привязан к странице.")
            for pg in pages:
                ig = pg.get("instagram_business_account")
                log(f"Страница «{pg.get('name')}»: Instagram "
                    f"{'@' + ig.get('username', '?') + ' id ' + ig['id'] if ig else 'не привязан'}")
        except RuntimeError as e:
            log(f"Диагностика не удалась: {e}")

    def create_reel_container(self, caption: str, cover_url: str, thumb_offset: int | None,
                              share_to_feed: bool) -> str:
        data = {
            "media_type": "REELS",
            "upload_type": "resumable",
            "caption": caption,
            "share_to_feed": "true" if share_to_feed else "false",
        }
        if cover_url:
            data["cover_url"] = cover_url
        elif thumb_offset is not None:
            data["thumb_offset"] = str(thumb_offset)
        return self._req("POST", f"{self.base}/{self.user_id}/media", data=data)["id"]

    def upload_video(self, container_id: str, path: pathlib.Path) -> None:
        size = path.stat().st_size
        url = f"https://rupload.facebook.com/ig-api-upload/{self.version}/{container_id}"
        log(f"Загружаю видео ({size / 1e6:.1f} МБ)")
        with path.open("rb") as f:
            r = requests.post(url, data=f, timeout=900, headers={
                "Authorization": f"OAuth {self.token}",
                "offset": "0",
                "file_size": str(size),
            })
        if not r.ok:
            raise RuntimeError(f"Ошибка загрузки видео {r.status_code}: {r.text[:500]}")

    def wait_ready(self, container_id: str) -> None:
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            st = self._req("GET", f"{self.base}/{container_id}", params={"fields": "status_code,status"})
            code = st.get("status_code")
            log(f"Статус обработки: {code}")
            if code == "FINISHED":
                return
            if code in ("ERROR", "EXPIRED"):
                raise RuntimeError(f"Instagram не смог обработать видео: {st.get('status')}")
            time.sleep(15)
        raise RuntimeError("Instagram слишком долго обрабатывает видео (таймаут)")

    def publish(self, container_id: str) -> str:
        return self._req("POST", f"{self.base}/{self.user_id}/media_publish",
                         data={"creation_id": container_id})["id"]

    def comment(self, media_id: str, message: str) -> str:
        """Комментарий от имени аккаунта под своим рилсом (нужно разрешение instagram_manage_comments)."""
        return self._req("POST", f"{self.base}/{media_id}/comments", data={"message": message}).get("id", "")

    def permalink(self, media_id: str) -> str:
        try:
            return self._req("GET", f"{self.base}/{media_id}", params={"fields": "permalink"}).get("permalink", "")
        except RuntimeError:
            return ""


# ---------------------------------------------------------------- TikTok API

TT_API = "https://open.tiktokapis.com"
TT_SCOPES = "user.info.basic,video.upload"  # для прямой публикации (mode=direct) нужен ещё video.publish
TT_CHUNK = 10 * 1024 * 1024      # TikTok: куски от 5 до 64 МБ, последний может быть больше
TT_SINGLE_MAX = 64 * 1024 * 1024  # файл до 64 МБ грузим одним куском


class TikTokLimit(RuntimeError):
    """TikTok временно не даёт публиковать (лимит черновиков, частота). Это не ошибка ролика."""


def tt_chunks(size: int) -> tuple[int, int]:
    """(chunk_size, total_chunk_count) по правилам TikTok Media Transfer."""
    if size <= TT_SINGLE_MAX:
        return size, 1
    return TT_CHUNK, size // TT_CHUNK


class TikTok:
    """Content Posting API. mode=inbox: ролик падает в черновики (уведомление в приложении TikTok),
    mode=direct: публикуется сразу (без аудита приложения TikTok разрешает только SELF_ONLY)."""

    def __init__(self, acc: dict, refresh_token: str, cfg: dict):
        self.acc = acc
        self.name = acc["name"]
        self.mode = acc.get("mode", "inbox")
        self.refresh_token = refresh_token
        self.access_token = ""
        self.refresh_expires = ""  # до какого числа действует refresh-токен (TikTok сообщает при продлении)
        self.timeout = int(cfg["status_timeout_sec"])
        self.host = "open.tiktokapis.com"

    # --- токен
    def _auth(self) -> None:
        if self.access_token:
            return
        key, sec = tt_client_key(self.acc), secret(self.acc["client_secret_env"])
        if not (key and sec):
            raise RuntimeError(f"не заданы секреты {self.acc['client_key_env']} / {self.acc['client_secret_env']}")
        mask(sec)
        r = requests.post(f"{TT_API}/v2/oauth/token/", timeout=60, data={
            "client_key": key, "client_secret": sec,
            "grant_type": "refresh_token", "refresh_token": self.refresh_token,
        }, headers={"Content-Type": "application/x-www-form-urlencoded"})
        data = r.json() if r.content else {}
        if not r.ok or "access_token" not in data:
            raise RuntimeError(f"TikTok не продлил токен (OAuthException): "
                               f"{data.get('error_description') or data.get('error') or r.status_code}. "
                               f"Подключите аккаунт заново (виджет: аккаунт → «Переподключить»).")
        self.access_token = data["access_token"]
        mask(self.access_token)
        if data.get("refresh_expires_in"):
            self.refresh_expires = (dt.date.today() + dt.timedelta(seconds=int(data["refresh_expires_in"]))).isoformat()
        new_rt = data.get("refresh_token") or ""
        if new_rt and new_rt != self.refresh_token:
            mask(new_rt)
            self.refresh_token = new_rt
            if not save_github_secret(self.acc["token_env"], new_rt):
                log(f"ВНИМАНИЕ: TikTok выдал новый refresh-токен, а сохранить его некуда. "
                    f"Добавьте GH_PAT, иначе через год придётся подключать @{self.name} заново.")

    def _req(self, path: str, body: dict | None = None, method: str = "POST") -> dict:
        self._auth()
        err = ""
        for attempt in range(4):
            try:
                r = requests.request(method, f"{TT_API}{path}", json=body if method == "POST" else None,
                                     timeout=120, headers={"Authorization": f"Bearer {self.access_token}",
                                                           "Content-Type": "application/json; charset=UTF-8"})
            except requests.RequestException as e:
                err = str(e)
            else:
                data = r.json() if r.content else {}
                code = (data.get("error") or {}).get("code", "ok")
                if r.ok and code == "ok":
                    return data.get("data") or {}
                msg = (data.get("error") or {}).get("message", "") or r.text[:300]
                err = f"TikTok API {r.status_code} {code}: {msg}"
                if code.startswith("spam_risk") or code == "rate_limit_exceeded" or r.status_code == 429:
                    raise TikTokLimit(err)
                if code in ("access_token_invalid", "scope_not_authorized"):
                    raise RuntimeError(err + " (OAuthException)")
                if r.status_code < 500:
                    raise RuntimeError(err)
            time.sleep(2 ** (attempt + 1))
        raise RuntimeError(err)

    def whoami(self) -> dict:
        u = self._req("/v2/user/info/?fields=open_id,display_name", method="GET").get("user", {})
        # username нужен scope user.info.profile, а у нас только user.info.basic: берём display_name
        info = {"username": u.get("display_name") or self.name, "id": u.get("open_id", "")}
        info["nickname"] = info["username"]
        if self.mode == "direct":
            ci = self._req("/v2/post/publish/creator_info/query/", {})
            info["privacy_options"] = ci.get("privacy_level_options") or []
            info["max_duration"] = ci.get("max_video_post_duration_sec")
            info["creator"] = {k: ci.get(k) for k in ("privacy_level_options", "comment_disabled", "duet_disabled",
                                                       "stitch_disabled", "max_video_post_duration_sec")}
        return info

    # --- публикация
    def upload(self, path: pathlib.Path, caption: str, settings: dict | None = None) -> str:
        size = path.stat().st_size
        chunk, count = tt_chunks(size)
        source = {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk, "total_chunk_count": count}
        if self.mode == "direct" and settings is not None:
            ci = self._req("/v2/post/publish/creator_info/query/", {})
            post = tt_post_info(settings, caption, ci)
            init = self._req("/v2/post/publish/video/init/", {"post_info": post, "source_info": source})
            self.sent_mode = "direct"
        else:
            if self.mode == "direct":
                log("Нет подтверждённых настроек поста (.tiktok.json): отправляю в черновики TikTok.")
            init = self._req("/v2/post/publish/inbox/video/init/", {"source_info": source})
            self.sent_mode = "inbox"
        publish_id, url = init["publish_id"], init["upload_url"]
        log(f"Загружаю видео в TikTok ({size / 1e6:.1f} МБ, частей: {count})")
        with path.open("rb") as f:
            for n in range(count):
                start = n * chunk
                part = f.read(size - start if n == count - 1 else chunk)
                end = start + len(part) - 1
                r = requests.put(url, data=part, timeout=900, headers={
                    "Content-Type": "video/quicktime" if path.suffix.lower() == ".mov" else "video/mp4",
                    "Content-Length": str(len(part)),
                    "Content-Range": f"bytes {start}-{end}/{size}"})
                if r.status_code not in (200, 201, 206):
                    raise RuntimeError(f"Ошибка загрузки видео в TikTok {r.status_code}: {r.text[:300]}")
        return publish_id

    def wait_ready(self, publish_id: str) -> str:
        """Ждать окончания обработки. Вернуть статус (SEND_TO_USER_INBOX или PUBLISH_COMPLETE)."""
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            st = self._req("/v2/post/publish/status/fetch/", {"publish_id": publish_id})
            status = st.get("status", "")
            log(f"Статус TikTok: {status}")
            if status in ("SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"):
                ids = st.get("publicaly_available_post_id") or st.get("publicly_available_post_id") or []
                self.post_id = str(ids[0]) if ids else ""
                return status
            if status == "FAILED":
                raise RuntimeError(f"TikTok не смог обработать видео: {st.get('fail_reason')}")
            time.sleep(10)
        raise RuntimeError("TikTok слишком долго обрабатывает видео (таймаут)")

    def post(self, path: pathlib.Path, caption: str, settings: dict | None = None) -> dict:
        self.post_id = ""
        publish_id = self.upload(path, caption, settings)
        status = self.wait_ready(publish_id)
        link = f"https://www.tiktok.com/@{self.acc.get('username') or self.name}/video/{self.post_id}" if self.post_id else ""
        return {"media_id": publish_id, "permalink": link, "platform": "tiktok",
                "mode": "inbox" if status == "SEND_TO_USER_INBOX" else "direct"}


def tt_client_key(acc: dict) -> str:
    return secret(acc.get("client_key_env") or "TT_CLIENT_KEY") or str(load_config().get("tiktok_client_key") or "")


def tt_auth_url(client_key: str, redirect_uri: str, state: str = "autoposter", scopes: str = TT_SCOPES) -> str:
    from urllib.parse import urlencode
    return "https://www.tiktok.com/v2/auth/authorize/?" + urlencode({
        "client_key": client_key, "scope": scopes, "response_type": "code",
        "redirect_uri": redirect_uri, "state": state})


def tt_code_from(text: str) -> str:
    """Код из адреса страницы после входа (…?code=XXX&scopes=…) или сам код."""
    from urllib.parse import parse_qs, unquote, urlparse
    text = text.strip()
    if "code=" in text:
        q = parse_qs(urlparse(text).query) or parse_qs(text.split("?", 1)[-1])
        if q.get("code"):
            return q["code"][0]
    return unquote(text)


# ---------------------------------------------------------------- commands

def cmd_post(args) -> int:
    cfg = load_config()
    if not ACTIVE_ACCOUNTS:
        log("Нет ни одного подключённого аккаунта: публиковать некуда.")
        return 0
    state = load_state()
    tz = ZoneInfo(cfg["timezone"])
    now = dt.datetime.fromisoformat(args.now).replace(tzinfo=tz) if args.now else dt.datetime.now(tz)

    if args.dry_run:
        for ln in lanes(cfg):
            for folder in queue_folders(cfg, ln):
                items = folder_items(folder, state, ln)
                if not items:
                    continue
                plan = build_plan(items, at_time(now.date(), cfg["day_start"], tz), at_time(now.date(), cfg["day_end"], tz))
                print(f"=== {ln['queue_dir']}/{folder.name}: {len(items)} рилсов")
                for i in items:
                    cover = i["cover"].name if i["cover"] else f"кадр {cfg['thumb_offset_ms']} мс"
                    print(f"--- {plan[i['plan_key']][11:16]}  {i['plan_key']}  (обложка: {cover})")
                    for n, acc in enumerate(ACTIVE_ACCOUNTS):
                        if acc not in i["pending"]:
                            continue
                        texts = resolve_texts(cfg, i, acc)
                        print(f"[@{acc['name']}]\n{build_caption(cfg, caption_for(i, acc, n), texts)}")
                        com = comment_for(i, acc, texts)
                        print(f"(комментарий: {com})\n" if com else "")
        return 0

    due: list[dict] = []
    for ln in lanes(cfg):
        group_loose_files(cfg, now, ln)
        sweep_finished(cfg, state, ln)
    if args.only:
        # разовая публикация выбранного рилса прямо сейчас, расписание не трогаем
        for ln in lanes(cfg):
            for f in queue_folders(cfg, ln):
                due = [i for i in folder_items(f, state, ln) if i["id"] == args.only][:1] \
                    or [i for i in folder_items(f, state, ln) if args.only in i["id"]][:1]
                if due:
                    break
            if due:
                break
        if not due:
            log(f"Рилс «{args.only}» не найден в очереди (или уже опубликован).")
            return 1
        log(f"Публикую сейчас: {due[0]['id']}")
    else:
        for ln in lanes(cfg):
            due += schedule(cfg, state, now, ln)[1]
    for ln in lanes(cfg):
        slot = lane_slot(state, ln)
        if slot.get("active"):
            act = slot["active"]
            plans = slot.setdefault("plans", {})
            plans[act["date"]] = {"folder": act["folder"], "plan": act["plan"]}
            for old_day in sorted(plans)[:-14]:  # храним последние 14 дней
                plans.pop(old_day)
    if not state.get("lanes"):
        state.pop("lanes", None)
    save_state(state)
    if not due:
        log("Сейчас публиковать нечего.")
        return 0

    igs = {}
    dead: set[str] = set()  # аккаунты с недействительным токеном (или лимитом TikTok) в этом запуске
    for acc in ACTIVE_ACCOUNTS:
        igs[acc["name"]] = make_ig(acc, cfg)
        try:
            igs[acc["name"]].whoami()
        except RuntimeError as e:
            if note_token(state, acc, False, str(e)):
                save_state(state)
            if acc.get("platform") != "tiktok":
                raise
            # TikTok не должен останавливать Instagram
            log(f"TikTok @{acc['name']} сейчас недоступен, пропускаю в этом запуске: {e}")
            dead.add(acc["name"])
        else:
            if note_token(state, acc, True, expires=getattr(igs[acc["name"]], "refresh_expires", "")):
                save_state(state)
    posted = failed = 0
    for item in due[: int(cfg["max_posts_per_run"])]:
        for index, acc in enumerate(ACTIVE_ACCOUNTS):
            if acc not in item["pending"] or acc["name"] in dead:
                continue
            ig = igs[acc["name"]]
            fkey = acc_key(acc, item["id"])
            log(f"→ {item['id']} → @{acc['name']}")
            if acc.get("platform") == "tiktok":
                try:
                    res = ig.post(item["video"], build_caption(cfg, caption_for(item, acc, index), resolve_texts(cfg, item, acc)),
                                  item.get("tiktok"))
                except TikTokLimit as e:
                    log(f"TikTok @{acc['name']}: лимит, попробую в следующий раз. {e}")
                    if "pending_share" in str(e):
                        log("В черновиках TikTok уже 5 неопубликованных роликов: опубликуйте их в приложении TikTok.")
                    dead.add(acc["name"])
                    continue
                except Exception as e:  # noqa: BLE001
                    failed += 1
                    log(f"ОШИБКА с {item['id']} (TikTok @{acc['name']}): {e}")
                    fails = state.setdefault("failures", {})
                    fails[fkey] = fails.get(fkey, 0) + 1
                    if fails[fkey] >= 3:
                        state["skipped"][fkey] = f"3 неудачные попытки: {str(e)[:300]}"
                        log("Ролик пропущен после 3 попыток, смотрите state.json -> skipped.")
                    save_state(state)
                    if "OAuthException" in str(e):
                        log(f"Похоже, токен TikTok недействителен. Подключите @{acc['name']} заново.")
                        dead.add(acc["name"])
                    continue
                res["at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
                acc_posted(state, acc)[item["id"]] = res
                state.get("failures", {}).pop(fkey, None)
                save_state(state)
                posted += 1
                log("Ролик в черновиках TikTok: откройте уведомление в приложении и опубликуйте."
                    if res["mode"] == "inbox" else f"Опубликовано в TikTok: {res['permalink'] or res['media_id']}")
                continue
            texts = resolve_texts(cfg, item, acc)
            try:
                caption = build_caption(cfg, caption_for(item, acc, index), texts)
                cover = item["cover"]
                named = item.get("covers", {}).get(acc["name"].lower())
                if named and (item["video"].parent / named).is_file():
                    cover = item["video"].parent / named
                cover_url = cover_url_for(cfg, cover)
                for attempt in range(3):
                    try:
                        cid = ig.create_reel_container(caption, cover_url, int(cfg["thumb_offset_ms"]),
                                                       bool(cfg["share_to_feed"]))
                        ig.upload_video(cid, item["video"])
                        break
                    except RuntimeError as e:
                        # Instagram иногда отвечает «ProcessingFailedError» на первую попытку: пробуем заново
                        if "ProcessingFailedError" in str(e) and attempt < 2:
                            log(f"Instagram не принял видео (попытка {attempt + 1}), пробую ещё раз.")
                            time.sleep(20)
                            continue
                        raise
                ig.wait_ready(cid)
                media_id = ig.publish(cid)
            except Exception as e:  # noqa: BLE001
                failed += 1
                log(f"ОШИБКА с {item['id']} (@{acc['name']}): {e}")
                fails = state.setdefault("failures", {})
                fails[fkey] = fails.get(fkey, 0) + 1
                if fails[fkey] >= 3:
                    state["skipped"][fkey] = f"3 неудачные попытки: {str(e)[:300]}"
                    log("Ролик пропущен после 3 попыток, смотрите state.json -> skipped.")
                save_state(state)
                if "OAuthException" in str(e) or "access token" in str(e).lower():
                    log(f"Похоже, токен недействителен. Обновите секрет {acc['token_env']}.")
                    dead.add(acc["name"])
                continue
            link = ig.permalink(media_id)
            record = {
                "media_id": media_id,
                "permalink": link,
                "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            }
            comment = comment_for(item, acc, texts)
            if comment:
                # комментарий не должен ломать публикацию: рилс уже вышел
                try:
                    record["comment_id"] = ig.comment(media_id, comment)
                    log("Комментарий добавлен.")
                except Exception as e:  # noqa: BLE001
                    record["comment_error"] = str(e)[:300]
                    log(f"Комментарий не добавлен (нужно разрешение instagram_manage_comments): {str(e)[:200]}")
            acc_posted(state, acc)[item["id"]] = record
            state.get("failures", {}).pop(fkey, None)
            save_state(state)
            posted += 1
            log(f"Опубликовано: {link or media_id}")

    for ln in lanes(cfg):
        sweep_finished(cfg, state, ln)
    save_state(state)
    return 1 if failed and not posted else 0


def export_tt_creator(cfg: dict, acc: dict) -> None:
    """Для экрана подтверждения в виджете: ник и допустимые настройки автора (creator_info) -> tiktok_creator.json."""
    if acc.get("mode") != "direct":
        return
    path = ROOT / "tiktok_creator.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    try:
        info = make_ig(acc, cfg).whoami()
    except RuntimeError as e:
        log(f"TikTok @{acc['name']}: не получил настройки автора: {str(e)[:200]}")
        return
    data[acc["name"]] = {"nickname": info.get("nickname"), **(info.get("creator") or {}),
                         "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def cmd_stats(args) -> int:
    """Собрать лайки, комментарии и (если токен позволяет) просмотры в stats.json.
    Ключ для первого аккаунта: queue-id рилса, для остальных: «аккаунт|queue-id»."""
    cfg = load_config()
    state = load_state()
    stats_path = ROOT / "stats.json"
    stats = json.loads(stats_path.read_text(encoding="utf-8")) if stats_path.exists() else {}
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)
    for acc in configure_accounts(cfg):
        if acc.get("platform") == "tiktok":
            export_tt_creator(cfg, acc)
            continue  # статистику TikTok пока не собираем
        ig = make_ig(acc, cfg)
        insights_ok = True
        for pid, info in acc_posted(state, acc).items():
            key = acc_key(acc, pid)
            at = dt.datetime.fromisoformat(info["at"])
            if at < cutoff and key in stats:
                continue  # старые не обновляем
            row = stats.get(key, {})
            try:
                m = ig._req("GET", f"{ig.base}/{info['media_id']}",
                            params={"fields": "like_count,comments_count,permalink"})
                row.update(likes=m.get("like_count"), comments=m.get("comments_count"),
                           permalink=m.get("permalink") or info.get("permalink", ""))
            except RuntimeError as e:
                log(f"{key}: не удалось получить лайки: {str(e)[:200]}")
                continue
            if insights_ok:
                try:
                    ins = ig._req("GET", f"{ig.base}/{info['media_id']}/insights",
                                  params={"metric": "views,reach,saved,shares"})
                    for d in ins.get("data", []):
                        row[d["name"]] = (d.get("values") or [{}])[0].get("value")
                except RuntimeError as e:
                    insights_ok = False
                    log(f"Просмотры недоступны (нужно разрешение instagram_manage_insights): {str(e)[:160]}")
            row["updated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
            stats[key] = row
    stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"Статистика обновлена для {len(stats)} рилсов.")
    return 0


def cmd_check(args) -> int:
    cfg = load_config()
    code = 0
    for acc in configure_accounts(cfg):
        log(f"=== Аккаунт «{acc['name']}» ({acc['token_env']})")
        try:
            _check_one(cfg, acc)
        except (RuntimeError, SystemExit) as e:
            log(f"ОШИБКА: {e}")
            code = 1
    return code


def _check_one(cfg: dict, acc: dict) -> int:
    if acc.get("platform") == "tiktok":
        tt = make_ig(acc, cfg)
        info = tt.whoami()
        log(f"TikTok: токен работает. Аккаунт: @{info.get('username')}, режим: "
            f"{'черновики (inbox)' if tt.mode == 'inbox' else 'прямая публикация'}")
        if tt.mode == "direct":
            log(f"Доступная приватность: {', '.join(info.get('privacy_options') or []) or '?'}; "
                f"макс. длина видео: {info.get('max_duration')} сек")
            if info.get("privacy_options") == ["SELF_ONLY"]:
                log("Приложение TikTok без аудита: ролики будут видны только вам, а аккаунт должен быть закрытым.")
        return 0
    ig = make_ig(acc, cfg)
    log(f"API: {ig.host}")
    info = ig.whoami()
    log(f"Токен работает. Аккаунт: @{info.get('username')} (id {info.get('id')}, "
        f"тип {info.get('account_type', '?')}, публикаций {info.get('media_count', '?')}), API: {ig.host}")
    # проверка статистики на последнем медиа аккаунта
    try:
        media = ig._req("GET", f"{ig.base}/{ig.user_id}/media", params={"limit": "1", "fields": "id,media_product_type"})
        last = (media.get("data") or [None])[0]
        if not last:
            log("Статистика: у аккаунта пока нет публикаций для проверки.")
        else:
            ins = ig._req("GET", f"{ig.base}/{last['id']}/insights",
                          params={"metric": "reach,saved,shares" if last.get("media_product_type") != "REELS"
                                  else "views,reach,saved,shares"})
            vals = {d["name"]: (d.get("values") or [{}])[0].get("value") for d in ins.get("data", [])}
            log(f"Статистика (просмотры и охват) доступна: {vals}")
    except RuntimeError as e:
        log(f"Статистика (просмотры и охват) недоступна: {str(e)[:250]}")
    return 0


def cmd_remove(args) -> int:
    """Убрать папку из очереди (без публикации). Опубликованное остаётся в state.json."""
    import shutil
    cfg = load_config()
    state = load_state()
    name = args.name.strip().strip("/")
    ln = lane_of_id(cfg, name)
    name = name[len(ln["prefix"]):]
    target = ROOT / ln["queue_dir"] / name
    if not name or "/" in name or ".." in name or not target.is_dir():
        log(f"Папка «{args.name}» не найдена в {ln['queue_dir']}/.")
        return 1
    shutil.rmtree(target)
    slot = lane_slot(state, ln)
    if (slot.get("active") or {}).get("folder") == name:
        slot["active"] = None
    save_state(state)
    log(f"Папка {name} удалена из очереди.")
    return 0


def refresh_ig_token(token: str) -> tuple[str, int]:
    """Продлить токен Instagram. Возвращает (новый токен, дней) или ('', 0), если продлевать не нужно/нельзя."""
    if token.startswith("EAA"):
        app_id, app_secret = secret("FB_APP_ID"), secret("FB_APP_SECRET")
        if not (app_id and app_secret):
            log("Токен Facebook (системный пользователь или долгий токен). Без FB_APP_ID/FB_APP_SECRET не продлеваю.")
            return "", 0
        mask(app_secret)
        r = requests.get("https://graph.facebook.com/oauth/access_token", timeout=60, params={
            "grant_type": "fb_exchange_token", "client_id": app_id,
            "client_secret": app_secret, "fb_exchange_token": token,
        })
    else:
        r = requests.get("https://graph.instagram.com/refresh_access_token", timeout=60, params={
            "grant_type": "ig_refresh_token", "access_token": token,
        })
    data = r.json() if r.content else {}
    if not r.ok or "access_token" not in data:
        raise RuntimeError(f"не удалось продлить токен: {json.dumps(data.get('error', data), ensure_ascii=False)[:300]}")
    mask(data["access_token"])
    return data["access_token"], int(data.get("expires_in", 0)) // 86400


def cmd_refresh(args) -> int:
    """Продлить токены всех аккаунтов Instagram (токены Instagram Login живут 60 дней). TikTok продлевается сам."""
    cfg = load_config()
    accs = [a for a in configure_accounts(cfg) if a.get("platform", "instagram") == "instagram"]
    code, seen = 0, set()
    for acc in accs:
        token = secret(acc["token_env"])
        if not token or acc["token_env"] in seen:
            continue
        seen.add(acc["token_env"])
        mask(token)
        log(f"=== @{acc['name']} ({acc['token_env']})")
        try:
            new, days = refresh_ig_token(token)
        except RuntimeError as e:
            log(f"ОШИБКА: {e}")
            code = 1
            continue
        if not new:
            continue
        log(f"Токен продлён, действует ещё ~{days} дн.")
        if new != token and not save_github_secret(acc["token_env"], new):
            log(f"Обновите секрет {acc['token_env']} вручную.")
            code = 1
    return code


def _tt_account(name: str) -> dict:
    cfg = load_config()
    for i, a in enumerate(cfg.get("accounts") or []):
        if (a.get("platform") or "").lower() == "tiktok" and (not name or a.get("name") == name):
            accs = [x for x in configure_accounts({**cfg, "accounts": [cfg["accounts"][0], a]}) if x.get("platform") == "tiktok"]
            if accs:
                return accs[0]
            return {"name": a["name"], "token_env": a.get("token_env") or tt_secret_name(a["name"]),
                    "mode": (a.get("mode") or "inbox").lower(),
                    "client_key_env": a.get("client_key_env") or "TT_CLIENT_KEY",
                    "client_secret_env": a.get("client_secret_env") or "TT_CLIENT_SECRET"}
    sys.exit(f"В config.json нет аккаунта TikTok{' «' + name + '»' if name else ''} (нужно поле \"platform\": \"tiktok\").")


def _tt_redirect(cfg: dict) -> str:
    uri = cfg.get("tiktok_redirect_uri") or ""
    if not uri:
        sys.exit("В config.json не задан tiktok_redirect_uri (тот же адрес, что в настройках приложения TikTok).")
    return uri


def cmd_tiktok_url(args) -> int:
    acc = _tt_account(args.account)
    key = args.client_key or str(load_config().get("tiktok_client_key") or "")
    if not key:
        sys.exit("Нужен Client key: впишите его в config.json (tiktok_client_key) или передайте --client-key.")
    scopes = TT_SCOPES + (",video.publish" if acc.get("mode") == "direct" else "")
    log("Откройте ссылку, войдите в TikTok и разрешите доступ:")
    print(tt_auth_url(key, _tt_redirect(load_config()), state=acc["name"], scopes=scopes), flush=True)
    return 0


def cmd_tiktok_connect(args) -> int:
    cfg = load_config()
    acc = _tt_account(args.account)
    key, sec = tt_client_key(acc), secret(acc["client_secret_env"])
    if not (key and sec):
        sys.exit(f"Ошибка: нужен tiktok_client_key в config.json и секрет {acc['client_secret_env']}.")
    mask(sec)
    code = tt_code_from(args.code)
    mask(code)
    r = requests.post(f"{TT_API}/v2/oauth/token/", timeout=60, data={
        "client_key": key, "client_secret": sec, "code": code,
        "grant_type": "authorization_code", "redirect_uri": _tt_redirect(cfg),
    }, headers={"Content-Type": "application/x-www-form-urlencoded"})
    data = r.json() if r.content else {}
    if not r.ok or "refresh_token" not in data:
        log(f"TikTok не принял код: {data.get('error_description') or data.get('error') or r.status_code}. "
            f"Код живёт несколько минут и одноразовый: войдите заново и сразу запустите workflow.")
        return 1
    mask(data["access_token"])
    mask(data["refresh_token"])
    scopes = data.get("scope", "")
    log(f"Вход в TikTok удался. Разрешения: {scopes}. Refresh-токен действует "
        f"~{int(data.get('refresh_expires_in', 0)) // 86400} дн.")
    need = ("video.upload", "video.publish") if acc.get("mode") == "direct" else ("video.upload",)
    missing = [x for x in need if x not in scopes]
    if missing:
        log(f"ВНИМАНИЕ: не выдано разрешение {', '.join(missing)}. Добавьте его в приложении TikTok.")
    return 0 if save_github_secret(acc["token_env"], data["refresh_token"]) else 1


def main() -> int:
    p = argparse.ArgumentParser(description="Автопостер Reels в Instagram")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("post")
    sp.add_argument("--dry-run", action="store_true")
    sp.add_argument("--only", help="опубликовать сейчас один рилс, часть имени, например short-4")
    sp.add_argument("--now", help="для проверки: подставить время, например 2026-11-03T14:00")
    sp.set_defaults(func=cmd_post)
    sub.add_parser("check").set_defaults(func=cmd_check)
    sub.add_parser("stats").set_defaults(func=cmd_stats)
    rp = sub.add_parser("remove")
    rp.add_argument("name", help="имя папки в queue/, например 003_Metro; для отдельных очередей tiktok:005_x или instagram:005_x")
    rp.set_defaults(func=cmd_remove)
    sub.add_parser("refresh-token").set_defaults(func=cmd_refresh)
    tu = sub.add_parser("tiktok-url", help="ссылка для входа в TikTok")
    tu.add_argument("account", nargs="?", default="")
    tu.add_argument("--client-key", default="")
    tu.set_defaults(func=cmd_tiktok_url)
    tc = sub.add_parser("tiktok-connect", help="сохранить токен TikTok по коду после входа")
    tc.add_argument("account", nargs="?", default="")
    tc.add_argument("--code", required=True, help="адрес страницы после входа (с ?code=...) или сам код")
    tc.set_defaults(func=cmd_tiktok_connect)
    args = p.parse_args()
    if args.cmd == "post":
        configure_accounts(load_config())
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
