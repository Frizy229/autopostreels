"""Виджет автопостера: перетащи папку с рилсами, и она уйдёт в GitHub в queue/.

Одна папка = одно длинное видео = рилсы на один день (mp4 + txt + jpg).
Папка загружается одним коммитом под следующим номером: 002_имя, 003_имя ...
"""
from __future__ import annotations

import base64
import json
import os
import pathlib
import re
import sys
import threading
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk

import requests

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
except ImportError:  # без перетаскивания остаётся кнопка «Выбрать папку»
    TkinterDnD = None

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
    def __init__(self, token: str, repo: str):
        self.repo = repo
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
            return self._r("GET", f"/contents/{path}", params={"ref": BRANCH})
        except RuntimeError as e:
            if "404" in str(e):
                return []
            raise

    def next_number(self) -> int:
        nums = [0]
        for d in (QUEUE, POSTED):
            for item in self.list_dir(d):
                m = re.match(r"(\d+)", item["name"])
                if item["type"] == "dir" and m:
                    nums.append(int(m.group(1)))
        return max(nums) + 1

    def queue_status(self) -> list[str]:
        out = []
        for item in self.list_dir(QUEUE):
            if item["type"] == "dir":
                files = self.list_dir(f"{QUEUE}/{item['name']}")
                n = sum(1 for f in files if pathlib.Path(f["name"]).suffix.lower() in VIDEO_EXT)
                out.append(f"{item['name']}  ({n} видео)")
        return out

    def blob(self, data: bytes) -> str:
        return self._r("POST", "/git/blobs", json={
            "content": base64.b64encode(data).decode(), "encoding": "base64"})["sha"]

    def commit_files(self, files: dict[str, str], message: str) -> str:
        """files: путь в репозитории -> sha блоба. Один коммит, с повтором при гонке."""
        for _ in range(5):
            ref = self._r("GET", f"/git/ref/heads/{BRANCH}")
            head = ref["object"]["sha"]
            base_tree = self._r("GET", f"/git/commits/{head}")["tree"]["sha"]
            tree = self._r("POST", "/git/trees", json={
                "base_tree": base_tree,
                "tree": [{"path": p, "mode": "100644", "type": "blob", "sha": sha} for p, sha in files.items()],
            })["sha"]
            commit = self._r("POST", "/git/commits", json={"message": message, "tree": tree, "parents": [head]})["sha"]
            try:
                self._r("PATCH", f"/git/refs/heads/{BRANCH}", json={"sha": commit, "force": False})
                return commit
            except RuntimeError as e:
                if "422" not in str(e):
                    raise
        raise RuntimeError("Не удалось записать коммит: репозиторий постоянно меняется, попробуйте ещё раз.")


def slug(name: str) -> str:
    name = re.sub(r"^\d+[_\- ]*", "", name.strip())  # свой номер убираем, поставим следующий
    name = re.sub(r"[^\w\-]+", "_", name, flags=re.U).strip("_")
    return name or "reels"


# ---------------------------------------------------------------- окно

