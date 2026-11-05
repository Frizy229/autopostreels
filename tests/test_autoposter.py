"""Юнит-тесты автопостера: расписание, догон пропущенных слотов, томское время,
несколько аккаунтов, подписи/обложки, повторные попытки. Запуск: python -m unittest discover -s tests -v"""
import argparse
import datetime as dt
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock
from zoneinfo import ZoneInfo

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import autoposter as a  # noqa: E402

TOMSK = ZoneInfo("Asia/Tomsk")


def at(h, m=0, day=4):
    return dt.datetime(2026, 11, day, h, m, tzinfo=TOMSK)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.patches = [
            mock.patch.object(a, "ROOT", self.root),
            mock.patch.object(a, "CONFIG_PATH", self.root / "config.json"),
            mock.patch.object(a, "STATE_PATH", self.root / "state.json"),
            mock.patch.object(a.time, "sleep", lambda s: None),
        ]
        for p in self.patches:
            p.start()
        self.cfg = dict(a.DEFAULT_CONFIG, timezone="Asia/Tomsk")
        a.ACTIVE_ACCOUNTS = [{"name": "one", "token_env": "IG_TOKEN", "user_id_env": "IG_USER_ID", "primary": True, "user_id": ""}]
        self.state = {"posted": {}, "skipped": {}}

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def folder(self, name, videos, txt=None):
        d = self.root / "queue" / name
        d.mkdir(parents=True, exist_ok=True)
        for v in videos:
            (d / v).write_bytes(b"x")
            if txt is not None:
                (d / v).with_suffix(".txt").write_text(txt, encoding="utf-8")
        return d

    def set_accounts(self, *names):
        a.ACTIVE_ACCOUNTS = [{"name": n, "token_env": f"T_{n}", "user_id_env": f"U_{n}", "primary": i == 0, "user_id": ""}
                             for i, n in enumerate(names)]


