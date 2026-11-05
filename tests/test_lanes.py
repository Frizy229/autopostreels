"""Тесты раздельных очередей (queue-instagram/, queue-tiktok/), паузы соцсети, текстов и авто-комментариев.
Полный цикл автозалива в обе сети с подменой API Instagram и TikTok."""
import argparse
import json
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import autoposter as a  # noqa: E402
from test_autoposter import Base, FakeIG, at  # noqa: E402
from test_tiktok import FakeTT  # noqa: E402


class CommentIG(FakeIG):
    comments = []
    fail_comment = False

    def comment(self, media_id, message):
        if CommentIG.fail_comment:
            raise RuntimeError("Instagram API 403: (#10) Application does not have permission")
        CommentIG.comments.append((self.token, media_id, message))
        return f"c{len(CommentIG.comments)}"


class LaneBase(Base):
    config = None

    def setUp(self):
        super().setUp()
        FakeIG.log, FakeIG.fail_upload, FakeIG.fail_always = [], {}, set()
        FakeTT.log, FakeTT.limit, FakeTT.fail = [], False, False
        CommentIG.comments, CommentIG.fail_comment = [], False
        self.write_config()
        self.env = mock.patch.dict("os.environ", {"T1": "tok1", "T2": "tok2", "TT_TOKEN_TT": "rt"}, clear=True)
        self.env.start()
        a.configure_accounts(a.load_config())
        self.ps = [mock.patch.object(a, "Instagram", CommentIG), mock.patch.object(a, "TikTok", FakeTT),
                   mock.patch.object(a, "cover_url_for", lambda cfg, c: "")]
        for p in self.ps:
            p.start()

    def write_config(self, **extra):
        cfg = {"timezone": "Asia/Tomsk",
               "accounts": [{"name": "one", "token_env": "T1"}, {"name": "two", "token_env": "T2", "user_id": "9"},
                            {"name": "tt", "platform": "tiktok"}]}
        cfg.update(extra)
        (self.root / "config.json").write_text(json.dumps(cfg), encoding="utf-8")

    def tearDown(self):
        for p in self.ps:
            p.stop()
        self.env.stop()
        super().tearDown()

    def lane_folder(self, net, name, videos, txt=None):
        d = self.root / f"queue-{net}" / name
        d.mkdir(parents=True, exist_ok=True)
        for v in videos:
            (d / v).write_bytes(b"x")
            if txt is not None:
                (d / v).with_suffix(".txt").write_text(txt, encoding="utf-8")
        return d

    def run_post(self, now, only=None):
        return a.cmd_post(argparse.Namespace(dry_run=False, only=only, now=now.replace(tzinfo=None).isoformat()))

    def lane(self, name):
        return next(x for x in a.lanes(a.load_config()) if x["name"] == name)

    def ig_pubs(self):
        return [e[1] for e in FakeIG.log if e[0] == "publish"]


class LaneStructureTests(LaneBase):
    def test_lanes_default(self):
        names = [(x["name"], x["queue_dir"], x["posted_dir"]) for x in a.lanes(a.load_config())]
        self.assertEqual(names, [("", "queue", "posted"), ("instagram", "queue-instagram", "posted-instagram"),
                                 ("tiktok", "queue-tiktok", "posted-tiktok")])

    def test_lane_accounts_by_platform(self):
        self.assertEqual([x["name"] for x in a.lane_accounts(self.lane("instagram"))], ["one", "two"])
        self.assertEqual([x["name"] for x in a.lane_accounts(self.lane("tiktok"))], ["tt"])
        self.assertEqual(len(a.lane_accounts(None)), 3)

    def test_ids_have_lane_prefix(self):
        d = self.lane_folder("tiktok", "005_x", ["1.mp4"])
        items = a.folder_items(d, self.state, self.lane("tiktok"))
        self.assertEqual([(i["id"], i["plan_key"]) for i in items], [("tiktok:005_x/1.mp4", "1.mp4")])
        self.assertEqual([x["name"] for x in items[0]["pending"]], ["tt"])

    def test_instagram_lane_subfolders_only_ig_accounts(self):
        d = self.lane_folder("instagram", "006_y", [])
        (d / "two").mkdir()
        (d / "two" / "a.mp4").write_bytes(b"x")
        (d / "tt").mkdir()
        (d / "tt" / "b.mp4").write_bytes(b"x")  # TikTok-аккаунт в очереди Instagram не участвует
        items = a.folder_items(d, self.state, self.lane("instagram"))
        self.assertEqual([(i["id"], [x["name"] for x in i["pending"]]) for i in items],
                         [("instagram:006_y/two/a.mp4", ["two"])])

    def test_lane_of_id(self):
        cfg = a.load_config()
        self.assertEqual(a.lane_of_id(cfg, "tiktok:005_x")["queue_dir"], "queue-tiktok")
        self.assertEqual(a.lane_of_id(cfg, "005_x")["queue_dir"], "queue")