class App:
    def __init__(self):
        self.root = TkinterDnD.Tk() if TkinterDnD else tk.Tk()
        self.root.title("Рилсы → Instagram")
        self.root.geometry("420x460")
        self.root.minsize(360, 400)
        cfg = load_config()
        self.repo = cfg.get("repo", REPO)
        self.on_top = tk.BooleanVar(value=cfg.get("on_top", True))
        self.root.attributes("-topmost", self.on_top.get())
        self.busy = False

        pad = {"padx": 12, "pady": 6}
        self.drop = tk.Label(
            self.root, text="Перетащи сюда папку с рилсами\n\n(mp4 + txt + обложки)",
            relief="ridge", bd=2, bg="#f3f4f6", fg="#374151", font=("Segoe UI", 12), height=6, cursor="hand2")
        self.drop.pack(fill="x", **pad)
        self.drop.bind("<Button-1>", lambda e: self.pick_folder())
        if TkinterDnD:
            self.drop.drop_target_register(DND_FILES)
            self.drop.dnd_bind("<<Drop>>", self.on_drop)
        else:
            self.drop.config(text="Нажми, чтобы выбрать папку с рилсами")

        self.progress = ttk.Progressbar(self.root, mode="determinate")
        self.progress.pack(fill="x", **pad)
        self.status = tk.Label(self.root, text="", anchor="w", justify="left", wraplength=390)
        self.status.pack(fill="x", padx=12)

        tk.Label(self.root, text="Очередь на GitHub (по дням):", anchor="w",
                 font=("Segoe UI", 10, "bold")).pack(fill="x", padx=12, pady=(12, 0))
        self.queue = tk.Listbox(self.root, height=8)
        self.queue.pack(fill="both", expand=True, **pad)

        bar = tk.Frame(self.root)
        bar.pack(fill="x", padx=12, pady=(0, 10))
        ttk.Button(bar, text="Обновить", command=self.refresh).pack(side="left")
        ttk.Button(bar, text="Токен GitHub", command=self.ask_token).pack(side="left", padx=6)
        ttk.Checkbutton(bar, text="Поверх окон", variable=self.on_top, command=self.toggle_top).pack(side="right")

        self.root.after(200, self.startup)

    # --- helpers
    def say(self, text: str) -> None:
        self.root.after(0, lambda: self.status.config(text=text))

    def gh(self) -> GitHub | None:
        token = get_token()
        if not token:
            token = self.ask_token()
        return GitHub(token, self.repo) if token else None

    def toggle_top(self):
        self.root.attributes("-topmost", self.on_top.get())
        cfg = load_config()
        cfg["on_top"] = self.on_top.get()
        save_config(cfg)

    def ask_token(self) -> str:
        token = simpledialog.askstring(
            "Токен GitHub",
            "Вставь GitHub токен (Fine-grained, доступ к репозиторию\n"
            f"{self.repo}, право Contents: Read and write):",
            parent=self.root, show="•")
        if token:
            set_token(token.strip())
            self.refresh()
            return token.strip()
        return ""

    def startup(self):
        if not get_token():
            self.ask_token()
        else:
            self.refresh()

    def refresh(self):
        def work():
            try:
                gh = self.gh()
                if not gh:
                    return
                items = gh.queue_status()
                self.root.after(0, lambda: self.show_queue(items))
                self.say("Очередь пустая." if not items else "")
            except Exception as e:  # noqa: BLE001
                self.say(f"Не удалось получить очередь: {e}")
        threading.Thread(target=work, daemon=True).start()

    def show_queue(self, items: list[str]):
        self.queue.delete(0, "end")
        for i in items:
            self.queue.insert("end", i)

    # --- загрузка
    def pick_folder(self):
        from tkinter import filedialog
        path = filedialog.askdirectory(parent=self.root, title="Папка с рилсами")
        if path:
            self.start_upload([path])

    def on_drop(self, event):
        self.start_upload(list(self.root.tk.splitlist(event.data)))

    def start_upload(self, paths: list[str]):
        if self.busy:
            messagebox.showinfo("Подожди", "Предыдущая папка ещё загружается.", parent=self.root)
            return
        folders = [pathlib.Path(p) for p in paths if pathlib.Path(p).is_dir()]
        if not folders:
            messagebox.showwarning("Нужна папка", "Перетащи именно папку, а не отдельные файлы.", parent=self.root)
            return
        self.busy = True
        threading.Thread(target=self.upload_all, args=(folders,), daemon=True).start()

    def upload_all(self, folders: list[pathlib.Path]):
        try:
            gh = self.gh()
            if not gh:
                return
            for folder in folders:
                self.upload(gh, folder)
            self.refresh()
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            self.say(f"Ошибка: {msg}")
            self.root.after(0, lambda: messagebox.showerror("Ошибка", msg, parent=self.root))
        finally:
            self.busy = False

    def upload(self, gh: GitHub, folder: pathlib.Path):
        files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in ALLOWED_EXT)
        videos = [p for p in files if p.suffix.lower() in VIDEO_EXT]
        if not videos:
            raise RuntimeError(f"В папке «{folder.name}» нет видео (.mp4 или .mov).")
        big = [p.name for p in files if p.stat().st_size > MAX_FILE]
        if big:
            raise RuntimeError("Файлы больше 95 МБ GitHub не примет, сожми их:\n" + "\n".join(big))

        self.say("Узнаю номер следующей папки…")
        name = f"{gh.next_number():03d}_{slug(folder.name)}"
        total = sum(p.stat().st_size for p in files)
        done = 0
        shas: dict[str, str] = {}
        for p in files:
            self.say(f"{name}: загружаю {p.name} ({p.stat().st_size / 1e6:.1f} МБ)")
            shas[f"{QUEUE}/{name}/{p.name}"] = gh.blob(p.read_bytes())
            done += p.stat().st_size
            self.root.after(0, lambda v=done * 100 / total: self.progress.config(value=v))
        self.say(f"{name}: сохраняю…")
        gh.commit_files(shas, f"Новая папка рилсов: {name} ({len(videos)} видео)")
        self.say(f"Готово: {name}, {len(videos)} видео в очереди.")

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # чёткий текст на HiDPI
        except Exception:  # noqa: BLE001
            pass
    App().run()
