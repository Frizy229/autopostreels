"""Хранилище видео в релизе GitHub (.remote.json вместо mp4 в git), удаление через N дней, параллельная
публикация по аккаунтам, лимит на аккаунт за запуск и суточный лимит Meta."""
import datetime as dt
import json
import pathlib
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import autoposter as a  # noqa: E402
from test_autoposter import FakeIG, at  # noqa: E402
from test_lanes import LaneBase  # noqa: E402


class FakeResp:
    def __init__(self, status=200, body=b"VIDEO"):
        self.status_code, self.ok, self.body, self.text = status, status < 400, body, ""

    def iter_content(self, n):
        yield self.body

    def __enter__(self):
        return self

    def __exit__(self, *x):
        return False


class MediaBase(LaneBase):
    def setUp(self):
        super().setUp()
        self.cache = self.root / "_cache"
        self.ps2 = [mock.patch.object(a.tempfile, "gettempdir", lambda: str(self.cache))]
        for p in self.ps2:
            p.start()
        self.gets, self.deletes = [], []

    def tearDown(self):
        for p in self.ps2:
            p.stop()
        super().tearDown()

    def remote_folder(self, lane, name, videos):
        d = self.root / lane / name
        d.mkdir(parents=True, exist_ok=True)
        for i, v in enumerate(videos):
            (d / (v + a.REMOTE_SUFFIX)).write_text(json.dumps({"asset_id": 100 + i, "repo": "o/r", "size": 5,
                                                              "url": f"https://x/{v}"}), encoding="utf-8")
            (d / v).with_suffix(".txt").write_text("text", encoding="utf-8")
        return d

    def fake_get(self, url, headers=None, stream=False, timeout=0):
        self.gets.append((url, (headers or {}).get("Authorization", "")))
        return FakeResp()

    def fake_delete(self, url, headers=None, timeout=0):
        self.deletes.append(url)
        return FakeResp(204)


class RemoteVideoTests(MediaBase):
    def test_stub_counts_as_video(self):
        d = self.remote_folder("queue-instagram", "001_r", ["short-1.mp4", "short-2.mp4"])
        items = a.folder_items(d, self.state, self.lane("instagram"))
        self.assertEqual([i["id"] for i in items], ["instagram:001_r/short-1.mp4", "instagram:001_r/short-2.mp4"])
        self.assertEqual(items[0]["text"], "text")

    def test_fetch_downloads_once_with_token(self):
        d = self.remote_folder("queue-instagram", "001_r", ["short-1.mp4"])
        with mock.patch.dict("os.environ", {"GH_PAT": "pat"}), mock.patch.object(a.requests, "get", self.fake_get):
            f1 = a.fetch_video(d / "short-1.mp4")
            f2 = a.fetch_video(d / "short-1.mp4")
        self.assertEqual(f1, f2)
        self.assertEqual(f1.read_bytes(), b"VIDEO")
        self.assertFalse(str(f1).startswith(str(self.root / "queue-instagram")))  # не в репозитории
        self.assertEqual(self.gets, [("https://api.github.com/repos/o/r/releases/assets/100", "Bearer pat")])

    def test_fetch_without_token_uses_public_url(self):
        d = self.remote_folder("queue", "001_r", ["a.mp4"])
        with mock.patch.object(a.requests, "get", self.fake_get):
            a.fetch_video(d / "a.mp4")
        self.assertEqual(self.gets[0][0], "https://x/a.mp4")

    def test_fetch_failure_is_post_error(self):
        d = self.remote_folder("queue", "001_r", ["a.mp4"])
        with mock.patch.object(a.requests, "get", lambda *x, **k: FakeResp(404)):
            with self.assertRaises(RuntimeError):
                a.fetch_video(d / "a.mp4")

    def test_full_cycle_post_then_delete_after_two_days(self):
        self.remote_folder("queue-instagram", "001_r", ["short-1.mp4"])
        uploads = []
        orig = FakeIG.upload_video

        def up(ig, cid, path):
            uploads.append(path.read_bytes())
            return orig(ig, cid, path)
        with mock.patch.dict("os.environ", {"GH_PAT": "pat", "GITHUB_REPOSITORY": "o/r"}), \
                mock.patch.object(a.requests, "get", self.fake_get), mock.patch.object(a.requests, "delete", self.fake_delete), \
                mock.patch.object(FakeIG, "upload_video", up):
            self.assertEqual(self.run_post(at(10, 5)), 0)
            self.assertEqual(uploads, [b"VIDEO", b"VIDEO"])  # оба аккаунта Instagram, скачано один раз
            self.assertEqual(len(self.gets), 1)
            stub = self.root / "posted-instagram" / "001_r" / ("short-1.mp4" + a.REMOTE_SUFFIX)
            self.assertTrue(stub.exists())
            self.assertIn("100", a.load_state()["media_done"])
            self.run_post(at(11, 5))             # прошёл час: ещё храним
            self.assertEqual(self.deletes, [])
            later = dt.datetime(2026, 11, 6, 12, 0)  # через 2 дня
            self.run_post(later)
        self.assertEqual(self.deletes, ["https://api.github.com/repos/o/r/releases/assets/100"])
        self.assertEqual(json.loads(stub.read_text())["deleted"], "2026-11-06")
        self.assertNotIn("media_done", a.load_state())

    def test_keep_flag_not_deleted(self):
        d = self.remote_folder("posted-instagram", "001_r", ["short-1.mp4"])
        stub = d / ("short-1.mp4" + a.REMOTE_SUFFIX)
        stub.write_text(json.dumps({"asset_id": 5, "repo": "o/r", "keep": True}), encoding="utf-8")
        state = {"posted": {}, "skipped": {}, "media_done": {"5": "2026-11-01T10:00"}}
        with mock.patch.dict("os.environ", {"GH_PAT": "pat"}), mock.patch.object(a.requests, "delete", self.fake_delete):
            a.cleanup_media(a.load_config(), state, at(10))
        self.assertEqual(self.deletes, [])
        self.assertNotIn("media_done", state)