class LanePostTests(LaneBase):
    def test_each_network_gets_only_its_queue(self):
        self.lane_folder("instagram", "001_ig", ["1.mp4", "2.mp4"], txt="IG text")
        self.lane_folder("tiktok", "002_tt", ["1.mp4", "2.mp4"], txt="TT text")
        self.assertEqual(self.run_post(at(10, 5)), 0)
        self.assertEqual(self.ig_pubs(), ["tok1", "tok2"])
        self.assertEqual(FakeTT.log, [("tt", "1.mp4", "TT text")])
        st = a.load_state()
        self.assertIn("instagram:001_ig/1.mp4", st["posted"])
        self.assertIn("instagram:001_ig/1.mp4", st["posted_acc"]["two"])
        self.assertIn("tiktok:002_tt/1.mp4", st["posted_acc"]["tt"])
        self.assertNotIn("tiktok:002_tt/1.mp4", st["posted"])
        # у каждой очереди своё расписание и свой план
        self.assertEqual(st["lanes"]["instagram"]["active"]["folder"], "001_ig")
        self.assertEqual(st["lanes"]["tiktok"]["active"]["folder"], "002_tt")
        self.assertIn("2026-11-04", st["lanes"]["tiktok"]["plans"])

    def test_full_day_both_networks_and_move_to_posted(self):
        self.lane_folder("instagram", "001_ig", ["1.mp4", "2.mp4"], txt="IG")
        self.lane_folder("tiktok", "002_tt", ["1.mp4", "2.mp4"], txt="TT")
        self.run_post(at(10, 5))
        self.run_post(at(22, 5))
        self.assertEqual(len(self.ig_pubs()), 4)
        self.assertEqual(len(FakeTT.log), 2)
        self.assertTrue((self.root / "posted-instagram" / "001_ig").is_dir())
        self.assertTrue((self.root / "posted-tiktok" / "002_tt").is_dir())
        self.assertFalse((self.root / "queue-tiktok" / "002_tt").exists())

    def test_shared_and_lanes_together(self):
        self.folder("001_both", ["1.mp4"], txt="both")
        self.lane_folder("tiktok", "002_tt", ["1.mp4"], txt="TT only")
        self.run_post(at(10, 5))
        self.assertEqual(self.ig_pubs(), ["tok1", "tok2"])
        self.assertEqual(sorted(c for _, _, c in FakeTT.log), ["TT only", "both"])

    def test_tiktok_lane_leftovers_carry_over(self):
        """В отдельной очереди TikTok невышедшие ролики не пропускаются, а переносятся на следующий день."""
        self.lane_folder("tiktok", "002_tt", ["1.mp4", "2.mp4"], txt="TT")
        FakeTT.limit = True
        self.run_post(at(10, 5))
        self.run_post(at(22, 5))
        FakeTT.limit = False
        self.run_post(at(10, 5, day=5))
        st = a.load_state()
        self.assertEqual(st["skipped"], {})
        self.assertIn("tiktok:002_tt/1.mp4", st["posted_acc"]["tt"])
        self.assertEqual(st["lanes"]["tiktok"]["active"]["date"], "2026-11-05")

    def test_ig_failure_does_not_block_tiktok_lane(self):
        self.lane_folder("instagram", "001_ig", ["1.mp4"], txt="IG")
        self.lane_folder("tiktok", "002_tt", ["1.mp4"], txt="TT")
        FakeIG.fail_always.add("tok1")
        self.run_post(at(10, 5))
        self.assertEqual(FakeTT.log, [("tt", "1.mp4", "TT")])

    def test_only_with_lane_prefix(self):
        self.folder("001_both", ["1.mp4"], txt="both")
        self.lane_folder("tiktok", "002_tt", ["1.mp4"], txt="TT")
        self.assertEqual(self.run_post(at(8, 0), only="tiktok:002_tt/1.mp4"), 0)
        self.assertEqual(FakeTT.log, [("tt", "1.mp4", "TT")])
        self.assertEqual(self.ig_pubs(), [])

    def test_remove_lane_folder(self):
        self.lane_folder("tiktok", "002_tt", ["1.mp4"])
        self.assertEqual(a.cmd_remove(argparse.Namespace(name="tiktok:002_tt")), 0)
        self.assertFalse((self.root / "queue-tiktok" / "002_tt").exists())
        self.assertEqual(a.cmd_remove(argparse.Namespace(name="tiktok:../x")), 1)