class PlanTests(Base):
    def test_even_plan_seven(self):
        plan = a.make_plan([f"v{i}" for i in range(7)], at(10), at(22))
        times = [v[11:16] for v in plan.values()]
        self.assertEqual(times, ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"])

    def test_plan_single_item_at_start(self):
        self.assertEqual(a.make_plan(["x"], at(10), at(22))["x"][11:16], "10:00")

    def test_plan_has_tomsk_offset(self):
        self.assertTrue(a.make_plan(["x"], at(10), at(22))["x"].endswith("+07:00"))

    def test_at_time(self):
        self.assertEqual(a.at_time(dt.date(2026, 11, 4), "10:30", TOMSK), at(10, 30))


class ScheduleTests(Base):
    def setUp(self):
        super().setUp()
        self.folder("001_a", [f"{i}.mp4" for i in range(1, 8)])
        self.folder("002_b", ["1.mp4", "2.mp4"])

    def due_names(self, now):
        folder, due = a.schedule(self.cfg, self.state, now)
        return folder, [i["video"].name for i in due]

    def mark(self, *names, folder="001_a"):
        for n in names:
            self.state["posted"][f"{folder}/{n}"] = {"media_id": "1", "at": "x"}

    def test_before_day_start_nothing(self):
        self.assertEqual(self.due_names(at(9, 30)), (None, []))

    def test_start_of_day_first_reel_due(self):
        folder, due = self.due_names(at(10, 5))
        self.assertEqual(folder.name, "001_a")
        self.assertEqual(due, ["1.mp4"])
        self.assertEqual(self.state["last_started"], "2026-11-04")

    def test_catch_up_all_missed_slots(self):
        self.due_names(at(10, 5))                # план создан
        _, due = self.due_names(at(16, 30))      # запусков не было до 16:30: слоты 10,12,14,16 пропущены
        self.assertEqual(due, ["1.mp4", "2.mp4", "3.mp4", "4.mp4"])

    def test_future_slots_not_due(self):
        self.due_names(at(10, 5))
        _, due = self.due_names(at(11, 59))
        self.assertEqual(due, ["1.mp4"])

    def test_posted_not_due_again(self):
        self.due_names(at(10, 5))
        self.mark("1.mp4")
        _, due = self.due_names(at(12, 1))
        self.assertEqual(due, ["2.mp4"])

    def test_late_start_spreads_rest_of_day(self):
        folder, due = self.due_names(at(15, 0))
        plan = self.state["active"]["plan"]
        self.assertEqual(min(plan.values())[11:16], "15:00")
        self.assertEqual(max(plan.values())[11:16], "22:00")
        self.assertEqual(due, ["1.mp4"])

    def test_no_second_folder_same_day(self):
        self.due_names(at(10, 5))
        self.mark(*[f"{i}.mp4" for i in range(1, 8)])
        self.assertEqual(self.due_names(at(20, 0)), (None, []))   # 002_b ждёт завтра

    def test_next_day_takes_next_folder(self):
        self.due_names(at(10, 5))
        self.mark(*[f"{i}.mp4" for i in range(1, 8)])
        a.sweep_finished(self.cfg, self.state)
        self.state["active"] = None
        folder, due = self.due_names(at(10, 2, day=5))
        self.assertEqual(folder.name, "002_b")
        self.assertEqual(due, ["1.mp4"])

    def test_leftover_moves_to_next_day(self):
        self.due_names(at(10, 5))
        self.mark("1.mp4", "2.mp4")
        folder, due = self.due_names(at(10, 3, day=5))
        self.assertEqual(folder.name, "001_a")
        self.assertEqual(self.state["active"]["date"], "2026-11-05")
        self.assertEqual(due, ["3.mp4"])

    def test_after_day_end_no_new_folder(self):
        self.assertEqual(self.due_names(at(22, 30)), (None, []))

    def test_utc_clock_still_tomsk_day(self):
        # 03:30 UTC = 10:30 Томск того же дня
        now = dt.datetime(2026, 11, 4, 3, 30, tzinfo=dt.timezone.utc).astimezone(TOMSK)
        folder, due = self.due_names(now)
        self.assertEqual(self.state["last_started"], "2026-11-04")
        self.assertEqual(due, ["1.mp4"])

    def test_skipped_not_due(self):
        self.due_names(at(10, 5))
        self.state["skipped"]["001_a/1.mp4"] = "x"
        _, due = self.due_names(at(12, 1))
        self.assertEqual(due, ["2.mp4"])


class MultiAccountTests(Base):
    def test_pending_per_account(self):
        self.folder("001_a", ["1.mp4"])
        self.set_accounts("one", "two", "three")
        self.state["posted"]["001_a/1.mp4"] = {"at": "x"}
        item = a.folder_items(self.root / "queue" / "001_a", self.state)[0]
        self.assertEqual([x["name"] for x in item["pending"]], ["two", "three"])

    def test_done_only_when_all_accounts(self):
        self.folder("001_a", ["1.mp4"])
        self.set_accounts("one", "two")
        self.state["posted"]["001_a/1.mp4"] = {"at": "x"}
        a.sweep_finished(self.cfg, self.state)
        self.assertTrue((self.root / "queue" / "001_a").exists())
        self.state["posted_acc"] = {"two": {"001_a/1.mp4": {"at": "y"}}}
        a.sweep_finished(self.cfg, self.state)
        self.assertFalse((self.root / "queue" / "001_a").exists())
        self.assertTrue((self.root / "posted" / "001_a").exists())

    def test_skipped_counts_per_account(self):
        self.folder("001_a", ["1.mp4"])
        self.set_accounts("one", "two")
        self.state["posted"]["001_a/1.mp4"] = {"at": "x"}
        self.state["skipped"]["two|001_a/1.mp4"] = "bad"
        self.assertEqual(a.folder_items(self.root / "queue" / "001_a", self.state), [])

    def test_account_without_secret_is_inactive(self):
        cfg = {"accounts": [{"name": "one"}, {"name": "two", "token_env": "NOPE_TOKEN"}]}
        with mock.patch.dict("os.environ", {}, clear=True):
            accs = a.configure_accounts(cfg)
        self.assertEqual([x["name"] for x in accs], ["one"])

    def test_account_with_secret_from_all_secrets(self):
        cfg = {"accounts": [{"name": "one"}, {"name": "two", "token_env": "TWO_TOKEN", "user_id": "123"}]}
        with mock.patch.dict("os.environ", {"ALL_SECRETS": json.dumps({"TWO_TOKEN": "abc"})}, clear=True):
            accs = a.configure_accounts(cfg)
        self.assertEqual([x["name"] for x in accs], ["one", "two"])
        self.assertTrue(accs[0]["primary"] and not accs[1]["primary"])


class CaptionTests(Base):
    TXT = """TITLE:
t

REELS CAPTION (Instagram @one):
Caption ONE #a

REELS CAPTION (Instagram @two):
Caption TWO #b

COVER: c1.jpg
COVER (Instagram @two): c2.jpg
"""

    def test_blocks(self):
        caps = a.parse_captions(self.TXT)
        self.assertEqual([c[1] for c in caps], ["Caption ONE #a", "Caption TWO #b"])

    def test_caption_for_by_name(self):
        item = {"captions": a.parse_captions(self.TXT), "text": "fallback"}
        self.assertEqual(a.caption_for(item, {"name": "two"}, 1), "Caption TWO #b")
        self.assertEqual(a.caption_for(item, {"name": "one"}, 0), "Caption ONE #a")

    def test_caption_fallback_plain(self):
        txt = "REELS CAPTION (Instagram):\nplain #x\n"
        item = {"captions": a.parse_captions(txt), "text": a.parse_txt(txt)[0]}
        self.assertEqual(a.caption_for(item, {"name": "any"}, 2), "plain #x")

    def test_old_format_unchanged(self):
        txt = "REELS CAPTION (Instagram):\nold one #x\n\nCOVER: c.jpg\n"
        self.assertEqual(a.parse_txt(txt), ("old one #x", "c.jpg"))

    def test_parse_txt_first_block_stops_at_next_block(self):
        self.assertEqual(a.parse_txt(self.TXT), ("Caption ONE #a", "c1.jpg"))

    def test_covers(self):
        self.assertEqual(a.parse_covers(self.TXT), {"two": "c2.jpg"})

    def test_plain_txt(self):
        self.assertEqual(a.parse_txt("just text #x"), ("just text #x", ""))

    def test_hashtag_limit(self):
        cap = a.build_caption(self.cfg, " ".join(f"#t{i}" for i in range(40)))
        self.assertEqual(cap.count("#"), 30)


class SubfolderTests(Base):
    """Папка дня с подпапками по аккаунтам: каждый аккаунт получает только свои рилсы."""

    def setUp(self):
        super().setUp()
        self.set_accounts("dayzerorules", "rulezerosurvivel", "survivelzerorule")
        for acc in ("dayzerorules", "rulezerosurvivel", "survivelzerorule"):
            self.folder(f"001_batch/{acc}", [f"short-{i}.mp4" for i in range(1, 8)],
                        txt=f"REELS CAPTION (Instagram):\ncap {acc}\n")

    def items(self):
        return a.folder_items(self.root / "queue" / "001_batch", self.state)

    def test_items_belong_to_own_account(self):
        items = self.items()
        self.assertEqual(len(items), 21)
        for it in items:
            self.assertEqual([x["name"] for x in it["pending"]], [it["group"]])
        self.assertEqual(items[0]["id"], "001_batch/dayzerorules/short-1.mp4")

    def test_plan_per_account_independent(self):
        plan = a.build_plan(self.items(), at(10), at(22))
        self.assertEqual(len(plan), 21)
        for acc in ("dayzerorules", "rulezerosurvivel", "survivelzerorule"):
            times = [plan[f"{acc}/short-{i}.mp4"][11:16] for i in range(1, 8)]
            self.assertEqual(times, ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"])

    def test_schedule_due_first_slot_three_reels(self):
        folder, due = a.schedule(self.cfg, self.state, at(10, 5))
        self.assertEqual(folder.name, "001_batch")
        self.assertEqual(sorted(i["group"] for i in due), ["dayzerorules", "rulezerosurvivel", "survivelzerorule"])
        self.assertTrue(all(i["video"].name == "short-1.mp4" for i in due))

    def test_unknown_subfolder_ignored(self):
        self.folder("001_batch/stranger", ["x.mp4"])
        self.assertEqual(len(self.items()), 21)

    def test_subfolder_name_with_at_and_suffix(self):
        self.folder("002_b/@dayzerorules", ["a.mp4"])
        self.folder("002_b/rulezerosurvivel_reels", ["b.mp4"])
        items = a.folder_items(self.root / "queue" / "002_b", self.state)
        self.assertEqual(sorted(i["group"] for i in items), ["dayzerorules", "rulezerosurvivel"])

    def test_done_only_when_every_account_finished(self):
        for it in self.items():
            if it["group"] != "survivelzerorule":
                acc = it["pending"][0]
                a.acc_posted(self.state, acc)[it["id"]] = {"at": "x"}
        a.sweep_finished(self.cfg, self.state)
        self.assertTrue((self.root / "queue" / "001_batch").exists())
        for it in self.items():
            a.acc_posted(self.state, it["pending"][0])[it["id"]] = {"at": "x"}
        a.sweep_finished(self.cfg, self.state)
        self.assertFalse((self.root / "queue" / "001_batch").exists())
        self.assertTrue((self.root / "posted" / "001_batch").exists())

    def test_flat_and_subfolders_together(self):
        self.folder("001_batch", ["common.mp4"])
        items = self.items()
        self.assertEqual(len(items), 22)
        flat = [i for i in items if i["group"] == ""][0]
        self.assertEqual(len(flat["pending"]), 3)

    def test_remove_folder(self):
        self.state["active"] = {"folder": "001_batch", "date": "2026-11-04", "plan": {}}
        a.save_state(self.state)
        self.assertEqual(a.cmd_remove(argparse.Namespace(name="001_batch")), 0)
        self.assertFalse((self.root / "queue" / "001_batch").exists())
        self.assertIsNone(a.load_state()["active"])
        self.assertEqual(a.cmd_remove(argparse.Namespace(name="001_batch")), 1)
        self.assertEqual(a.cmd_remove(argparse.Namespace(name="../x")), 1)

    def test_deleted_active_folder_moves_on(self):
        a.schedule(self.cfg, self.state, at(10, 5))
        import shutil
        shutil.rmtree(self.root / "queue" / "001_batch")
        self.folder("002_next", ["1.mp4"])
        a.save_state(self.state)
        folder, due = a.schedule(self.cfg, self.state, at(12, 0))
        self.assertIsNone(folder)  # сегодня уже стартовали, следующая папка завтра


class FakeIG:
    """Подмена Instagram: считает публикации, умеет падать по сценарию."""
    log = []
    fail_upload = {}      # account -> сколько раз упасть с ProcessingFailedError
    fail_always = set()   # account -> всегда ошибка токена

    def __init__(self, token, user_id, cfg):
        self.token = token
        self.base = ""

    def whoami(self):
        return {}

    def create_reel_container(self, caption, cover_url, thumb, share):
        FakeIG.log.append(("container", self.token, caption))
        return "cid"

    def upload_video(self, cid, video):
        if self.token in FakeIG.fail_always:
            raise RuntimeError("OAuthException: Invalid OAuth access token")
        left = FakeIG.fail_upload.get(self.token, 0)
        if left > 0:
            FakeIG.fail_upload[self.token] = left - 1
            raise RuntimeError('Ошибка загрузки видео 400: {"type":"ProcessingFailedError"}')

    def wait_ready(self, cid):
        pass

    def publish(self, cid):
        FakeIG.log.append(("publish", self.token))
        return f"m{len(FakeIG.log)}"

    def permalink(self, mid):
        return f"https://ig/{mid}"


class PostBase(Base):
    def setUp(self):
        super().setUp()
        FakeIG.log, FakeIG.fail_upload, FakeIG.fail_always = [], {}, set()
        (self.root / "config.json").write_text(json.dumps({
            "timezone": "Asia/Tomsk",
            "accounts": [{"name": "one", "token_env": "T1"}, {"name": "two", "token_env": "T2", "user_id": "9"}]}))
        self.env = mock.patch.dict("os.environ", {"T1": "tok1", "T2": "tok2"}, clear=True)
        self.env.start()
        a.configure_accounts(a.load_config())
        self.p1 = mock.patch.object(a, "Instagram", FakeIG)
        self.p2 = mock.patch.object(a, "cover_url_for", lambda cfg, c: "")
        self.p1.start(); self.p2.start()

    def tearDown(self):
        self.p1.stop(); self.p2.stop(); self.env.stop()
        super().tearDown()

    def run_post(self, now, **kw):
        ns = argparse.Namespace(dry_run=False, only=kw.get("only"), now=now.replace(tzinfo=None).isoformat())
        return a.cmd_post(ns)

    def state_now(self):
        return a.load_state()


class PostTests(PostBase):
    def setUp(self):
        super().setUp()
        self.folder("001_a", ["1.mp4", "2.mp4", "3.mp4"],
                    txt="REELS CAPTION (Instagram @one):\nC-one\n\nREELS CAPTION (Instagram @two):\nC-two\n")

    def test_posts_to_all_accounts_with_own_captions(self):
        self.run_post(at(10, 5))
        pubs = [e for e in FakeIG.log if e[0] == "publish"]
        self.assertEqual([p[1] for p in pubs], ["tok1", "tok2"])
        caps = {e[1]: e[2] for e in FakeIG.log if e[0] == "container"}
        self.assertEqual(caps["tok1"], "C-one")
        self.assertEqual(caps["tok2"], "C-two")
        st = self.state_now()
        self.assertIn("001_a/1.mp4", st["posted"])
        self.assertIn("001_a/1.mp4", st["posted_acc"]["two"])

    def test_catch_up_in_one_run(self):
        self.run_post(at(10, 5))
        FakeIG.log.clear()
        self.run_post(at(22, 30))      # слоты 12:00 и 16:00 пропущены
        pubs = [e for e in FakeIG.log if e[0] == "publish"]
        self.assertEqual(len(pubs), 4)  # 2 рилса x 2 аккаунта

    def test_retry_processing_failed(self):
        FakeIG.fail_upload["tok2"] = 2
        self.run_post(at(10, 5))
        self.assertIn("001_a/1.mp4", self.state_now()["posted_acc"]["two"])

    def test_gives_up_after_three_runs_and_skips(self):
        FakeIG.fail_upload["tok2"] = 99
        for _ in range(3):
            self.run_post(at(10, 5))
        st = self.state_now()
        self.assertIn("two|001_a/1.mp4", st["skipped"])
        self.assertIn("001_a/1.mp4", st["posted"])      # первый аккаунт не пострадал

    def test_dead_token_does_not_block_other_account(self):
        FakeIG.fail_always.add("tok1")
        self.run_post(at(10, 5))
        st = self.state_now()
        self.assertNotIn("001_a/1.mp4", st["posted"])
        self.assertIn("001_a/1.mp4", st["posted_acc"]["two"])

    def test_only_mode_posts_requested_reel(self):
        self.run_post(at(10, 5), only="2.mp4")
        st = self.state_now()
        self.assertIn("001_a/2.mp4", st["posted"])
        self.assertNotIn("001_a/1.mp4", st["posted"])

    def test_folder_moves_to_posted_when_done(self):
        for hour in (10, 16, 22):
            self.run_post(at(hour, 5))
        self.assertTrue((self.root / "posted" / "001_a").exists())
        self.assertFalse((self.root / "queue" / "001_a").exists())

    def test_nothing_to_do_outside_window(self):
        self.assertEqual(self.run_post(at(23, 30)), 0)
        self.assertEqual(FakeIG.log, [])

    def test_idempotent_second_run_same_time(self):
        self.run_post(at(10, 5))
        n = len(FakeIG.log)
        self.run_post(at(10, 6))
        self.assertEqual(len(FakeIG.log), n)


class PostSubfolderTests(PostBase):
    def setUp(self):
        super().setUp()
        for acc in ("one", "two"):
            self.folder(f"001_b/{acc}", ["1.mp4", "2.mp4"], txt=f"REELS CAPTION (Instagram):\nC-{acc}\n")

    def test_each_account_posts_only_own_reels(self):
        self.run_post(at(10, 5))
        st = self.state_now()
        self.assertEqual(list(st["posted"]), ["001_b/one/1.mp4"])
        self.assertEqual(list(st["posted_acc"]["two"]), ["001_b/two/1.mp4"])
        caps = sorted((e[1], e[2]) for e in FakeIG.log if e[0] == "container")
        self.assertEqual(caps, [("tok1", "C-one"), ("tok2", "C-two")])

    def test_batch_finishes_after_all(self):
        for hour in (10, 22):
            self.run_post(at(hour, 5))
        self.assertTrue((self.root / "posted" / "001_b").exists())
        self.assertEqual(len([e for e in FakeIG.log if e[0] == "publish"]), 4)


if __name__ == "__main__":
    unittest.main()