class ParallelTests(MediaBase):
    def test_accounts_post_in_parallel(self):
        self.write_config(parallel_accounts=4)
        self.lane_folder("instagram", "001_ig", ["1.mp4"], txt="x")
        both = threading.Barrier(2, timeout=5)  # пройдёт, только если оба аккаунта публикуют одновременно
        orig = FakeIG.wait_ready

        def slow(ig, cid):
            both.wait()
            return orig(ig, cid)
        with mock.patch.object(FakeIG, "wait_ready", slow):
            self.assertEqual(self.run_post(at(10, 5)), 0)
        self.assertEqual(sorted(self.ig_pubs()), ["tok1", "tok2"])
        st = a.load_state()
        self.assertIn("instagram:001_ig/1.mp4", st["posted"])
        self.assertIn("instagram:001_ig/1.mp4", st["posted_acc"]["two"])

    def test_cap_per_account(self):
        self.write_config(max_posts_per_account_run=1)
        self.lane_folder("instagram", "001_ig", ["1.mp4", "2.mp4", "3.mp4"], txt="x")
        self.run_post(at(10, 5), only="instagram:001_ig/1.mp4,instagram:001_ig/2.mp4")
        self.assertEqual(sorted(self.ig_pubs()), ["tok1", "tok2"])  # по одному на аккаунт

    def test_meta_quota_exhausted_waits(self):
        self.lane_folder("instagram", "001_ig", ["1.mp4"], txt="x")

        def limit(ig):
            return (100, 100) if ig.token == "tok1" else (3, 100)
        with mock.patch.object(FakeIG, "publishing_limit", limit, create=True):
            self.run_post(at(10, 5))
        self.assertEqual(self.ig_pubs(), ["tok2"])
        st = a.load_state()
        self.assertEqual(st["limits"]["one"]["used"], 100)
        self.assertEqual(st["limits"]["two"]["total"], 100)


if __name__ == "__main__":
    unittest.main()
