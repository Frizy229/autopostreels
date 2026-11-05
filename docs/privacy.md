# Privacy Policy: Reels Autoposter

Last updated: 2026-11-05

Reels Autoposter is an open-source tool that uploads short videos prepared by the creator to the creator's own
Instagram and TikTok accounts on a schedule chosen by the creator.

**What we access.** When you connect TikTok, the app receives your basic profile information (open ID, display name,
username) and permission to upload videos to your TikTok account (`user.info.basic`, `video.upload`).

**What we store.** The TikTok refresh token is stored encrypted as a GitHub Actions secret in the repository you
control. No access tokens or profile data are stored anywhere else, sold, or shared with third parties.
Videos and captions stay in your repository and are sent only to the platforms you connected.

**How to revoke.** You can disconnect the app at any time in TikTok: Settings and privacy → Security → Apps and
services (or Manage app permissions), and by deleting the secret from your repository.

**Contact.** Open an issue at https://github.com/Frizy229/autopostreels/issues