class PauseTests(LaneBase):
    def test_paused_network_lane_waits(self):
        self.write_config(paused=["tiktok"])
        self.lane_folder("instagram", "001_ig", ["1.mp4"], txt="IG")
        self.lane_folder("tiktok", "002_tt", ["1.mp4"], txt="TT")
        self.run_post(at(10, 5))
        self.assertEqual(len(self.ig_pubs()), 2)
        self.assertEqual(FakeTT.log, [])
        st = a.load_state()
        self.assertTrue(st["lanes"]["tiktok"]["paused"])
        self.assertTrue((self.root / "queue-tiktok" / "002_tt").is_dir())

    def test_shared_queue_waits_when_any_network_paused(self):
        self.write_config(paused=["instagram"])
        self.folder("001_both", ["1.mp4"], txt="both")
        self.run_post(at(10, 5))
        self.assertEqual((self.ig_pubs(), FakeTT.log), ([], []))

    def test_resume_replans_from_now(self):
        self.lane_folder("tiktok", "002_tt", ["1.mp4", "2.mp4", "3.mp4"], txt="TT")
        self.run_post(at(10, 5))
        self.assertEqual(len(FakeTT.log), 1)
        self.write_config(paused=["tiktok"])
        self.run_post(at(15, 0))
        self.run_post(at(21, 0))
        self.assertEqual(len(FakeTT.log), 1)  # на паузе ничего
        self.write_config(paused=[])
        self.run_post(at(21, 30))
        # после паузы остаток раскидан с текущего момента до конца дня: сразу выходит только один
        self.assertEqual(len(FakeTT.log), 2)
        plan = a.load_state()["lanes"]["tiktok"]["active"]["plan"]
        self.assertTrue(all(v >= "2026-11-04T21:30" for v in plan.values()))
        self.assertNotIn("paused", a.load_state()["lanes"]["tiktok"])

    def test_no_accounts_lane_not_swept(self):
        """Очередь без аккаунтов (например, TikTok без токена) не должна «закончиться» и уехать в posted."""
        self.env.stop()
        self.env = mock.patch.dict("os.environ", {"T1": "tok1"}, clear=True)
        self.env.start()
        a.configure_accounts(a.load_config())
        self.lane_folder("tiktok", "002_tt", ["1.mp4"])
        self.run_post(at(10, 5))
        self.assertTrue((self.root / "queue-tiktok" / "002_tt").is_dir())


