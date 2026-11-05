# TikTok: что сделать руками

Автопостер умеет класть рилсы в TikTok через официальный **Content Posting API**. Очередь та же:
каждый рилс из `queue/` уходит в Instagram и в TikTok в одно и то же время.

## Два режима

| Режим (`mode` в config.json) | Что происходит | Нужен аудит TikTok? |
|---|---|---|
| `inbox` (по умолчанию) | Ролик попадает в **черновики/входящие** TikTok, приходит уведомление. Ты открываешь его, вставляешь подпись, выбираешь обложку и жмёшь «Опубликовать». | Нет |
| `direct` | Ролик публикуется сам, с подписью из `.txt`. | Да. Без аудита только «Только я», и сам аккаунт должен быть закрытым |

Ограничения TikTok:
- `inbox`: не больше **5 неопубликованных черновиков** за сутки. Если их больше, скрипт ждёт и пишет об этом в лог. Instagram при этом выходит как обычно.
- Если ролик за день так и не ушёл в TikTok, на следующий день он там пропускается, чтобы очередь шла дальше.
- В режиме `inbox` TikTok **не принимает подпись и обложку** от приложения: их ставишь сам при публикации. Подпись берётся из блока `REELS CAPTION (TikTok):` в .txt, если он есть, иначе из подписи Instagram.
- Статистику TikTok скрипт пока не собирает.

## Шаг 1. Приложение на developers.tiktok.com

1. Зайди на https://developers.tiktok.com → **Log in** (тем же TikTok-аккаунтом или почтой) → **Manage apps** → **Connect an app**. Тип: Individual.
2. Заполни карточку приложения:
   - **App name**: `Reels Autoposter` (слово TikTok в названии использовать нельзя)
   - **Icon**: любая квадратная картинка 1024×1024
   - **Category**: Video / Photo & Video
   - **Description**: возьми из `docs/tiktok-app-review.md`
   - **Terms of Service URL**: `https://github.com/Frizy229/autopostreels/blob/main/docs/terms.md`
   - **Privacy Policy URL**: `https://github.com/Frizy229/autopostreels/blob/main/docs/privacy.md`
   - **Platforms**: Web, адрес сайта `https://github.com/Frizy229/autopostreels`
3. **Add products**:
   - **Login Kit** → Redirect URI (Web): `https://github.com/Frizy229/autopostreels`
   - **Content Posting API** → включи **Upload**. **Direct Post** пока не включай.
4. **Scopes**: `user.info.basic`, `video.upload`.
5. Сначала попробуй **Sandbox** (вкладка Sandbox → Create sandbox → Target users → добавь свой TikTok-аккаунт). Песочнице не нужна проверка TikTok. Если загрузка в черновики в песочнице заработает, на этом всё. Если нет, жми **Submit for review** (текст и сценарий видео в `docs/tiktok-app-review.md`).
6. Скопируй **Client key** и **Client secret** (в песочнице свои, в боевом приложении свои).

## Шаг 2. Секреты GitHub

Settings → Secrets and variables → Actions → New repository secret:

- `TT_CLIENT_SECRET`: Client secret из TikTok
- `GH_PAT`: если его ещё нет. Fine-grained token на github.com/settings/tokens, только этот репозиторий, право **Secrets: Read and write**. Он нужен, чтобы скрипт сам сохранял токен TikTok в секрет (TikTok меняет его при продлении).

**Client key** не секрет (он виден в ссылке входа). Пришли его мне вместе с ником TikTok, я впишу их в `config.json`:

```json
"tiktok_client_key": "aw...",
"accounts": [
  ...,
  {"name": "<ник в TikTok>", "platform": "tiktok", "mode": "inbox"}
]
```

Токен аккаунта будет в секрете `TT_TOKEN_<НИК>` (создастся сам на шаге 3).

## Шаг 3. Подключить аккаунт TikTok

1. Actions → **TikTok: подключить аккаунт** → Run workflow, поле «адрес» оставь пустым.
2. В логе будет ссылка. Открой её, войди в TikTok и нажми «Разрешить».
3. TikTok вернёт тебя на страницу репозитория. **Скопируй весь адрес из строки браузера** (в нём есть `?code=...`).
4. Сразу (код живёт несколько минут) снова Run workflow и вставь адрес в поле «адрес». В логе должно быть «Секрет TT_TOKEN_… сохранён».
5. Actions → «Публикация рилсов» → Run workflow → `check`. Должно быть «TikTok: токен работает».

Дальше всё само: рилсы уходят в TikTok по расписанию. В виджете у TikTok-аккаунта будет «в черновиках».
Токен TikTok живёт год и продлевается сам при каждом запуске.

## Шаг 4 (позже). Прямая публикация

Если приложение пройдёт аудит Direct Post: включи **Direct Post** и scope `video.publish` в приложении,
поменяй `"mode": "direct"` и `"privacy": "PUBLIC_TO_EVERYONE"` у аккаунта в config.json и подключи аккаунт заново (шаг 3).
