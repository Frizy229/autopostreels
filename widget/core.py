"""Логика виджета без интерфейса: настройки, GitHub, план дня, проверка папки."""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import pathlib
import re

import requests

try:
    import keyring
except ImportError:
    keyring = None

APP = "autopostreels-widget"
REPO = "Frizy229/autopostreels"
BRANCH = "main"
QUEUE = "queue"
POSTED = "posted"
API = "https://api.github.com"
VIDEO_EXT = {".mp4", ".mov"}
ALLOWED_EXT = VIDEO_EXT | {".txt", ".jpg", ".jpeg", ".png", ".srt"}
TZ = dt.timezone(dt.timedelta(hours=3))  # по умолчанию Москва, меняется в настройках
VERSION = "2.0"


def set_tz(hours: int) -> None:
    global TZ
    TZ = dt.timezone(dt.timedelta(hours=hours))
MAX_FILE = 95 * 1024 * 1024  # ограничение GitHub ~100 МБ на файл

CONFIG_PATH = pathlib.Path(os.environ.get("APPDATA", pathlib.Path.home())) / APP / "config.json"


# ---------------------------------------------------------------- настройки и токен

def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def get_token() -> str:
    if keyring:
        try:
            return keyring.get_password(APP, "github") or ""
        except Exception:  # noqa: BLE001
            pass
    return load_config().get("token", "")


def set_token(token: str) -> None:
    if keyring:
        try:
            keyring.set_password(APP, "github", token)
            return
        except Exception:  # noqa: BLE001
            pass
    cfg = load_config()
    cfg["token"] = token
    save_config(cfg)


# ---------------------------------------------------------------- GitHub

class GitHub:
    def __init__(self, token: str, repo: str, branch: str = BRANCH):
        self.repo = repo
        self.branch = branch
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })

    def _r(self, method: str, path: str, **kw):
        r = self.s.request(method, f"{API}/repos/{self.repo}{path}", timeout=600, **kw)
        if r.status_code >= 400:
            try:
                msg = r.json().get("message", r.text)
            except ValueError:
                msg = r.text
            raise RuntimeError(f"GitHub {r.status_code}: {msg}")
        return r.json() if r.content else {}

    def list_dir(self, path: str) -> list[dict]:
        try:
            return self._r("GET", f"/contents/{path}", params={"ref": self.branch})
        except RuntimeError as e:
            if "404" in str(e):
                return []
            raise

    def read_json(self, path: str) -> dict:
        r = self.s.get(f"{API}/repos/{self.repo}/contents/{path}", params={"ref": self.branch},
                       headers={"Accept": "application/vnd.github.raw+json"}, timeout=60)
        if r.status_code == 404:
            return {}
        if r.status_code >= 400:
            raise RuntimeError(f"GitHub {r.status_code}: {r.text[:200]}")
        return json.loads(r.text or "{}")

    def next_number(self) -> int:
        nums = [0]
        for d in (QUEUE, POSTED):
            for item in self.list_dir(d):
                m = re.match(r"(\d+)", item["name"])
                if item["type"] == "dir" and m:
                    nums.append(int(m.group(1)))
        return max(nums) + 1

    def queue_status(self) -> list[tuple[str, int]]:
        """Папки в очереди: (имя, число видео)."""
        out = []
        for item in self.list_dir(QUEUE):
            if item["type"] == "dir":
                files = self.list_dir(f"{QUEUE}/{item['name']}")
                n = sum(1 for f in files if pathlib.Path(f["name"]).suffix.lower() in VIDEO_EXT)
                out.append((item["name"], n))
        return out

    def check(self) -> str:
        """Проверка подключения: вернуть полное имя репозитория или бросить ошибку."""
        r = self._r("GET", "")
        if not r.get("permissions", {}).get("push", False):
            raise RuntimeError("У токена нет права записи (Contents: Read and write).")
        return r["full_name"]

    def blob(self, data: bytes) -> str:
        return self._r("POST", "/git/blobs", json={
            "content": base64.b64encode(data).decode(), "encoding": "base64"})["sha"]

    def commit_files(self, files: dict[str, str], message: str) -> str:
        """files: путь в репозитории -> sha блоба. Один коммит, с повтором при гонке."""
        for _ in range(5):
            ref = self._r("GET", f"/git/ref/heads/{self.branch}")
            head = ref["object"]["sha"]
            base_tree = self._r("GET", f"/git/commits/{head}")["tree"]["sha"]
            tree = self._r("POST", "/git/trees", json={
                "base_tree": base_tree,
                "tree": [{"path": p, "mode": "100644", "type": "blob", "sha": sha} for p, sha in files.items()],
            })["sha"]
            commit = self._r("POST", "/git/commits", json={"message": message, "tree": tree, "parents": [head]})["sha"]
            try:
                self._r("PATCH", f"/git/refs/heads/{self.branch}", json={"sha": commit, "force": False})
                return commit
            except RuntimeError as e:
                if "422" not in str(e):
                    raise
        raise RuntimeError("Не удалось записать коммит: репозиторий постоянно меняется, попробуйте ещё раз.")


def slug(name: str) -> str:
    name = re.sub(r"^\d+[_\- ]*", "", name.strip())  # свой номер убираем, поставим следующий
    name = re.sub(r"[^\w\-]+", "_", name, flags=re.U).strip("_")
    return name or "reels"


# ---------------------------------------------------------------- план дня и результаты

