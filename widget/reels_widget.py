"""Рилсы → Instagram: окно, в которое перетаскивается папка, плюс план дня и результаты.

Одна папка = одно длинное видео = рилсы на один день (mp4 + txt + jpg).
Папка загружается в GitHub одним коммитом под следующим номером: 002_имя, 003_имя ...
"""
from __future__ import annotations

import datetime as dt
import os
import pathlib
import sys
import threading
import webbrowser
from tkinter import filedialog

import customtkinter as ctk

import core
import glass

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
except ImportError:  # без перетаскивания остаётся клик по зоне
    TkinterDnD = None
    DND_FILES = None

DEMO = bool(os.environ.get("REELS_WIDGET_DEMO"))
FONT = "Segoe UI" if sys.platform == "win32" else "DejaVu Sans"

# (светлая тема, тёмная тема)
BG = ("#eef0f6", "#0d0f14")
CARD = ("#ffffff", "#171a22")
CARD2 = ("#f3f4f9", "#1f232d")
BORDER = ("#dfe2ec", "#2a2f3b")
TEXT = ("#14171f", "#eef0f6")
MUTED = ("#6b7385", "#8d95a9")
ACCENT = ("#5b5ef0", "#6d70f5")
ACCENT_HOVER = ("#4a4de0", "#7c7ff7")
OK = ("#16a34a", "#4ade80")
WARN = ("#d97706", "#fbbf24")
ERR = ("#dc2626", "#f87171")
CHIPS = {
    "done": (("#dcfce7", "#12301d"), OK, "вышел"),
    "wait": (("#fef3c7", "#33280f"), WARN, "ждёт"),
    "skipped": (("#fee2e2", "#3a1a1a"), ERR, "пропущен"),
}

DEFAULTS = {
    "repo": core.REPO, "branch": core.BRANCH, "theme": "Тёмная", "scale": 100, "on_top": True,
    "refresh_min": 5, "auto_upload": False, "tz": 3, "glass": "acrylic", "alpha": 94,
}
THEMES = {"Системная": "system", "Тёмная": "dark", "Светлая": "light"}
TZ_CHOICES = {f"UTC{h:+d}" + (" (Москва)" if h == 3 else ""): h for h in range(2, 11)}
SCALES = ("90%", "100%", "115%", "130%")
_BASES = (ctk.CTk, TkinterDnD.DnDWrapper) if TkinterDnD else (ctk.CTk,)


def font(size: int = 13, weight: str = "normal") -> ctk.CTkFont:
    return ctk.CTkFont(family=FONT, size=size, weight=weight)


def human_size(n: int) -> str:
    return f"{n / 1e6:.0f} МБ" if n < 1e9 else f"{n / 1e9:.1f} ГБ"


def plural(n: int, one: str, few: str, many: str) -> str:
    n10, n100 = n % 10, n % 100
    word = one if n10 == 1 and n100 != 11 else few if 2 <= n10 <= 4 and not 12 <= n100 <= 14 else many
    return f"{n} {word}"


def demo_data() -> tuple[list, dict, dict]:
    """Данные для скриншотов и проверки вида без сети."""
    now = dt.datetime.now(core.TZ)
    day = now.date().isoformat()
    base = now.replace(hour=10, minute=0, second=0, microsecond=0)
    plan = {f"short-{i}.mp4": (base + dt.timedelta(hours=4 * k)).isoformat() for k, i in enumerate((4, 5, 6, 7))}
    state = {
        "plans": {day: {"folder": "001_bunker", "plan": plan}},
        "posted": {
            "001_bunker/short-4.mp4": {"media_id": "1", "permalink": "https://instagram.com/", "at": base.isoformat()},
            "000_old/short-1.mp4": {"media_id": "2", "permalink": "", "at": (base - dt.timedelta(days=1)).isoformat()},
        },
        "skipped": {"001_bunker/short-5.mp4": "x"},
    }
    stats = {"001_bunker/short-4.mp4": {"views": 1897, "likes": 52, "comments": 4},
             "000_old/short-1.mp4": {"views": 12400, "likes": 310, "comments": 27}}
    return [("002_interview", 6), ("003_podcast", 7)], state, stats


