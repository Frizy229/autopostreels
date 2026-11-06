"""Тесты TikTok: куски загрузки, вход, подписи, публикация вместе с Instagram, лимиты."""
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


class FakeTT:
    log = []
    limit = False
    fail = False

    def __init__(self, acc, token, cfg):
        self.acc, self.name, self.mode = acc, acc["name"], acc.get("mode", "inbox")

    def whoami(self):
        return {"username": self.name}

    def post(self, path, caption, settings=None):
        if FakeTT.limit:
            raise a.TikTokLimit("TikTok API 403 spam_risk_too_many_pending_share: x")
        if FakeTT.fail:
            raise RuntimeError("TikTok не смог обработать видео: bad")
        FakeTT.log.append((self.name, path.name, caption))
        return {"media_id": f"p{len(FakeTT.log)}", "permalink": "", "platform": "tiktok", "mode": self.mode}


class HelperTests(unittest.TestCase):
    def test_chunks(self):
        self.assertEqual(a.tt_chunks(3_000_000), (3_000_000, 1))
        self.assertEqual(a.tt_chunks(64 * 1024 * 1024), (64 * 1024 * 1024, 1))
        size = 100 * 1024 * 1024 + 5
        chunk, n = a.tt_chunks(size)
        self.assertEqual((chunk, n), (10 * 1024 * 1024, 10))
        self.assertLess(size - chunk * (n - 1), 128 * 1024 * 1024)  # последний кусок в пределах лимита

    def test_code_from_url(self):
        url = "https://github.com/Frizy229/autopostreels?code=abc%2A123&scopes=video.upload&state=tt"
        self.assertEqual(a.tt_code_from(url), "abc*123")
        self.assertEqual(a.tt_code_from("  abc%2A1 "), "abc*1")

    def test_auth_url(self):
        u = a.tt_auth_url("KEY", "https://x.y/z", "tt")
        self.assertIn("client_key=KEY", u)
        self.assertIn("video.upload", u.replace("%2C", ","))
        self.assertIn("redirect_uri=https%3A%2F%2Fx.y%2Fz", u)


