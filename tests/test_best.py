"""A/B подписи, лучшие ролики (keep в хранилище, «Сводка») и автоповтор лучших в аккаунты группы."""
import datetime as dt
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import autoposter as a  # noqa: E402
from test_autoposter import FakeIG, at  # noqa: E402
from test_lanes import LaneBase  # noqa: E402

AB_TXT = "REELS CAPTION A:\nПервый вариант\n\nREELS CAPTION B:\nВторой вариант\n"


class ABTests(LaneBase):
    def captions(self):
        return {e[1]: e[2] for e in FakeIG.log if e[0] == "container"}

    def test_blocks_split_between_accounts(self):
        self.lane_folder("instagram", "001_ab", ["1.mp4", "2.mp4"], txt=AB_TXT)
        self.run_post(at(22, 5), only="instagram:001_ab/1.mp4")
        caps = self.captions()
        self.assertEqual({c.split("\n")[0] for c in caps.values()}, {"Первый вариант", "Второй вариант"})
        st = a.load_state()
        variants = {st["posted"]["instagram:001_ab/1.mp4"]["ab"], st["posted_acc"]["two"]["instagram:001_ab/1.mp4"]["ab"]}
        self.assertEqual(variants, {"A", "B"})

    def test_each_account_gets_both_variants_over_videos(self):
        self.lane_folder("instagram", "001_ab", ["1.mp4", "2.mp4"], txt=AB_TXT)
        item = lambda n: a.folder_items(self.root / "queue-instagram" / "001_ab", a.load_state(), self.lane("instagram"))[n]  # noqa: E731
        one = a.ACTIVE_ACCOUNTS[0]
        self.assertNotEqual(a.make_caption(a.load_config(), item(0), one)[1], a.make_caption(a.load_config(), item(1), one)[1])

    def test_caption_b_from_texts(self):
        self.write_config(texts={"instagram": {"caption": "текст A", "caption_b": "текст B"}})
        self.lane_folder("instagram", "001_t", ["1.mp4"])
        self.run_post(at(22, 5), only="instagram:001_t/1.mp4")
        self.assertEqual(sorted(self.captions().values()), ["текст A", "текст B"])

    def test_no_ab_without_second_variant(self):
        self.lane_folder("instagram", "001_n", ["1.mp4"], txt="REELS CAPTION:\nобычная\n")
        self.run_post(at(22, 5), only="instagram:001_n/1.mp4")
        self.assertNotIn("ab", a.load_state()["posted"]["instagram:001_n/1.mp4"])
        self.assertEqual(set(self.captions().values()), {"обычная"})


class BestTests(LaneBase):
    NOW = at(12, day=5)

    def setup_posted(self, views, stub=True):
        d = self.root / "posted-instagram" / "001_x"
        d.mkdir(parents=True)
        state = {"posted": {}, "skipped": {}}
        stats = {}
        when = (self.NOW - dt.timedelta(hours=30)).astimezone(dt.timezone.utc).isoformat(timespec="seconds")
        for i, v in enumerate(views):
            name = f"s{i}.mp4"
            if stub:
                (d / (name + a.REMOTE_SUFFIX)).write_text(json.dumps({"asset_id": 10 + i, "repo": "o/r"}), encoding="utf-8")
            else:
                (d / name).write_bytes(b"x")
            pid = f"instagram:001_x/{name}"
            state["posted"][pid] = {"media_id": f"m{i}", "at": when}
            stats[pid] = {"views": v, "likes": v // 10}
        return d, state, stats

    def test_best_marked_kept_and_repost_planned(self):
        d, state, stats = self.setup_posted([100, 120, 90, 110, 100, 1000])
        a.pick_best(a.load_config(), state, stats, self.NOW.astimezone(dt.timezone.utc))
        self.assertEqual(list(state["best"]), ["instagram:001_x/s5.mp4"])
        b = state["best"]["instagram:001_x/s5.mp4"]
        self.assertEqual((b["score"], b["median"], b["video"]), (1000, 110, "posted-instagram/001_x/s5.mp4"))
        self.assertEqual(b["reposts"], {"two": {"due": "2026-11-06T16:00+07:00"}})  # «один» его уже выложил
        self.assertTrue(json.loads((d / ("s5.mp4" + a.REMOTE_SUFFIX)).read_text())["keep"])
        self.assertNotIn("keep", json.loads((d / ("s0.mp4" + a.REMOTE_SUFFIX)).read_text()))
        a.pick_best(a.load_config(), state, stats, self.NOW.astimezone(dt.timezone.utc))  # повторно не выбирает
        self.assertEqual(len(state["best"]), 1)

    def test_nothing_without_outlier_or_data(self):
        _, state, stats = self.setup_posted([100, 120, 90, 110, 100, 150])
        a.pick_best(a.load_config(), state, stats, self.NOW.astimezone(dt.timezone.utc))
        self.assertNotIn("best", state)
        state, stats = {"posted": {"instagram:001_x/s0.mp4": state["posted"]["instagram:001_x/s0.mp4"]}, "skipped": {}}, \
            {"instagram:001_x/s0.mp4": {"views": 5000}}  # один ролик: сравнить не с чем
        a.pick_best(a.load_config(), state, stats, self.NOW.astimezone(dt.timezone.utc))
        self.assertNotIn("best", state)

    def test_repost_goes_out_on_due_day(self):
        _, state, stats = self.setup_posted([100, 120, 90, 110, 100, 1000], stub=False)
        a.pick_best(a.load_config(), state, stats, self.NOW.astimezone(dt.timezone.utc))
        a.save_state(state)
        self.run_post(at(12, day=6))
        self.assertEqual(self.ig_pubs(), [])  # ещё рано
        self.run_post(at(16, 5, day=6))
        self.assertEqual(self.ig_pubs(), ["tok2"])
        rec = a.load_state()["best"]["instagram:001_x/s5.mp4"]["reposts"]["two"]
        self.assertTrue(rec["media_id"] and rec["at"])
        self.run_post(at(17, 5, day=6))
        self.assertEqual(self.ig_pubs(), ["tok2"])  # один раз

    def test_best_keep_expires(self):
        d, state, _ = self.setup_posted([1])
        stub = d / ("s0.mp4" + a.REMOTE_SUFFIX)
        stub.write_text(json.dumps({"asset_id": 10, "repo": "o/r", "keep": True, "best": "2026-10-01"}), encoding="utf-8")
        a.cleanup_media(a.load_config(), state, at(10, day=5))
        self.assertNotIn("keep", json.loads(stub.read_text()))
        self.assertIn("10", state["media_done"])  # удалится через media_keep_days


if __name__ == "__main__":
    unittest.main()
