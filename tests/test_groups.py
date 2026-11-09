"""Тесты групп: отдельная сетка аккаунтов для другого проекта (свои аккаунты, очереди, расписание, тексты, пауза).
Группа по умолчанию (всё, что было раньше) должна работать без изменений."""
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import autoposter as a  # noqa: E402
from test_autoposter import at  # noqa: E402
from test_lanes import LaneBase  # noqa: E402
from test_tiktok import FakeTT  # noqa: E402
from unittest import mock  # noqa: E402

CARS = {"id": "cars", "name": "Машины", "day_start": "12:00", "day_end": "20:00",
        "texts": {"instagram": {"footer": "Подпишись на машины"}}, "hashtags": "#cars",
        "accounts": [{"name": "carsig", "token_env": "T_CARS"}, {"name": "carstt", "platform": "tiktok"}]}


class GroupBase(LaneBase):
    def setUp(self):
        super().setUp()
        self.env.stop()
        self.env = mock.patch.dict("os.environ", {"T1": "tok1", "T2": "tok2", "TT_TOKEN_TT": "rt",
                                                  "T_CARS": "tokcars", "TT_TOKEN_CARSTT": "rtcars"}, clear=True)
        self.env.start()
        self.write_config(groups=[dict(CARS)])
        a.configure_accounts(a.load_config())

    def group_folder(self, sub, name, videos, txt=None):
        d = self.root / "groups" / "cars" / sub / name
        d.mkdir(parents=True, exist_ok=True)
        for v in videos:
            (d / v).write_bytes(b"x")
            if txt is not None:
                (d / v).with_suffix(".txt").write_text(txt, encoding="utf-8")
        return d

    def set_groups(self, *gs):
        self.write_config(groups=list(gs))
        a.configure_accounts(a.load_config())


class GroupConfigTests(GroupBase):
    def test_accounts_carry_group(self):
        accs = [(x["name"], x["group"], x["primary"]) for x in a.ACTIVE_ACCOUNTS]
        self.assertEqual(accs, [("one", "", True), ("two", "", False), ("tt", "", False),
                                ("carsig", "cars", False), ("carstt", "cars", False)])

    def test_group_account_without_secret_skipped(self):
        cars = dict(CARS, accounts=[{"name": "nosecret"}])
        self.set_groups(cars)
        self.assertNotIn("nosecret", [x["name"] for x in a.ACTIVE_ACCOUNTS])
        # имя секрета по нику, как делает виджет
        self.assertEqual(a._make_account({"name": "nosecret"}, 0, "cars")["token_env"], "IG_TOKEN_NOSECRET")

    def test_duplicate_name_in_group_skipped(self):
        self.set_groups(dict(CARS, accounts=[{"name": "one", "token_env": "T_CARS"}]))
        self.assertEqual([x["group"] for x in a.ACTIVE_ACCOUNTS if x["name"] == "one"], [""])

    def test_bad_group_ids_ignored(self):
        cfg = {"groups": [{"id": "Cars!"}, {"id": "instagram"}, {"id": "ok"}, {"id": "ok"}, "x"]}
        self.assertEqual([g["id"] for g in a.groups(cfg)], ["ok"])

    def test_lanes_of_group(self):
        ln = [(x["name"], x["prefix"], x["queue_dir"], x["posted_dir"]) for x in a.lanes(a.load_config())][3:]
        self.assertEqual(ln, [
            ("cars", "cars:", "groups/cars/queue", "groups/cars/posted"),
            ("cars:instagram", "cars:instagram:", "groups/cars/queue-instagram", "groups/cars/posted-instagram"),
            ("cars:tiktok", "cars:tiktok:", "groups/cars/queue-tiktok", "groups/cars/posted-tiktok")])
        cfg = a.load_config()
        self.assertEqual(a.lane_of_id(cfg, "cars:instagram:005_x")["name"], "cars:instagram")
        self.assertEqual(a.lane_of_id(cfg, "cars:005_x")["name"], "cars")
        self.assertEqual(a.lane_of_id(cfg, "instagram:005_x")["name"], "instagram")
        self.assertEqual(a.lane_of_id(cfg, "005_x")["name"], "")

    def test_lane_accounts_only_group(self):
        lane = lambda n: next(x for x in a.lanes(a.load_config()) if x["name"] == n)  # noqa: E731
        self.assertEqual([x["name"] for x in a.lane_accounts(lane(""))], ["one", "two", "tt"])
        self.assertEqual([x["name"] for x in a.lane_accounts(lane("instagram"))], ["one", "two"])
        self.assertEqual([x["name"] for x in a.lane_accounts(lane("cars"))], ["carsig", "carstt"])
        self.assertEqual([x["name"] for x in a.lane_accounts(lane("cars:tiktok"))], ["carstt"])

    def test_group_cfg_overrides(self):
        cfg = a.load_config()
        gc = a.group_cfg(cfg, "cars")
        self.assertEqual((gc["day_start"], gc["day_end"], gc["hashtags"]), ("12:00", "20:00", "#cars"))
        self.assertEqual(gc["timezone"], "Asia/Tomsk")
        self.assertIs(a.group_cfg(cfg, ""), cfg)
        bad = a.group_cfg({**cfg, "groups": [dict(CARS, day_start="25:99")]}, "cars")
        self.assertEqual(bad["day_start"], cfg["day_start"])