class App(*_BASES):
    def __init__(self):
        super().__init__()
        if TkinterDnD:
            self.TkdndVersion = TkinterDnD._require(self)
        self.cfg = {**DEFAULTS, **core.load_config()}
        core.set_tz(int(self.cfg["tz"]))
        ctk.set_appearance_mode(THEMES.get(self.cfg["theme"], "dark"))
        ctk.set_widget_scaling(self.cfg["scale"] / 100)
        self.title("Рилсы → Instagram")
        self.geometry("480x780")
        self.minsize(430, 560)
        self.busy = False
        self.pending: list[pathlib.Path] = []
        self.next_num = 1
        self.today_open = False
        self.after_id = None
        self.last_state: dict = {}
        self.last_stats: dict = {}
        self.view = "План"
        self.settings_win = None
        self.build()
        self.apply_glass()
        if TkinterDnD:
            self.drop_target_register(DND_FILES)
            self.dnd_bind("<<Drop>>", self.on_drop)
            self.dnd_bind("<<DropEnter>>", lambda e: self.drop_zone.configure(border_color=ACCENT))
            self.dnd_bind("<<DropLeave>>", lambda e: self.drop_zone.configure(border_color=BORDER))
        self.after(250, self.startup)

    # ------------------------------------------------------------ вид

    def card(self, parent) -> ctk.CTkFrame:
        return ctk.CTkFrame(parent, fg_color=CARD, border_color=BORDER, border_width=1, corner_radius=18)

    def build(self):
        self.scroll = ctk.CTkScrollableFrame(self, fg_color=BG)
        self.scroll.pack(fill="both", expand=True, padx=2, pady=2)
        self.body = ctk.CTkFrame(self.scroll, fg_color="transparent")
        self.body.pack(fill="both", expand=True, padx=12, pady=8)

        # шапка
        head = ctk.CTkFrame(self.body, fg_color="transparent")
        head.pack(fill="x", pady=(0, 12))
        ctk.CTkLabel(head, text="Рилсы → Instagram", font=font(20, "bold"), text_color=TEXT).pack(side="left")
        ctk.CTkButton(head, text="⚙", width=36, height=36, corner_radius=12, fg_color=CARD, hover_color=CARD2,
                      border_width=1, border_color=BORDER, text_color=TEXT, font=font(16),
                      command=self.open_settings).pack(side="right")
        self.conn = ctk.CTkLabel(head, text="● не подключено", font=font(12), text_color=MUTED)
        self.conn.pack(side="right", padx=10)

        # зона для папки
        self.drop_zone = ctk.CTkFrame(self.body, fg_color=CARD, border_color=BORDER, border_width=2,
                                      corner_radius=22, height=150)
        self.drop_zone.pack(fill="x")
        self.drop_zone.pack_propagate(False)
        inner = ctk.CTkFrame(self.drop_zone, fg_color="transparent")
        inner.place(relx=0.5, rely=0.5, anchor="center")
        self.drop_title = ctk.CTkLabel(inner, text="Перетащи папку с рилсами", font=font(17, "bold"), text_color=TEXT)
        self.drop_title.pack()
        self.drop_sub = ctk.CTkLabel(inner, text="видео, описания и обложки, всё в одной папке",
                                     font=font(12), text_color=MUTED)
        self.drop_sub.pack(pady=(2, 10))
        self.pick_btn = ctk.CTkButton(inner, text="Выбрать папку", width=150, height=34, corner_radius=12,
                                      fg_color=ACCENT, hover_color=ACCENT_HOVER, text_color="white",
                                      font=font(13, "bold"), command=self.pick_folder)
        self.pick_btn.pack()

        # предпросмотр перед загрузкой
        self.preview = self.card(self.body)
        self.pv_title = ctk.CTkLabel(self.preview, text="", font=font(15, "bold"), text_color=TEXT, anchor="w")
        self.pv_title.pack(fill="x", padx=16, pady=(14, 0))
        self.pv_counts = ctk.CTkLabel(self.preview, text="", font=font(12), text_color=MUTED, anchor="w",
                                      justify="left", wraplength=390)
        self.pv_counts.pack(fill="x", padx=16, pady=(2, 0))
        self.pv_notes = ctk.CTkLabel(self.preview, text="", font=font(12), anchor="w", justify="left", wraplength=390)
        self.pv_notes.pack(fill="x", padx=16, pady=(6, 0))
        self.pv_bar = ctk.CTkProgressBar(self.preview, height=8, corner_radius=4, progress_color=ACCENT)
        self.pv_bar.set(0)
        self.pv_status = ctk.CTkLabel(self.preview, text="", font=font(12), text_color=MUTED, anchor="w",
                                      justify="left", wraplength=390)
        self.pv_buttons = ctk.CTkFrame(self.preview, fg_color="transparent")
        self.pv_buttons.pack(fill="x", padx=16, pady=14)
        self.pv_go = ctk.CTkButton(self.pv_buttons, text="Загрузить в очередь", height=36, corner_radius=12,
                                   fg_color=ACCENT, hover_color=ACCENT_HOVER, text_color="white",
                                   font=font(13, "bold"), command=self.start_upload)
        self.pv_go.pack(side="left", expand=True, fill="x")
        self.pv_skip = ctk.CTkButton(self.pv_buttons, text="Отмена", width=90, height=36, corner_radius=12,
                                     fg_color=CARD2, hover_color=BORDER, text_color=TEXT, font=font(13),
                                     command=self.skip_pending)
        self.pv_skip.pack(side="left", padx=(8, 0))

        # сегодня
        self.today = self.card(self.body)
        self.today.pack(fill="x", pady=(12, 0))
        self.today_head = ctk.CTkFrame(self.today, fg_color="transparent", cursor="hand2")
        self.today_head.pack(fill="x", padx=16, pady=14)
        self.today_arrow = ctk.CTkLabel(self.today_head, text="▾", font=font(14), text_color=MUTED, cursor="hand2")
        self.today_arrow.pack(side="right")
        self.today_sum = ctk.CTkLabel(self.today_head, text="Сегодня", font=font(14, "bold"), text_color=TEXT,
                                      anchor="w", cursor="hand2")
        self.today_sum.pack(side="left")
        for w in (self.today_head, self.today_sum, self.today_arrow):
            w.bind("<Button-1>", lambda e: self.toggle_today())
        self.today_body = ctk.CTkFrame(self.today, fg_color="transparent")
        self.seg = ctk.CTkSegmentedButton(self.today_body, values=["План", "Результаты"], command=self.set_view,
                                          font=font(12, "bold"), corner_radius=10, selected_color=ACCENT,
                                          selected_hover_color=ACCENT_HOVER, unselected_color=CARD2,
                                          unselected_hover_color=BORDER, text_color=TEXT)
        self.seg.set("План")
        self.seg.pack(fill="x", padx=16, pady=(0, 8))
        self.list_frame = ctk.CTkScrollableFrame(self.today_body, fg_color="transparent", height=210)
        self.list_frame.pack(fill="x", padx=8, pady=(0, 10))

        # очередь
        self.queue = self.card(self.body)
        self.queue.pack(fill="x", pady=(12, 0))
        qh = ctk.CTkFrame(self.queue, fg_color="transparent")
        qh.pack(fill="x", padx=16, pady=(14, 4))
        ctk.CTkLabel(qh, text="Очередь публикаций", font=font(14, "bold"), text_color=TEXT).pack(side="left")
        self.queue_count = ctk.CTkLabel(qh, text="", font=font(12), text_color=MUTED)
        self.queue_count.pack(side="right")
        self.queue_list = ctk.CTkScrollableFrame(self.queue, fg_color="transparent", height=140)
        self.queue_list.pack(fill="x", padx=8, pady=(0, 10))

        # подвал
        foot = ctk.CTkFrame(self.body, fg_color="transparent")
        foot.pack(fill="x", pady=(10, 0))
        self.updated = ctk.CTkLabel(foot, text="", font=font(11), text_color=MUTED)
        self.updated.pack(side="left")
        ctk.CTkButton(foot, text="Обновить", width=80, height=26, corner_radius=8, fg_color="transparent",
                      hover_color=CARD2, text_color=ACCENT, font=font(12, "bold"), command=self.refresh
                      ).pack(side="right")
        self.status = ctk.CTkLabel(foot, text="", font=font(11), text_color=MUTED, anchor="e",
                                   wraplength=240, justify="right")
        self.status.pack(side="right", padx=8)
        for w in (self.drop_zone, self.drop_title, self.drop_sub):
            w.bind("<Button-1>", lambda e: self.pick_folder())

    def apply_glass(self):
        """Стекло: размытие фона и полупрозрачность. Вне Windows ничего не меняет."""
        dark = ctk.get_appearance_mode() == "Dark"
        active = glass.apply(self, self.cfg["glass"], dark, self.cfg["alpha"] / 100)
        bg = glass.KEY_COLOR if active else BG
        self.configure(fg_color=bg)
        self.scroll.configure(fg_color=bg)
        self.attributes("-topmost", bool(self.cfg["on_top"]))

    def say(self, text: str, color=MUTED) -> None:
        self.after(0, lambda: self.status.configure(text=text, text_color=color))

    # ------------------------------------------------------------ сегодня и очередь

    def toggle_today(self):
        self.today_open = not self.today_open
        if self.today_open:
            self.today_body.pack(fill="x", padx=2, pady=(0, 6))
        else:
            self.today_body.pack_forget()
        self.today_arrow.configure(text="▴" if self.today_open else "▾")
        self.render_list()

    def set_view(self, value: str):
        self.view = value
        self.render_list()

    def show_today(self, state: dict, stats: dict):
        self.last_state, self.last_stats = state, stats
        rows = core.today_plan(state, dt.datetime.now(dt.timezone.utc))
        self.today_sum.configure(text=core.summary(rows))
        self.render_list()

    @staticmethod
    def clear(frame):
        for w in frame.winfo_children():
            w.destroy()

    def render_list(self):
        if not self.today_open:
            return
        self.clear(self.list_frame)
        if self.view == "План":
            rows = core.today_plan(self.last_state, dt.datetime.now(dt.timezone.utc))
            if not rows:
                self.empty(self.list_frame, "На сегодня плана нет.\nПлан появится, когда начнётся день публикаций.")
            for r in rows:
                self.plan_row(r)
        else:
            rows = core.results_rows(self.last_state, self.last_stats)
            if not rows:
                self.empty(self.list_frame, "Пока нет опубликованных рилсов.")
            else:
                self.results_header()
            for r in rows:
                self.result_row(r)

    @staticmethod
    def empty(parent, text: str):
        ctk.CTkLabel(parent, text=text, font=font(12), text_color=MUTED, justify="center").pack(pady=26)

    def row_frame(self, parent) -> ctk.CTkFrame:
        row = ctk.CTkFrame(parent, fg_color=CARD2, corner_radius=12)
        row.pack(fill="x", padx=6, pady=3)
        return row

    @staticmethod
    def make_link(url: str, *widgets):
        if not url:
            return
        for w in widgets:
            w.configure(cursor="hand2")
            w.bind("<Button-1>", lambda e, u=url: webbrowser.open(u))

    def plan_row(self, r: dict):
        row = self.row_frame(self.list_frame)
        a = ctk.CTkLabel(row, text=r["time"], font=font(14, "bold"), text_color=TEXT, width=52)
        a.pack(side="left", padx=(12, 6), pady=9)
        b = ctk.CTkLabel(row, text=r["name"], font=font(12), text_color=TEXT, anchor="w")
        b.pack(side="left", fill="x", expand=True)
        bg, fg, label = CHIPS[r["status"]]
        c = ctk.CTkLabel(row, text=label, font=font(11, "bold"), text_color=fg, fg_color=bg, corner_radius=9,
                         width=70, height=22)
        c.pack(side="right", padx=10)
        self.make_link(r["permalink"], row, a, b, c)

    def results_header(self):
        h = ctk.CTkFrame(self.list_frame, fg_color="transparent")
        h.pack(fill="x", padx=12)
        for text, w in (("Комм.", 52), ("Лайки", 52), ("Просмотры", 76)):
            ctk.CTkLabel(h, text=text, font=font(10), text_color=MUTED, width=w, anchor="e").pack(side="right")

    def result_row(self, r: dict):
        row = self.row_frame(self.list_frame)
        col = ctk.CTkFrame(row, fg_color="transparent")
        col.pack(side="left", fill="x", expand=True, padx=(12, 0), pady=7)
        n = ctk.CTkLabel(col, text=r["name"], font=font(12, "bold"), text_color=TEXT, anchor="w")
        n.pack(fill="x")
        d = ctk.CTkLabel(col, text=r["when"], font=font(10), text_color=MUTED, anchor="w")
        d.pack(fill="x")
        nums = []
        for key, w in (("comments", 52), ("likes", 52), ("views", 76)):
            lbl = ctk.CTkLabel(row, text=r[key], font=font(13, "bold"), text_color=TEXT, width=w, anchor="e")
            lbl.pack(side="right")
            nums.append(lbl)
        ctk.CTkLabel(row, text="", width=6).pack(side="right")
        self.make_link(r["permalink"], row, col, n, d, *nums)

    def show_queue(self, items: list[tuple[str, int]], next_num: int):
        self.next_num = next_num
        self.queue_count.configure(text=plural(len(items), "папка", "папки", "папок") if items else "")
        self.clear(self.queue_list)
        if not items:
            self.empty(self.queue_list, "Очередь пустая.\nПеретащи папку, чтобы добавить рилсы.")
        for name, n in items:
            row = ctk.CTkFrame(self.queue_list, fg_color=CARD2, corner_radius=12)
            row.pack(fill="x", padx=6, pady=3)
            ctk.CTkLabel(row, text=name, font=font(13, "bold"), text_color=TEXT, anchor="w").pack(
                side="left", padx=12, pady=9)
            ctk.CTkLabel(row, text=plural(n, "рилс", "рилса", "рилсов"), font=font(11, "bold"), text_color=ACCENT,
                         fg_color=("#e4e5fd", "#23254a"), corner_radius=9, height=22, width=70).pack(side="right", padx=10)

    # ------------------------------------------------------------ данные

    def gh(self) -> core.GitHub | None:
        token = core.get_token()
        if not token:
            self.after(0, self.open_settings)
            return None
        return core.GitHub(token, self.cfg["repo"], self.cfg["branch"])

    def startup(self):
        if not DEMO and not core.get_token():
            self.open_settings()
        self.refresh()
        self.schedule_refresh()

    def schedule_refresh(self):
        if self.after_id:
            self.after_cancel(self.after_id)
            self.after_id = None
        minutes = int(self.cfg["refresh_min"])
        if minutes > 0:
            self.after_id = self.after(minutes * 60 * 1000, self.tick)

    def tick(self):
        if not self.busy:
            self.refresh()
        self.schedule_refresh()

    def refresh(self):
        def work():
            try:
                if DEMO:
                    items, state, stats = demo_data()
                    nxt = 4
                else:
                    gh = self.gh()
                    if not gh:
                        return
                    items, state, stats = gh.queue_status(), gh.read_json("state.json"), gh.read_json("stats.json")
                    nxt = gh.next_number()
                stamp = dt.datetime.now().strftime("Обновлено %H:%M")
                self.after(0, lambda: self.apply_data(items, state, stats, nxt, stamp))
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                self.after(0, lambda: self.conn.configure(text="● нет связи", text_color=ERR))
                self.say(f"Не удалось обновить: {msg[:140]}", ERR)
        threading.Thread(target=work, daemon=True).start()

    def apply_data(self, items, state, stats, nxt, stamp):
        self.conn.configure(text="● подключено", text_color=OK)
        self.updated.configure(text=stamp)
        self.show_queue(items, nxt)
        self.show_today(state, stats)
        if not self.busy:
            self.status.configure(text="")

    # ------------------------------------------------------------ загрузка папки

    def pick_folder(self):
        path = filedialog.askdirectory(parent=self, title="Папка с рилсами")
        if path:
            self.add_pending([pathlib.Path(path)])

    def on_drop(self, event):
        self.drop_zone.configure(border_color=BORDER)
        paths = [pathlib.Path(p) for p in self.tk.splitlist(event.data)]
        folders = [p for p in paths if p.is_dir()]
        if not folders:
            self.say("Перетащи именно папку, а не отдельные файлы.", WARN)
            return
        self.add_pending(folders)

    def add_pending(self, folders: list[pathlib.Path]):
        if self.busy:
            self.say("Подожди, предыдущая папка ещё загружается.", WARN)
            return
        self.pending.extend(folders)
        self.show_pending()

    def show_pending(self):
        if not self.pending:
            self.preview.pack_forget()
            return
        folder = self.pending[0]
        info = core.inspect_folder(folder)
        name = f"{self.next_num:03d}_{core.slug(folder.name)}"
        more = f"  ·  ещё {len(self.pending) - 1} в ожидании" if len(self.pending) > 1 else ""
        self.pv_title.configure(text=f"queue/{name}")
        self.pv_counts.configure(
            text=f"{plural(info['videos'], 'видео', 'видео', 'видео')}  ·  описаний {info['texts']}  ·  "
                 f"обложек {info['covers']}  ·  {human_size(info['size'])}{more}")
        notes = [("✗ " + e, ERR) for e in info["errors"]] + [("! " + w, WARN) for w in info["warnings"]]
        if not notes:
            notes = [("✓ Всё на месте", OK)]
        self.pv_notes.configure(text="\n".join(t for t, _ in notes), text_color=notes[0][1])
        self.pv_go.configure(state="disabled" if info["errors"] else "normal", text="Загрузить в очередь")
        self.pv_skip.configure(state="normal")
        self.pv_bar.pack_forget()
        self.pv_status.pack_forget()
        self.preview.pack(fill="x", pady=(12, 0), after=self.drop_zone)
        if self.cfg["auto_upload"] and not info["errors"]:
            self.start_upload()

    def skip_pending(self):
        if self.pending:
            self.pending.pop(0)
        self.show_pending()

    def start_upload(self):
        if self.busy or not self.pending:
            return
        self.busy = True
        folder = self.pending[0]
        self.pv_go.configure(state="disabled", text="Загружаю…")
        self.pv_skip.configure(state="disabled")
        self.pv_bar.set(0)
        self.pv_bar.pack(fill="x", padx=16, pady=(8, 0), before=self.pv_buttons)
        self.pv_status.pack(fill="x", padx=16, before=self.pv_buttons)
        threading.Thread(target=self.upload_work, args=(folder,), daemon=True).start()

    def upload_work(self, folder: pathlib.Path):
        def progress(frac: float, text: str):
            self.after(0, lambda: (self.pv_bar.set(frac), self.pv_status.configure(text=text, text_color=MUTED)))
        try:
            gh = self.gh()
            if not gh:
                raise RuntimeError("Не задан токен GitHub (Настройки → Подключение).")
            name = core.upload_folder(gh, folder, progress)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            self.after(0, lambda: self.upload_failed(msg))
            return
        self.after(0, lambda: self.upload_done(name))

    def upload_failed(self, msg: str):
        self.busy = False
        self.pv_status.configure(text=msg[:300], text_color=ERR)
        self.pv_go.configure(state="normal", text="Повторить")
        self.pv_skip.configure(state="normal")

    def upload_done(self, name: str):
        self.busy = False
        self.say(f"Готово: {name} в очереди.", OK)
        if self.pending:
            self.pending.pop(0)
        self.refresh()
        self.show_pending()

    # ------------------------------------------------------------ настройки

    def save_cfg(self):
        core.save_config({k: v for k, v in self.cfg.items() if k != "token"})

    def open_settings(self):
        if self.settings_win and self.settings_win.winfo_exists():
            self.settings_win.focus()
            return
        win = ctk.CTkToplevel(self, fg_color=BG)
        self.settings_win = win
        win.title("Настройки")
        win.geometry(f"460x600+{self.winfo_x() + 40}+{self.winfo_y() + 30}")
        win.resizable(False, False)
        win.transient(self)
        win.attributes("-topmost", bool(self.cfg["on_top"]))
        ctk.CTkLabel(win, text="Настройки", font=font(18, "bold"), text_color=TEXT).pack(anchor="w", padx=20, pady=(16, 6))
        tabs = ctk.CTkTabview(win, fg_color=CARD, corner_radius=16, border_width=1, border_color=BORDER,
                              segmented_button_selected_color=ACCENT, segmented_button_selected_hover_color=ACCENT_HOVER,
                              segmented_button_unselected_color=CARD2, segmented_button_unselected_hover_color=BORDER,
                              text_color=TEXT)
        tabs.pack(fill="both", expand=True, padx=16, pady=(0, 16))
        for t in ("Подключение", "Вид", "Работа", "О программе"):
            tabs.add(t)
        self.tab_connection(tabs.tab("Подключение"))
        self.tab_look(tabs.tab("Вид"))
        self.tab_behavior(tabs.tab("Работа"))
        self.tab_about(tabs.tab("О программе"))
        win.after(200, win.focus)

    @staticmethod
    def label(parent, text: str, muted: bool = False, size: int = 13, bold: bool = False):
        ctk.CTkLabel(parent, text=text, font=font(size, "bold" if bold else "normal"),
                     text_color=MUTED if muted else TEXT, anchor="w", justify="left", wraplength=370
                     ).pack(fill="x", padx=14, pady=(2, 0) if muted else (12, 0))

    @staticmethod
    def entry(parent, value: str = "", show: str = "") -> ctk.CTkEntry:
        e = ctk.CTkEntry(parent, height=34, corner_radius=10, fg_color=CARD2, border_color=BORDER, text_color=TEXT,
                         font=font(12), show=show)
        e.insert(0, value)
        e.pack(fill="x", padx=14, pady=(4, 0))
        return e

    @staticmethod
    def menu(parent, values, current, command) -> ctk.CTkOptionMenu:
        m = ctk.CTkOptionMenu(parent, values=list(values), height=34, corner_radius=10, fg_color=CARD2,
                              button_color=ACCENT, button_hover_color=ACCENT_HOVER, text_color=TEXT,
                              dropdown_fg_color=CARD, dropdown_text_color=TEXT, font=font(12), command=command)
        m.set(current)
        m.pack(fill="x", padx=14, pady=(6, 0))
        return m

    @staticmethod
    def segmented(parent, values, current, command) -> ctk.CTkSegmentedButton:
        s = ctk.CTkSegmentedButton(parent, values=list(values), font=font(12), selected_color=ACCENT,
                                   selected_hover_color=ACCENT_HOVER, unselected_color=CARD2,
                                   unselected_hover_color=BORDER, text_color=TEXT, command=command)
        s.set(current)
        s.pack(fill="x", padx=14, pady=(6, 0))
        return s

    def switch(self, parent, text: str, key: str, after=None):
        sw = ctk.CTkSwitch(parent, text=text, font=font(13), text_color=TEXT, progress_color=ACCENT,
                           command=lambda: self.set_cfg(key, bool(sw.get()), after))
        sw.pack(anchor="w", padx=14, pady=(16, 0))
        if self.cfg[key]:
            sw.select()

    def tab_connection(self, tab):
        self.label(tab, "Репозиторий GitHub", bold=True)
        repo = self.entry(tab, self.cfg["repo"])
        self.label(tab, "Ветка")
        branch = self.entry(tab, self.cfg["branch"])
        self.label(tab, "Токен GitHub")
        token = self.entry(tab, "", show="•")
        token.configure(placeholder_text="сохранён: оставь пустым, чтобы не менять" if core.get_token() else "вставь токен")
        self.label(tab, "Fine-grained токен только на этот репозиторий с правом Contents: Read and write. "
                        "Хранится в диспетчере учётных данных Windows.", muted=True, size=11)
        result = ctk.CTkLabel(tab, text="", font=font(12), anchor="w", justify="left", wraplength=370)
        result.pack(fill="x", padx=14, pady=(10, 0))

        def save():
            self.cfg["repo"] = repo.get().strip() or core.REPO
            self.cfg["branch"] = branch.get().strip() or core.BRANCH
            if token.get().strip():
                core.set_token(token.get().strip())
                token.delete(0, "end")
            self.save_cfg()
            result.configure(text="Проверяю…", text_color=MUTED)

            def work():
                try:
                    gh = self.gh()
                    if not gh:
                        raise RuntimeError("Токен не задан.")
                    full = gh.check()
                    self.after(0, lambda: result.configure(text=f"✓ Подключено к {full}, запись разрешена.", text_color=OK))
                    self.refresh()
                except Exception as e:  # noqa: BLE001
                    msg = str(e)
                    self.after(0, lambda: result.configure(text="✗ " + msg[:200], text_color=ERR))
            threading.Thread(target=work, daemon=True).start()

        row = ctk.CTkFrame(tab, fg_color="transparent")
        row.pack(fill="x", padx=14, pady=14)
        ctk.CTkButton(row, text="Сохранить и проверить", height=36, corner_radius=12, fg_color=ACCENT,
                      hover_color=ACCENT_HOVER, text_color="white", font=font(13, "bold"),
                      command=save).pack(side="left", expand=True, fill="x")
        ctk.CTkButton(row, text="Забыть токен", width=110, height=36, corner_radius=12, fg_color=CARD2,
                      hover_color=BORDER, text_color=ERR, font=font(12),
                      command=lambda: (core.set_token(""), result.configure(text="Токен удалён.", text_color=MUTED))
                      ).pack(side="left", padx=(8, 0))

    def tab_look(self, tab):
        self.label(tab, "Тема", bold=True)
        self.segmented(tab, THEMES, self.cfg["theme"], lambda v: self.set_cfg("theme", v, self.apply_theme))

        self.label(tab, "Эффект стекла", bold=True)
        if not glass.supported():
            self.label(tab, "Работает только в Windows 10 и 11.", muted=True, size=11)
        titles = [glass.MODE_TITLES[m] for m in glass.MODES]
        self.menu(tab, titles, glass.MODE_TITLES.get(self.cfg["glass"], titles[0]),
                  lambda t: self.set_cfg("glass", next(k for k, v in glass.MODE_TITLES.items() if v == t),
                                         self.apply_glass))

        self.label(tab, "Прозрачность окна (при включённом стекле)")
        alpha = ctk.CTkSlider(tab, from_=70, to=100, number_of_steps=30, progress_color=ACCENT, button_color=ACCENT,
                              button_hover_color=ACCENT_HOVER,
                              command=lambda v: self.set_cfg("alpha", int(v), self.apply_glass))
        alpha.set(self.cfg["alpha"])
        alpha.pack(fill="x", padx=14, pady=(8, 0))

        self.label(tab, "Размер интерфейса")
        cur = f"{self.cfg['scale']}%"
        self.segmented(tab, SCALES, cur if cur in SCALES else "100%",
                       lambda v: self.set_cfg("scale", int(v[:-1]), self.apply_scale))
        self.switch(tab, "Окно поверх остальных", "on_top", self.apply_glass)

    def tab_behavior(self, tab):
        self.label(tab, "Автообновление данных", bold=True)
        values = {"Выкл": 0, "Каждую минуту": 1, "Каждые 5 минут": 5, "Каждые 15 минут": 15}
        cur = next((k for k, v in values.items() if v == int(self.cfg["refresh_min"])), "Каждые 5 минут")
        self.menu(tab, values, cur, lambda t: self.set_cfg("refresh_min", values[t], self.schedule_refresh))

        self.label(tab, "Часовой пояс для плана и времени публикаций", bold=True)
        cur = next((k for k, v in TZ_CHOICES.items() if v == int(self.cfg["tz"])), "UTC+3 (Москва)")
        self.menu(tab, TZ_CHOICES, cur, lambda t: self.set_cfg("tz", TZ_CHOICES[t], self.apply_tz))
        self.label(tab, "Только отображение. Расписание публикаций задаётся в config.json в репозитории.",
                   muted=True, size=11)

        self.switch(tab, "Загружать сразу после перетаскивания", "auto_upload")
        self.label(tab, "Без этого перед загрузкой показывается предпросмотр с проверкой папки.", muted=True, size=11)

    def tab_about(self, tab):
        self.label(tab, f"Рилсы → Instagram, версия {core.VERSION}", bold=True)
        self.label(tab, "Папка из одного длинного видео превращается в очередь рилсов, "
                        "а автопостер на GitHub публикует их в Instagram в течение дня.", muted=True, size=12)
        repo = self.cfg["repo"]
        for text, url in (("Открыть репозиторий", f"https://github.com/{repo}"),
                          ("Открыть запуски (Actions)", f"https://github.com/{repo}/actions"),
                          ("Страница релизов (обновить виджет)", f"https://github.com/{repo}/releases/tag/widget")):
            ctk.CTkButton(tab, text=text, height=34, corner_radius=10, fg_color=CARD2, hover_color=BORDER,
                          text_color=TEXT, font=font(12), anchor="w",
                          command=lambda u=url: webbrowser.open(u)).pack(fill="x", padx=14, pady=(10, 0))

    def set_cfg(self, key: str, value, after=None):
        self.cfg[key] = value
        self.save_cfg()
        if after:
            after()

    def apply_theme(self):
        ctk.set_appearance_mode(THEMES[self.cfg["theme"]])
        self.after(50, self.apply_glass)

    @staticmethod
    def apply_scale_value(scale: int):
        ctk.set_widget_scaling(scale / 100)

    def apply_scale(self):
        self.apply_scale_value(self.cfg["scale"])

    def apply_tz(self):
        core.set_tz(int(self.cfg["tz"]))
        self.show_today(self.last_state, self.last_stats)


if __name__ == "__main__":
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # чёткий текст на HiDPI
        except Exception:  # noqa: BLE001
            pass
    App().mainloop()