class TikTokConfigTests(Base):
    def test_tiktok_account_defaults(self):
        with mock.patch.dict("os.environ", {"IG_TOKEN": "x", "TT_TOKEN_TT": "r"}, clear=True):
            accs = a.configure_accounts({"accounts": [{"name": "ig"}, {"name": "tt", "platform": "tiktok"}]})
        tt = accs[1]
        self.assertEqual((tt["platform"], tt["mode"], tt["token_env"], tt["client_key_env"]),
                         ("tiktok", "inbox", "TT_TOKEN_TT", "TT_CLIENT_KEY"))

    def test_tiktok_skipped_without_token(self):
        with mock.patch.dict("os.environ", {"IG_TOKEN": "x"}, clear=True):
            accs = a.configure_accounts({"accounts": [{"name": "ig"}, {"name": "tt", "platform": "tiktok"}]})
        self.assertEqual([x["name"] for x in accs], ["ig"])

    def test_tiktok_can_be_first(self):
        # копия у друга может быть только с TikTok-аккаунтами
        with mock.patch.dict("os.environ", {"TT_TOKEN_TT": "r"}, clear=True):
            accs = a.configure_accounts({"accounts": [{"name": "tt", "platform": "tiktok"}]})
        self.assertEqual([(x["name"], x["primary"], x["token_env"]) for x in accs], [("tt", True, "TT_TOKEN_TT")])

    def test_secret_name_from_nick(self):
        # точки и дефисы в нике TikTok недопустимы в имени секрета GitHub
        self.assertEqual(a.tt_secret_name("evelon185"), "TT_TOKEN_EVELON185")
        self.assertEqual(a.tt_secret_name("my.nick-2"), "TT_TOKEN_MY_NICK_2")

    def test_no_accounts_without_token(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(a.configure_accounts({"accounts": []}), [])
            self.assertEqual(a.cmd_post(argparse.Namespace(dry_run=False, only=None, now=None)), 0)
        with mock.patch.dict("os.environ", {"IG_TOKEN": "x"}, clear=True):
            self.assertEqual([x["name"] for x in a.configure_accounts({"accounts": []})], ["main"])

    def test_note_token_changes_only_on_change(self):
        st, acc = {}, {"name": "tt"}
        self.assertTrue(a.note_token(st, acc, True, expires="2027-11-06"))
        self.assertFalse(a.note_token(st, acc, True, expires="2027-11-06"))
        self.assertTrue(a.note_token(st, acc, False, "OAuthException: invalid"))
        self.assertEqual(st["tokens"]["tt"]["ok"], False)
        self.assertIn("invalid", st["tokens"]["tt"]["error"])

    def test_caption_tiktok_block(self):
        txt = "REELS CAPTION (Instagram):\nIG text\n\nTIKTOK CAPTION:\nTT text\n"
        item = {"text": "", "captions": a.parse_captions(txt.replace("TIKTOK CAPTION", "REELS CAPTION (TikTok)"))}
        self.assertEqual(a.caption_for(item, {"name": "ig"}, 0), "IG text")
        self.assertEqual(a.caption_for(item, {"name": "tt", "platform": "tiktok"}, 1), "TT text")
        item2 = {"text": "", "captions": a.parse_captions("REELS CAPTION (Instagram):\nIG only\n")}
        self.assertEqual(a.caption_for(item2, {"name": "tt", "platform": "tiktok"}, 1), "IG only")


class TikTokClientTests(Base):
    """Настоящий класс TikTok с подменённым requests."""

    def resp(self, status=200, body=None):
        r = mock.Mock(status_code=status, ok=200 <= status < 300)
        r.content = b"1"
        r.json.return_value = body or {}
        r.text = json.dumps(body or {})
        return r

    def test_inbox_flow_and_refresh_rotation(self):
        video = self.root / "v.mp4"
        video.write_bytes(b"0123456789")
        acc = {"name": "tt", "platform": "tiktok", "mode": "inbox", "token_env": "TT_TOKEN_TT",
               "client_key_env": "K", "client_secret_env": "S"}
        calls = []

        def fake_request(method, url, **kw):
            calls.append((method, url, kw.get("json")))
            if url.endswith("/inbox/video/init/"):
                return self.resp(body={"data": {"publish_id": "P1", "upload_url": "https://up/1"}, "error": {"code": "ok"}})
            if url.endswith("/status/fetch/"):
                return self.resp(body={"data": {"status": "SEND_TO_USER_INBOX"}, "error": {"code": "ok"}})
            raise AssertionError(url)

        saved = {}
        with mock.patch.dict("os.environ", {"K": "key", "S": "sec"}, clear=True), \
                mock.patch.object(a.requests, "post", return_value=self.resp(body={
                    "access_token": "AT", "refresh_token": "NEW_RT", "expires_in": 86400})), \
                mock.patch.object(a.requests, "request", side_effect=fake_request), \
                mock.patch.object(a.requests, "put", return_value=self.resp(201)) as put, \
                mock.patch.object(a, "save_github_secret", lambda n, v: saved.update({n: v}) or True):
            res = a.TikTok(acc, "OLD_RT", self.cfg).post(video, "hello")
        self.assertEqual(res["mode"], "inbox")
        self.assertEqual(res["media_id"], "P1")
        self.assertEqual(saved, {"TT_TOKEN_TT": "NEW_RT"})
        init = calls[0][2]["source_info"]
        self.assertEqual((init["video_size"], init["chunk_size"], init["total_chunk_count"]), (10, 10, 1))
        self.assertEqual(put.call_args.kwargs["headers"]["Content-Range"], "bytes 0-9/10")

    def _direct(self, settings, options=("SELF_ONLY", "PUBLIC_TO_EVERYONE"), creator_extra=None):
        video = self.root / "v.mp4"
        video.write_bytes(b"x")
        acc = {"name": "tt", "platform": "tiktok", "mode": "direct",
               "token_env": "T", "client_key_env": "K", "client_secret_env": "S"}
        bodies = {}

        def fake_request(method, url, **kw):
            bodies[url.rsplit("/v2/", 1)[1]] = kw.get("json")
            if "creator_info" in url:
                return self.resp(body={"data": {"privacy_level_options": list(options), **(creator_extra or {})},
                                       "error": {"code": "ok"}})
            if url.endswith("/video/init/") or url.endswith("/inbox/video/init/"):
                return self.resp(body={"data": {"publish_id": "P", "upload_url": "https://up"}, "error": {"code": "ok"}})
            return self.resp(body={"data": {"status": "PUBLISH_COMPLETE"}, "error": {"code": "ok"}})

        with mock.patch.dict("os.environ", {"K": "key", "S": "sec"}, clear=True), \
                mock.patch.object(a.requests, "post", return_value=self.resp(body={"access_token": "AT", "refresh_token": "RT"})), \
                mock.patch.object(a.requests, "request", side_effect=fake_request), \
                mock.patch.object(a.requests, "put", return_value=self.resp(200)):
            res = a.TikTok(acc, "RT", self.cfg).post(video, "cap", settings)
        return res, bodies

    GOOD = {"consent": True, "privacy_level": "PUBLIC_TO_EVERYONE", "title": "Моё название",
            "disable_comment": False, "disable_duet": True, "disable_stitch": True,
            "commercial": {"on": False}}

    def test_direct_uses_confirmed_settings(self):
        res, bodies = self._direct(dict(self.GOOD))
        pi = bodies["post/publish/video/init/"]["post_info"]
        self.assertEqual((pi["privacy_level"], pi["title"], pi["disable_comment"], pi["disable_duet"]),
                         ("PUBLIC_TO_EVERYONE", "Моё название", False, True))
        self.assertFalse(pi["brand_content_toggle"])
        self.assertEqual(res["mode"], "direct")

    def test_direct_respects_creator_disabled_interactions(self):
        _, bodies = self._direct(dict(self.GOOD), creator_extra={"comment_disabled": True})
        self.assertTrue(bodies["post/publish/video/init/"]["post_info"]["disable_comment"])

    def test_direct_without_settings_goes_to_inbox(self):
        res, bodies = self._direct(None)
        self.assertIn("post/publish/inbox/video/init/", bodies)
        self.assertNotIn("post/publish/video/init/", bodies)

    def test_direct_rejects_unconfirmed_or_invalid(self):
        for bad in ({**self.GOOD, "consent": False},
                    {**self.GOOD, "privacy_level": ""},
                    {**self.GOOD, "privacy_level": "FRIENDS"},
                    {**self.GOOD, "commercial": {"on": True}},
                    {**self.GOOD, "privacy_level": "SELF_ONLY", "commercial": {"on": True, "branded": True}}):
            with self.assertRaises(ValueError, msg=str(bad)):
                a.tt_post_info(bad, "c", {"privacy_level_options": ["SELF_ONLY", "PUBLIC_TO_EVERYONE"]})

    def test_branded_content_flags(self):
        pi = a.tt_post_info({**self.GOOD, "commercial": {"on": True, "branded": True, "your_brand": True}}, "c", {})
        self.assertTrue(pi["brand_content_toggle"] and pi["brand_organic_toggle"])

    def test_load_settings_file(self):
        v = self.root / "short-1.mp4"
        v.write_bytes(b"x")
        self.assertIsNone(a.load_tt_settings(v))
        (self.root / "short-1.tiktok.json").write_text(json.dumps(self.GOOD), encoding="utf-8")
        self.assertEqual(a.load_tt_settings(v)["privacy_level"], "PUBLIC_TO_EVERYONE")
        (self.root / "short-1.tiktok.json").write_text("{bad", encoding="utf-8")
        self.assertIsNone(a.load_tt_settings(v))

    def test_pending_limit_is_tiktoklimit(self):
        acc = {"name": "tt", "token_env": "T", "client_key_env": "K", "client_secret_env": "S"}
        tt = a.TikTok(acc, "RT", self.cfg)
        tt.access_token = "AT"
        with mock.patch.object(a.requests, "request", return_value=self.resp(403, {
                "error": {"code": "spam_risk_too_many_pending_share", "message": "x"}})):
            with self.assertRaises(a.TikTokLimit):
                tt._req("/v2/post/publish/inbox/video/init/", {})


class TikTokUserInfoTests(Base):
    def test_user_info_requests_only_basic_fields(self):
        acc = {"name": "tt", "token_env": "T", "client_key_env": "K", "client_secret_env": "S", "mode": "inbox"}
        tt = a.TikTok(acc, "RT", self.cfg)
        tt.access_token = "AT"
        seen = []

        def fake(method, url, **kw):
            seen.append(url)
            r = mock.Mock(status_code=200, ok=True, content=b"1", text="")
            r.json.return_value = {"data": {"user": {"open_id": "o", "display_name": "Evelon"}}, "error": {"code": "ok"}}
            return r

        with mock.patch.object(a.requests, "request", side_effect=fake):
            info = tt.whoami()
        self.assertNotIn("username", seen[0])  # username требует user.info.profile
        self.assertEqual(info["username"], "Evelon")


class TikTokPostTests(Base):
    def setUp(self):
        super().setUp()
        FakeIG.log, FakeIG.fail_upload, FakeIG.fail_always = [], {}, set()
        FakeTT.log, FakeTT.limit, FakeTT.fail = [], False, False
        self.folder("001_a", ["1.mp4", "2.mp4"],
                    txt="REELS CAPTION (Instagram):\nIG cap\n\nREELS CAPTION (TikTok):\nTT cap\n")
        self.folder("002_b", ["1.mp4"], txt="x")
        (self.root / "config.json").write_text(json.dumps({
            "timezone": "Asia/Tomsk",
            "accounts": [{"name": "one", "token_env": "T1"}, {"name": "tt", "platform": "tiktok"}]}))
        self.env = mock.patch.dict("os.environ", {"T1": "tok1", "TT_TOKEN_TT": "rt"}, clear=True)
        self.env.start()
        a.configure_accounts(a.load_config())
        self.ps = [mock.patch.object(a, "Instagram", FakeIG), mock.patch.object(a, "TikTok", FakeTT),
                   mock.patch.object(a, "cover_url_for", lambda cfg, c: "")]
        for p in self.ps:
            p.start()

    def tearDown(self):
        for p in self.ps:
            p.stop()
        self.env.stop()
        super().tearDown()

    def run_post(self, now):
        return a.cmd_post(argparse.Namespace(dry_run=False, only=None, now=now.replace(tzinfo=None).isoformat()))

    def test_posts_to_instagram_and_tiktok(self):
        self.run_post(at(10, 5))
        self.assertEqual(FakeTT.log, [("tt", "1.mp4", "TT cap")])
        st = a.load_state()
        self.assertEqual(st["posted_acc"]["tt"]["001_a/1.mp4"]["mode"], "inbox")
        self.assertIn("001_a/1.mp4", st["posted"])

    def test_limit_does_not_count_as_failure_and_ig_continues(self):
        FakeTT.limit = True
        self.assertEqual(self.run_post(at(10, 5)), 0)
        st = a.load_state()
        self.assertIn("001_a/1.mp4", st["posted"])
        self.assertEqual(st.get("failures", {}), {})

    def test_token_status_saved_for_widget(self):
        self.run_post(at(10, 5))
        tokens = a.load_state()["tokens"]
        self.assertTrue(tokens["tt"]["ok"])
        self.assertTrue(tokens["one"]["ok"])

    def test_dead_tiktok_token_noted(self):
        with mock.patch.object(FakeTT, "whoami", side_effect=RuntimeError("TikTok не продлил токен (OAuthException): bad")):
            self.assertEqual(self.run_post(at(10, 5)), 0)
        st = a.load_state()
        self.assertFalse(st["tokens"]["tt"]["ok"])
        self.assertIn("001_a/1.mp4", st["posted"])  # Instagram вышел

    def test_tiktok_leftovers_skipped_next_day(self):
        FakeTT.limit = True
        self.run_post(at(10, 5))
        self.run_post(at(22, 5))
        st = a.load_state()
        self.assertEqual(len(st["posted"]), 2)
        FakeTT.limit = False
        self.run_post(at(10, 5, day=5))
        st = a.load_state()
        self.assertIn("tt|001_a/1.mp4", st["skipped"])
        self.assertTrue((self.root / "posted" / "001_a").exists())
        self.assertIn("002_b/1.mp4", st["posted"])  # очередь пошла дальше
        self.assertIn("002_b/1.mp4", st["posted_acc"]["tt"])


class RefreshTests(Base):
    def test_refreshes_every_instagram_login_token(self):
        cfg = {"accounts": [{"name": "one", "token_env": "IG_TOKEN"}, {"name": "two", "token_env": "IG_TOKEN_TWO"},
                            {"name": "sys", "token_env": "IG_TOKEN_SYS"}, {"name": "tt", "platform": "tiktok"}]}
        (self.root / "config.json").write_text(json.dumps(cfg))
        env = {"IG_TOKEN": "IGAAone", "IG_TOKEN_TWO": "IGAAtwo", "IG_TOKEN_SYS": "EAAsys", "TT_TOKEN_TT": "r"}
        got = []

        def fake_get(url, timeout, params):
            got.append(params["access_token"])
            r = mock.Mock(ok=True, content=b"1")
            r.json.return_value = {"access_token": params["access_token"] + "-new", "expires_in": 5184000}
            return r

        with mock.patch.dict("os.environ", env, clear=True), mock.patch.object(a.requests, "get", fake_get), \
                mock.patch.object(a, "save_github_secret", return_value=True) as save:
            self.assertEqual(a.cmd_refresh(argparse.Namespace()), 0)
        self.assertEqual(got, ["IGAAone", "IGAAtwo"])  # системный EAA без ключей приложения не трогаем, TikTok сам
        self.assertEqual([c.args for c in save.call_args_list], [("IG_TOKEN", "IGAAone-new"), ("IG_TOKEN_TWO", "IGAAtwo-new")])

    def test_facebook_token_refreshed_once_for_all_its_accounts_and_system_user_kept(self):
        cfg = {"accounts": [{"name": "main", "token_env": "IG_TOKEN"}, {"name": "b", "token_env": "IG_TOKEN_B"},
                            {"name": "c", "token_env": "IG_TOKEN_C"}]}
        (self.root / "config.json").write_text(json.dumps(cfg))
        env = {"IG_TOKEN": "EAAsys", "IG_TOKEN_B": "EAAuser", "IG_TOKEN_C": "EAAuser",
               "FB_APP_ID": "1", "FB_APP_SECRET": "s"}
        exchanged = []

        def fake_get(url, timeout, params):
            r = mock.Mock(ok=True, content=b"1")
            if url.endswith("debug_token"):
                r.json.return_value = {"data": {"expires_at": 0 if params["input_token"] == "EAAsys" else 1893456000,
                                                "type": "SYSTEM_USER" if params["input_token"] == "EAAsys" else "USER"}}
            else:
                exchanged.append(params["fb_exchange_token"])
                r.json.return_value = {"access_token": "EAAuser-new", "expires_in": 5184000}
            return r

        with mock.patch.dict("os.environ", env, clear=True), mock.patch.object(a.requests, "get", fake_get), \
                mock.patch.object(a, "save_github_secret", return_value=True) as save:
            self.assertEqual(a.cmd_refresh(argparse.Namespace()), 0)
        self.assertEqual(exchanged, ["EAAuser"])  # один обмен на общий токен, системный не трогаем
        self.assertEqual([c.args for c in save.call_args_list], [("IG_TOKEN_B", "EAAuser-new"), ("IG_TOKEN_C", "EAAuser-new")])


if __name__ == "__main__":
    unittest.main()