class GroupPostTests(GroupBase):
    def test_group_queue_goes_only_to_group_accounts(self):
        self.group_folder("queue", "001_car", ["1.mp4"], txt="Машина")
        self.folder("001_main", ["1.mp4"], txt="Главный")
        self.assertEqual(self.run_post(at(12, 5)), 0)
        st = a.load_state()
        self.assertIn("cars:001_car/1.mp4", st["posted_acc"]["carsig"])
        self.assertIn("cars:001_car/1.mp4", st["posted_acc"]["carstt"])
        self.assertNotIn("cars:001_car/1.mp4", st["posted"])
        self.assertNotIn("cars:001_car/1.mp4", st["posted_acc"].get("two", {}))
        # основная группа по-прежнему пишет первый аккаунт в state["posted"]
        self.assertIn("001_main/1.mp4", st["posted"])
        self.assertNotIn("001_main/1.mp4", st["posted_acc"]["carsig"])
        # своё расписание группы: state.lanes["cars"]
        self.assertEqual(st["lanes"]["cars"]["plans"]["2026-11-04"]["folder"], "001_car")
        self.assertTrue((self.root / "groups" / "cars" / "posted" / "001_car").is_dir())

    def test_group_window_and_texts(self):
        self.group_folder("queue-instagram", "001_car", ["1.mp4", "2.mp4"], txt="Машина")
        self.run_post(at(10, 30))  # окно группы с 12:00: ещё рано
        self.assertEqual(self.ig_pubs(), [])
        self.run_post(at(12, 5))
        st = a.load_state()
        plan = st["lanes"]["cars:instagram"]["active"]["plan"]
        self.assertEqual([v[11:16] for v in plan.values()], ["12:00", "20:00"])
        cap = [e for e in a.Instagram.log if e[0] == "container"] if hasattr(a.Instagram, "log") else []
        self.assertTrue(cap)
        self.assertIn("Подпишись на машины", cap[-1][2])
        self.assertIn("#cars", cap[-1][2])

    def test_group_pause_independent(self):
        self.set_groups(dict(CARS, paused=["instagram", "tiktok"]))
        self.group_folder("queue", "001_car", ["1.mp4"], txt="Машина")
        self.folder("001_main", ["1.mp4"], txt="Главный")
        self.run_post(at(12, 5))
        st = a.load_state()
        self.assertIn("001_main/1.mp4", st["posted"])
        self.assertFalse(st.get("posted_acc", {}).get("carsig"))
        self.assertTrue(st["lanes"]["cars"].get("paused"))

    def test_finished_group_folder_moves_to_group_posted(self):
        self.group_folder("queue-tiktok", "001_car", ["1.mp4"], txt="TT")
        self.run_post(at(12, 5))
        self.assertTrue((self.root / "groups" / "cars" / "posted-tiktok" / "001_car").is_dir())
        self.assertEqual(FakeTT.log[-1][0], "carstt")

    def test_only_and_remove_with_group_prefix(self):
        self.group_folder("queue-instagram", "001_car", ["1.mp4", "2.mp4"], txt="x")
        self.assertEqual(self.run_post(at(9, 0), only="cars:instagram:001_car/2.mp4"), 0)
        self.assertIn("cars:instagram:001_car/2.mp4", a.load_state()["posted_acc"]["carsig"])
        import argparse
        self.assertEqual(a.cmd_remove(argparse.Namespace(name="cars:instagram:001_car")), 0)
        self.assertFalse((self.root / "groups" / "cars" / "queue-instagram" / "001_car").exists())

    def test_broken_group_account_does_not_stop_main(self):
        orig = a.Instagram.whoami

        def whoami(ig):
            if ig.token == "tokcars":
                raise RuntimeError("OAuthException: bad token")
            return orig(ig)
        self.group_folder("queue-instagram", "001_car", ["1.mp4"], txt="x")
        self.folder("001_main", ["1.mp4"], txt="y")
        with mock.patch.object(a.Instagram, "whoami", whoami):
            self.assertEqual(self.run_post(at(12, 5)), 0)
        st = a.load_state()
        self.assertIn("001_main/1.mp4", st["posted"])
        self.assertFalse(st["tokens"]["carsig"]["ok"])

    def test_old_config_without_groups_unchanged(self):
        self.write_config()
        a.configure_accounts(a.load_config())
        self.assertEqual(len(a.lanes(a.load_config())), 3)
        self.assertTrue(all(x["group"] == "" for x in a.ACTIVE_ACCOUNTS))


if __name__ == "__main__":
    unittest.main()