class TextsTests(LaneBase):
    def test_network_default_caption_footer_hashtags(self):
        self.write_config(texts={"instagram": {"caption": "Default IG", "footer": "Follow!", "hashtags": "#ig"},
                                 "tiktok": {"hashtags": "#fyp #tt"}})
        self.lane_folder("instagram", "001_ig", ["1.mp4"])          # без .txt: подпись по умолчанию
        self.lane_folder("tiktok", "002_tt", ["1.mp4"], txt="Own")  # своя подпись + хэштеги сети
        self.run_post(at(10, 5))
        caps = [e[2] for e in FakeIG.log if e[0] == "container"]
        self.assertEqual(caps[0], "Default IG\n\nFollow!\n\n#ig")
        self.assertEqual(FakeTT.log[0][2], "Own\n\n#fyp #tt")

    def test_folder_texts_override_network(self):
        self.write_config(texts={"instagram": {"caption": "Default", "hashtags": "#net"}})
        d = self.lane_folder("instagram", "001_ig", ["1.mp4"])
        (d / "texts.json").write_text(json.dumps({"caption": "Folder cap", "instagram": {"hashtags": "#folder"}}),
                                      encoding="utf-8")
        self.run_post(at(10, 5))
        self.assertEqual([e[2] for e in FakeIG.log if e[0] == "container"][0], "Folder cap\n\n#folder")

    def test_subfolder_texts_win(self):
        d = self.lane_folder("instagram", "001_ig", [])
        (d / "texts.json").write_text(json.dumps({"caption": "top"}), encoding="utf-8")
        (d / "two").mkdir()
        (d / "two" / "a.mp4").write_bytes(b"x")
        (d / "two" / "texts.json").write_text(json.dumps({"caption": "sub"}), encoding="utf-8")
        it = a.folder_items(d, self.state, self.lane("instagram"))[0]
        self.assertEqual(a.resolve_texts(a.load_config(), it, a.ACTIVE_ACCOUNTS[1])["caption"], "sub")

    def test_broken_texts_json_ignored(self):
        d = self.lane_folder("instagram", "001_ig", ["1.mp4"], txt="cap")
        (d / "texts.json").write_text("{oops", encoding="utf-8")
        self.assertEqual(self.run_post(at(10, 5)), 0)
        self.assertEqual(len(self.ig_pubs()), 2)

    def test_old_behaviour_without_texts(self):
        cfg = dict(a.DEFAULT_CONFIG, hashtags="#g")
        self.assertEqual(a.build_caption(cfg, "x"), a.build_caption(cfg, "x", {}))
        self.assertEqual(a.build_caption(cfg, "x", {"hashtags": ""}), "x")


class CommentTests(LaneBase):
    def test_network_comment_posted_under_reel(self):
        self.write_config(texts={"instagram": {"comment": "Full story on YouTube"}})
        self.lane_folder("instagram", "001_ig", ["1.mp4"], txt="cap")
        self.run_post(at(10, 5))
        self.assertEqual([(t, m) for t, _, m in CommentIG.comments],
                         [("tok1", "Full story on YouTube"), ("tok2", "Full story on YouTube")])
        rec = a.load_state()["posted"]["instagram:001_ig/1.mp4"]
        self.assertEqual(rec["comment_id"], "c1")

    def test_video_comment_section_wins(self):
        self.write_config(texts={"instagram": {"comment": "net"}})
        self.lane_folder("instagram", "001_ig", ["1.mp4"], txt="REELS CAPTION (Instagram):\ncap\n\nCOMMENT:\nmine\n")
        self.run_post(at(10, 5))
        self.assertEqual(CommentIG.comments[0][2], "mine")
        self.assertEqual([e[2] for e in FakeIG.log if e[0] == "container"][0], "cap")

    def test_pinned_comment_only_when_enabled(self):
        txt = "DESCRIPTION:\nd\n\nPINNED COMMENT:\npinned text\n\nREELS CAPTION (Instagram):\ncap\n"
        item = {"raw": txt}
        acc = {"name": "one"}
        self.assertEqual(a.comment_for(item, acc, {}), "")
        self.assertEqual(a.comment_for(item, acc, {"use_pinned_comment": True}), "pinned text")

    def test_no_comment_for_tiktok(self):
        self.assertEqual(a.comment_for({"raw": "COMMENT:\nx\n"}, {"name": "tt", "platform": "tiktok"}, {"comment": "y"}), "")

    def test_comment_failure_keeps_post(self):
        CommentIG.fail_comment = True
        self.write_config(texts={"instagram": {"comment": "hi"}})
        self.lane_folder("instagram", "001_ig", ["1.mp4"], txt="cap")
        self.assertEqual(self.run_post(at(10, 5)), 0)
        rec = a.load_state()["posted"]["instagram:001_ig/1.mp4"]
        self.assertIn("permission", rec["comment_error"])
        self.assertEqual(a.load_state().get("failures", {}), {})

    def test_dry_run_shows_texts(self):
        self.write_config(texts={"instagram": {"comment": "hi"}})
        self.lane_folder("instagram", "001_ig", ["1.mp4"], txt="cap")
        with mock.patch("builtins.print") as pr:
            a.cmd_post(argparse.Namespace(dry_run=True, only=None, now=at(9).replace(tzinfo=None).isoformat()))
        out = "\n".join(str(c.args[0]) for c in pr.call_args_list if c.args)
        self.assertIn("queue-instagram/001_ig", out)
        self.assertIn("комментарий: hi", out)
        self.assertEqual(FakeIG.log, [])


if __name__ == "__main__":
    unittest.main()