def hhmm(iso: str) -> str:
    return dt.datetime.fromisoformat(iso).astimezone(TZ).strftime("%H:%M")


def today_plan(state: dict, now: dt.datetime) -> list[dict]:
    """Рилсы на сегодня: время, название, статус (done / wait / skipped)."""
    day = now.astimezone(TZ).date().isoformat()
    plan = (state.get("plans") or {}).get(day)
    if not plan and (state.get("active") or {}).get("date") == day:
        plan = state["active"]
    if not plan:
        return []
    rows = []
    for name, when in sorted(plan["plan"].items(), key=lambda kv: kv[1]):
        key = f"{plan['folder']}/{name}"
        posted = state.get("posted", {}).get(key)
        if posted:
            status, shown = "done", hhmm(posted["at"])
        elif key in state.get("skipped", {}):
            status, shown = "skipped", hhmm(when)
        else:
            status, shown = "wait", hhmm(when)
        rows.append({"key": key, "name": name, "time": shown, "status": status,
                     "permalink": (posted or {}).get("permalink", "")})
    return rows


def summary(rows: list[dict]) -> str:
    if not rows:
        return "На сегодня плана нет"
    done = sum(r["status"] == "done" for r in rows)
    waiting = [r for r in rows if r["status"] == "wait"]
    text = f"Сегодня {done} из {len(rows)}"
    if waiting:
        text += f" · дальше в {waiting[0]['time']}"
    elif done == len(rows):
        text += " · день закрыт"
    return text


def results_rows(state: dict, stats: dict, limit: int = 40) -> list[dict]:
    """Результаты по опубликованным рилсам, свежие сверху."""
    items = sorted(state.get("posted", {}).items(), key=lambda kv: kv[1]["at"], reverse=True)[:limit]
    out = []
    for key, info in items:
        st = stats.get(key, {})
        dash = lambda v: "—" if v is None else str(v)  # noqa: E731
        out.append({
            "key": key,
            "name": key.split("/", 1)[-1],
            "when": dt.datetime.fromisoformat(info["at"]).astimezone(TZ).strftime("%d.%m %H:%M"),
            "views": dash(st.get("views")), "likes": dash(st.get("likes")),
            "comments": dash(st.get("comments")), "reach": dash(st.get("reach")),
            "permalink": st.get("permalink") or info.get("permalink", ""),
        })
    return out




# ---------------------------------------------------------------- проверка папки перед загрузкой

IMG_EXT = {".jpg", ".jpeg", ".png"}


def _num(name: str) -> str:
    m = re.search(r"\d+", name)
    return (m.group(0).lstrip("0") or "0") if m else ""


def inspect_folder(folder: pathlib.Path) -> dict:
    """Что лежит в папке: видео, описания, обложки, предупреждения и ошибки."""
    files = [p for p in sorted(folder.iterdir()) if p.is_file() and p.suffix.lower() in ALLOWED_EXT]
    videos = [p for p in files if p.suffix.lower() in VIDEO_EXT]
    images = [p for p in files if p.suffix.lower() in IMG_EXT]
    no_txt, no_cover = [], []
    for v in videos:
        txt = v.with_suffix(".txt")
        if not txt.exists():
            no_txt.append(v.name)
        named = ""
        if txt.exists():
            m = re.search(r"^\s*COVER:\s*(\S+)", txt.read_text(encoding="utf-8-sig", errors="replace"), re.M | re.I)
            named = m.group(1) if m else ""
        num = _num(v.stem)
        has = (
            (named and (folder / named).is_file())
            or any(i.stem == v.stem for i in images)
            or bool(num and any(_num(i.stem) == num for i in images))
        )
        if not has:
            no_cover.append(v.name)
    big = [p.name for p in files if p.stat().st_size > MAX_FILE]
    errors, warnings = [], []
    if not videos:
        errors.append("В папке нет видео (.mp4 или .mov).")
    if big:
        errors.append("Файлы больше 95 МБ GitHub не примет, сожми их: " + ", ".join(big))
    if no_txt:
        warnings.append(f"Без описания: {len(no_txt)} (подпись будет пустой)")
    if no_cover:
        warnings.append(f"Без обложки: {len(no_cover)} (возьмётся кадр из видео)")
    return {
        "files": files, "videos": len(videos), "texts": len(videos) - len(no_txt),
        "covers": len(videos) - len(no_cover), "size": sum(p.stat().st_size for p in files),
        "warnings": warnings, "errors": errors,
    }


def upload_folder(gh: GitHub, folder: pathlib.Path, progress=None) -> str:
    """Загрузить папку в queue/NNN_имя одним коммитом. progress(доля 0..1, текст)."""
    info = inspect_folder(folder)
    if info["errors"]:
        raise RuntimeError(" ".join(info["errors"]))
    name = f"{gh.next_number():03d}_{slug(folder.name)}"
    total = max(info["size"], 1)
    done = 0
    shas: dict[str, str] = {}
    for p in info["files"]:
        if progress:
            progress(done / total, f"{p.name} ({p.stat().st_size / 1e6:.1f} МБ)")
        shas[f"{QUEUE}/{name}/{p.name}"] = gh.blob(p.read_bytes())
        done += p.stat().st_size
    if progress:
        progress(1.0, "Сохраняю…")
    gh.commit_files(shas, f"Новая папка рилсов: {name} ({info['videos']} видео)")
    return name
