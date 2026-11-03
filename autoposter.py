#!/usr/bin/env python3
"""Instagram Reels autoposter.

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
    "api_version": "v23.0",
    "status_timeout_sec": 900,
}

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


# ---------------------------------------------------------------- caption

def build_caption(cfg: dict, text: str) -> str:
    text = (text or cfg.get("default_text") or "").strip()
    caption = cfg["caption_template"].format(text=text, hashtags=cfg.get("hashtags", ""))
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


def folder_items(folder: pathlib.Path, state: dict) -> list[dict]:
    """Рилсы одной папки по алфавиту (удобно нумеровать: 01_..., 02_...)."""
    items = []
    for video in sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXT):
        key = f"{folder.name}/{video.name}"
        if key in state["posted"] or key in state["skipped"]:
            continue
        txt = video.with_suffix(".txt")
        cover = next((video.with_suffix(e) for e in COVER_EXT + tuple(x.upper() for x in COVER_EXT)
                      if video.with_suffix(e).exists()), None)
        items.append({
            "id": key,
            "video": video,
            "txt": txt if txt.exists() else None,
            "cover": cover,
            "text": txt.read_text(encoding="utf-8-sig") if txt.exists() else "",
        })
    return items


def queue_folders(cfg: dict) -> list[pathlib.Path]:
    q = ROOT / cfg["queue_dir"]
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


def finish_folder(cfg: dict, folder: pathlib.Path) -> None:
    dest = ROOT / cfg["posted_dir"]
    dest.mkdir(exist_ok=True)
    target = dest / folder.name
    if target.exists():
        target = dest / f"{folder.name}_{dt.datetime.now():%Y%m%d%H%M%S}"
    folder.rename(target)
    log(f"Папка {folder.name} опубликована полностью и перенесена в {cfg['posted_dir']}/")


def schedule(cfg: dict, state: dict, now: dt.datetime) -> tuple[pathlib.Path | None, list[dict]]:
    """Решить, какая папка сегодня в работе и какие рилсы пора публиковать."""
    tz = now.tzinfo
    today = now.date()
    start, end = at_time(today, cfg["day_start"], tz), at_time(today, cfg["day_end"], tz)
    active = state.get("active")
    folder = None

    if active:
        folder = ROOT / cfg["queue_dir"] / active["folder"]
        if not folder.is_dir():
            log(f"Папка {active['folder']} пропала из очереди, перехожу к следующей.")
            state["active"] = active = folder = None
        elif not folder_items(folder, state):
            finish_folder(cfg, folder)
            state["active"] = active = folder = None

    if active and active["date"] != today.isoformat():
        # остались рилсы со вчера: раскидываем остаток на сегодня
        if now < start:
            return None, []
        names = [i["video"].name for i in folder_items(folder, state)]
        active.update(date=today.isoformat(), plan=make_plan(names, max(now, start), max(end, now)))
        log(f"Папка {folder.name}: переношу {len(names)} оставшихся рилсов на сегодня.")

    if not active:
        if state.get("last_started") == today.isoformat() or not (start <= now < end):
            return None, []
        for candidate in queue_folders(cfg):
            items = folder_items(candidate, state)
            if items:
                folder = candidate
                first = start if now - start < dt.timedelta(hours=1) else now
                plan = make_plan([i["video"].name for i in items], first, end)
                state["active"] = active = {"folder": folder.name, "date": today.isoformat(), "plan": plan}
                state["last_started"] = today.isoformat()
                log(f"Сегодня публикую папку {folder.name}: {len(items)} рилсов, "
                    f"время: {', '.join(t[11:16] for t in plan.values())}")
                break
        else:
            return None, []

    plan = active["plan"]
    due = [i for i in folder_items(folder, state)
           if dt.datetime.fromisoformat(plan.get(i["video"].name, now.isoformat())) <= now]
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
        try:
            me = self._req("GET", f"{self.base}/me", params={"fields": "id,name"})
            log(f"Токен выдан на: {me.get('name')} (тип: Facebook)")
            perms = self._req("GET", f"{self.base}/me/permissions").get("data", [])
            granted = sorted(p["permission"] for p in perms if p.get("status") == "granted")
            log(f"Разрешения токена: {', '.join(granted) or 'нет'}")
            need = {"instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"}
            if need - set(granted):
                log(f"НЕ ХВАТАЕТ разрешений: {', '.join(sorted(need - set(granted)))}")
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

    def permalink(self, media_id: str) -> str:
        try:
            return self._req("GET", f"{self.base}/{media_id}", params={"fields": "permalink"}).get("permalink", "")
        except RuntimeError:
            return ""


# ---------------------------------------------------------------- commands

def cmd_post(args) -> int:
    cfg = load_config()
    state = load_state()
    tz = ZoneInfo(cfg["timezone"])
    now = dt.datetime.fromisoformat(args.now).replace(tzinfo=tz) if args.now else dt.datetime.now(tz)

    if args.dry_run:
        for folder in queue_folders(cfg):
            items = folder_items(folder, state)
            if not items:
                continue
            plan = make_plan([i["video"].name for i in items],
                             at_time(now.date(), cfg["day_start"], tz), at_time(now.date(), cfg["day_end"], tz))
            print(f"=== Папка {folder.name}: {len(items)} рилсов")
            for i in items:
                cover = i["cover"].name if i["cover"] else f"кадр {cfg['thumb_offset_ms']} мс"
                print(f"--- {plan[i['video'].name][11:16]}  {i['video'].name}  (обложка: {cover})\n"
                      f"{build_caption(cfg, i['text'])}\n")
        return 0

    folder, due = schedule(cfg, state, now)
    save_state(state)
    if not due:
        log("Сейчас публиковать нечего.")
        return 0

    token = env("IG_TOKEN")
    mask(token)
    ig = Instagram(token, env("IG_USER_ID", required=False), cfg)
    ig.whoami()
    posted = failed = 0
    for item in due[: int(cfg["max_posts_per_run"])]:
        log(f"→ {item['id']}")
        try:
            caption = build_caption(cfg, item["text"])
            cover_url = cover_url_for(cfg, item["cover"])
            cid = ig.create_reel_container(caption, cover_url, int(cfg["thumb_offset_ms"]),
                                           bool(cfg["share_to_feed"]))
            ig.upload_video(cid, item["video"])
            ig.wait_ready(cid)
            media_id = ig.publish(cid)
        except Exception as e:  # noqa: BLE001
            failed += 1
            log(f"ОШИБКА с {item['id']}: {e}")
            fails = state.setdefault("failures", {})
            fails[item["id"]] = fails.get(item["id"], 0) + 1
            if fails[item["id"]] >= 3:
                state["skipped"][item["id"]] = f"3 неудачные попытки: {str(e)[:300]}"
                log("Ролик пропущен после 3 попыток, смотрите state.json -> skipped.")
            save_state(state)
            if "OAuthException" in str(e) or "access token" in str(e).lower():
                log("Похоже, токен недействителен. Обновите секрет IG_TOKEN.")
                break
            continue
        link = ig.permalink(media_id)
        state["posted"][item["id"]] = {
            "media_id": media_id,
            "permalink": link,
            "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        }
        state.get("failures", {}).pop(item["id"], None)
        save_state(state)
        posted += 1
        log(f"Опубликовано: {link or media_id}")

    if folder and folder.is_dir() and not folder_items(folder, state):
        finish_folder(cfg, folder)
        state["active"] = None
        save_state(state)
    return 1 if failed and not posted else 0


def cmd_check(args) -> int:
    cfg = load_config()
    token = env("IG_TOKEN")
    mask(token)
    ig = Instagram(token, env("IG_USER_ID", required=False), cfg)
    log(f"API: {ig.host}")
    info = ig.whoami()
    log(f"Токен работает. Аккаунт: @{info.get('username')} (id {info.get('id')}, "
        f"тип {info.get('account_type', '?')}, публикаций {info.get('media_count', '?')}), API: {ig.host}")
    return 0


def cmd_refresh(args) -> int:
    token = env("IG_TOKEN")
    mask(token)
    if token.startswith("EAA"):
        app_id, secret = env("FB_APP_ID"), env("FB_APP_SECRET")
        mask(secret)
        r = requests.get("https://graph.facebook.com/oauth/access_token", timeout=60, params={
            "grant_type": "fb_exchange_token", "client_id": app_id,
            "client_secret": secret, "fb_exchange_token": token,
        })
    else:
        r = requests.get("https://graph.instagram.com/refresh_access_token", timeout=60, params={
            "grant_type": "ig_refresh_token", "access_token": token,
        })
    data = r.json()
    if not r.ok or "access_token" not in data:
        log(f"Не удалось продлить токен: {json.dumps(data.get('error', data), ensure_ascii=False)}")
        return 1
    new = data["access_token"]
    mask(new)
    days = int(data.get("expires_in", 0)) // 86400
    log(f"Токен продлён, действует ещё ~{days} дн.")

    pat = os.environ.get("GH_PAT", "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if pat and repo:
        res = subprocess.run(["gh", "secret", "set", "IG_TOKEN", "--repo", repo, "--body", new],
                             env={**os.environ, "GH_TOKEN": pat}, capture_output=True, text=True)
        if res.returncode != 0:
            log(f"Не удалось сохранить токен в GitHub Secrets: {res.stderr.strip()}")
            return 1
        log("Новый токен сохранён в секрет IG_TOKEN.")
    elif new != token:
        log("Токен изменился, но GH_PAT не задан: обновите секрет IG_TOKEN вручную.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Автопостер Reels в Instagram")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("post")
    sp.add_argument("--dry-run", action="store_true")
    sp.add_argument("--now", help="для проверки: подставить время, например 2026-11-03T14:00")
    sp.set_defaults(func=cmd_post)
    sub.add_parser("check").set_defaults(func=cmd_check)
    sub.add_parser("refresh-token").set_defaults(func=cmd_refresh)
    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
