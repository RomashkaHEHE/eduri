# Production operations

## Automatic production deployment

Pushes to `main` are deployed automatically only after the complete `CI`
workflow succeeds. `.github/workflows/deploy.yml` checks out the exact verified
`head_sha`, repeats the publication-file scan, creates a bounded checksummed Git
archive, and sends it over pinned-host-key SSH. Production deploys are serialized
and are never cancelled halfway through.

The SSH identity is dedicated to CD. Its `authorized_keys` entry uses a forced
command with OpenSSH `restrict`, so it cannot start a shell, execute a supplied
command, allocate a PTY, or open forwarding. The root-owned receiver validates
the framing, compressed checksum and size, rejects links, special files,
traversal, secrets, databases and recovery paths, and bounds both member count
and unpacked bytes. It preserves `.env`, `data`, `backups`, restore data and the
shared maintenance lock. The receiver hands the validated archive to a detached
systemd worker, so closing SSH or the Actions runner cannot terminate the
production transaction. Before cutover, the worker keeps a recovery source
snapshot and records the existing backup set. The regular deploy creates and
validates a stopped-application backup. A failed release restores the previous
source, edge configuration, and that exact pre-deploy data backup before it
starts the previous app. Failed-release data is retained under a bounded
`data.failed-restore-cd-*` path for investigation.

The job records a durable phase before every production boundary. Before
`commit-intent`, HUP, TERM, process failure, SSH loss, and reboot converge on the
same rollback. At and after `commit-intent`, recovery only completes the new
release, so it never restores an old database after the new version could have
accepted public writes. `eduri-cd-reconcile.service` resumes an unfinished job
at boot. An nginx systemd dependency makes startup fail closed if reconciliation
cannot finish; nginx cannot accept traffic merely because the recovery unit
failed. The bootstrap installer durably publishes its helper generation and can
atomically migrate the previous regular revision marker when it contains the
exact declared production SHA.

A recovery snapshot is removed only after either the forward release or the
rollback is healthy. Receiver, worker, validator, and edge helpers are installed
as immutable generation directories; every helper is syntax-checked separately,
and `current` switches atomically together with the deployed revision marker.

One-time setup requires a new dedicated Ed25519 key pair. Copy only its public
key to a temporary root-readable file on the server, then run:

```bash
ssh-keygen -t ed25519 -C eduri-production-cd -f ./eduri-production-cd
cd /home/user1/eduri
sudo bash ops/scripts/install-cd-receiver.sh \
  /path/to/eduri-production-cd.pub \
  "$(git rev-parse HEAD)"
```

The second argument must be the exact 40-character revision already running in
production; it bootstraps the marker without deploying or restarting the app.

Configure these GitHub Actions repository or `production` environment secrets:

- `EDURI_CD_SSH_PRIVATE_KEY`: the dedicated private key, including its header
  and footer;
- `EDURI_CD_KNOWN_HOSTS`: the pinned `eduri.ru` line from a separately verified
  OpenSSH `known_hosts` file.

The server records the last successful revision in
`/var/lib/eduri-cd/deployed-sha`. Verify it after a release together with health:

```bash
sudo cat /var/lib/eduri-cd/deployed-sha
systemctl status eduri-cd-reconcile.service
curl --fail --silent --show-error https://eduri.ru/api/health
sudo -u user1 docker compose --project-directory /home/user1/eduri \
  --file /home/user1/eduri/docker-compose.yml ps
```

Rotate the CD key by rerunning `install-cd-receiver.sh` with the new public key
and replacing `EDURI_CD_SSH_PRIVATE_KEY`. The installer atomically replaces only
the marked `eduri-production-cd` entry and leaves administrator keys unchanged.

Локальный development/test server по умолчанию слушает только `127.0.0.1`,
поскольку development credentials заведомо не предназначены для LAN. Только
production-конфигурация слушает `0.0.0.0`; контейнер публикует этот port лишь на
host loopback, а внешний доступ проходит через nginx.

Этот документ описывает односерверное развертывание Eduri на `eduri.ru`.
Приложение, ClamAV и LiveKit запускаются через Docker Compose из `/home/user1/eduri`.
Express слушает `127.0.0.1:3020`, LiveKit signaling — `127.0.0.1:7880`, а nginx
принимает публичный HTTP(S) и WebSocket-трафик.
Оба public listeners являются explicit default server, но неизвестный `Host`
получает nginx `444`; HTTP redirect всегда использует фиксированный
`https://eduri.ru`, а не отражает клиентский Host header.
Постоянные данные находятся в `/home/user1/eduri/data`.

## Перед первым запуском

1. Направьте A-запись `eduri.ru` на сервер. Добавляйте AAAA-запись только если
   IPv6 действительно маршрутизируется на этот сервер.
2. Откройте снаружи TCP `80`, `443`, `7881`, `5349` и UDP `3478`, `7882`,
   `35000-35049`. SSH ограничьте доверенными адресами, если это возможно. Порты
   `3020` должен оставаться доступен только через loopback. LiveKit `7880`
   слушает loopback и точный локальный Docker gateway `10.253.0.1`, но не
   публичный интерфейс.
3. Установите Docker Engine с Compose plugin, `curl`, `sqlite3`, `tar`, `flock`
   (`util-linux`, включая `setpriv`), `rsync`, `python3` и `coreutils`.
4. Разместите проект ровно в `/home/user1/eduri` и создайте `.env` с
   `NODE_ENV=production`, `APP_ORIGIN=https://eduri.ru`,
   `TRUST_PROXY=10.253.0.1`,
   `LIVEKIT_URL=wss://eduri.ru/livekit` и новыми случайными секретами
   `AUTH_LOOKUP_KEY`, `ADMIN_PASSWORD`, `LIVEKIT_API_KEY` и
   `LIVEKIT_API_SECRET`. Значения `replace-with-*`, `change-me*` и другие
   template credentials production-конфигурация отклоняет. Compose независимо
   фиксирует `NODE_ENV=production`, точный `TRUST_PROXY=10.253.0.1` и приватный
   `LIVEKIT_API_URL=http://10.253.0.1:7880`, чтобы ошибочно скопированный
   development template не отключил fail-closed проверки и не отправил
   management RPC через публичный origin.
   Оставьте bounded Code blob scanner
   settings `CODE_BLOB_SCAN_TIMEOUT_MS=30000` и
   `CODE_BLOB_SCAN_MAX_BYTES=33554432`, если одновременно не меняются и не
   тестируются server/clamd limits. Выполните
   `chmod 600 /home/user1/eduri/.env`.
5. Убедитесь, что `.env` не хранится в Git, резервных архивах или shell history.
6. Проверьте владельца data directory. Контейнер использует встроенного пользователя `node`
   с UID/GID 1000, совпадающим с `user1` на целевом сервере; он должен иметь чтение и запись в
   `/home/user1/eduri/data`. Не решайте проблему прав через `chmod 777`.

Пароль SSH, ранее переданный в рабочем чате, следует считать раскрытым. До
публикации сервиса смените его, установите ключ администратора и отключите
`PasswordAuthentication` после проверки входа по ключу в отдельной SSH-сессии.

## TLS и nginx

Конфигурация устанавливается в два этапа. Bootstrap virtual host обслуживает
только ACME challenge и возвращает 503 для остального HTTP-трафика. После
получения сертификата устанавливается HTTPS virtual host, а HTTP начинает
перенаправляться на HTTPS.

Предпочтительный вариант с уведомлениями Let's Encrypt:

```bash
cd /home/user1/eduri
sudo bash ops/scripts/install-tls.sh --email ops@example.com
sudo certbot renew --dry-run --run-deploy-hooks
```

Если operational email пока отсутствует, доступен явный fallback:

```bash
sudo bash ops/scripts/install-tls.sh --no-email
```

`--no-email` использует `--register-unsafely-without-email`: сертификат будет
выпущен, но предупреждения о проблемах продления не придут. После появления
рабочего адреса обновите регистрацию Certbot. Deploy hook проверяет nginx и
перезагружает его после успешного продления, затем перезапускает LiveKit и
проверяет его HTTP health endpoint и сертификат, который TURN/TLS отдает на
`5349`. Ошибка любой проверки завершает hook ненулевым кодом и попадает в журнал
Certbot.

Проверки после установки:

```bash
sudo nginx -t
systemctl status nginx certbot.timer
curl --fail --silent --show-error https://eduri.ru/api/health
curl --head http://eduri.ru/
curl --output /dev/null --silent --write-out '%{http_code}\n' \
  https://eduri.ru/twirp/livekit.RoomService/ListRooms # ожидается 404
curl --request POST --header 'Content-Type: application/json' --data '{"names":[]}' \
  --output /dev/null --silent --write-out '%{http_code}\n' \
  https://eduri.ru/twirp/livekit.RoomService/ListRooms # ожидается 404
```

Virtual host отдельно проксирует `/socket.io/` в приложение и `/livekit/` в SFU
с HTTP Upgrade и часовым таймаутом. Access log для `/livekit/` отключен: JWT
комнаты передается в query string WebSocket handshake и не должен попадать в
`access.log`. Публичные `/twirp/` и `/livekit/twirp/` всегда возвращают `404`:
серверные management
RPC идут из app прямо на `http://10.253.0.1:7880` через локальный Docker bridge,
который не маршрутизируется из интернета. Guest share key — 43-символьная bearer capability, поэтому nginx также
отключает access log для `/room/:shareKey` и
`/api/guest/rooms/:shareKey/...`, включая первичный HTTP→HTTPS redirect. Создание
`/api/guest/rooms` и запросы без
валидной capability остаются журналируемыми. Остальные запросы идут на
`127.0.0.1:3020`. Compose использует отдельную сеть `10.253.0.0/24`; приложение
доверяет forwarding headers только от точного gateway/nginx peer
`10.253.0.1`, а не от произвольного контейнера или `X-Forwarded-For`.

Board WebSocket, Socket.IO, guest API и LiveKit signaling имеют независимые per-IP
connection/request zones. Превышение concurrent connection или burst budget
возвращает `429`; это edge guard, а не замена tenant/account quota в приложении.
Не заменяйте zones одним общим бюджетом: пользователи за одним NAT должны
мочь одновременно подключить доску, звонок и Code workspace.

Socket.IO также защищён внутри приложения, даже если edge guard отсутствует или
ошибочно настроен. Engine.IO допускает не более 512 одновременных соединений в
процессе и 32 с одного trusted source IP; handshake ограничен 4 000 попыток в
минуту глобально и 120 на IP. Pending reservation живёт не более 10 секунд и
освобождается вместе с соединением. До application parse/validation каждый
namespace-auth packet и event, включая malformed/unknown payload, списывает
event/byte budget одновременно с process-global, IP и стабильного user/workspace
scope. Окно фиксировано на одну минуту, поэтому parallel sockets и reconnect его
не сбрасывают. Engine.IO отдельно отклоняет единичный envelope больше 5 MiB.
Bounded registries содержат не более 4 096 IP и 10 000 principal scopes и
освобождают idle entries через две минуты; переполнение закрывается fail-closed.
`X-Real-IP` для этих лимитов принимается только при совпадении direct peer с
точным настроенным IP nginx (`TRUST_PROXY`).

Security headers разрешают камеру, микрофон и screen capture только самому
Eduri, WASM-компиляцию для Pyodide и same-origin/blob workers Monaco. Pyodide
`0.27.5` и Monaco `0.55.1` обслуживаются из `/vendor`; `script-src` и
`connect-src` не содержат внешних CDN/PyPI origins. Любой новый внешний origin
добавляется точечно после проверки. Nginx — единственный авторитетный слой
security headers: он скрывает все пересекающиеся upstream Helmet headers и добавляет
ровно одно своё значение. Не удаляйте `proxy_hide_header` без одновременного
переноса политики в nginx. `unsafe-inline` разрешен только для styles; не добавляйте
`unsafe-eval` или wildcard origins в CSP основного документа. Пользовательский
код в Eduri выполняется только как Python внутри отдельного Pyodide worker;
JavaScript runner отсутствует. Его прежний URL закрыт точным nginx `404`,
чтобы запрос не попадал в SPA fallback.

Nginx выдаёт один canonical набор `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp` и
`Cross-Origin-Resource-Policy: same-origin`. Это сохраняет cross-origin
isolation и `SharedArrayBuffer`, который нужен bounded interactive stdin
Pyodide. После изменения любого runtime/static маршрута проверяйте
`window.crossOriginIsolated === true`; внешний ресурс без совместимого CORS/CORP
не должен добавляться в основной origin.

## LiveKit и TURN

Конфигурация SFU находится в `ops/livekit/livekit.yaml`. Комната ограничена
двумя участниками. WebRTC использует UDP `7882`, ICE/TCP fallback — `7881`,
встроенный TURN — UDP `3478`, TURN/TLS `5349` и relay range `35000-35049/udp`.
Сертификат `eduri.ru` монтируется read-only из `/etc/letsencrypt`; отдельный
поддомен не требуется.

`room.auto_create` обязательно остаётся `false`. App после проверки
session/capability и membership явно создаёт lesson/guest room через management
RPC на приватном `LIVEKIT_API_URL`, повторно проверяет авторизацию после RPC и только затем выпускает короткий
join JWT. JWT разрешает camera, microphone и screen share (включая audio), но не
data, metadata, room creation или room administration. Это не даёт старому JWT
воссоздать удалённую room после отзыва доступа. Node limits рассчитаны на
двухсторонние звонки: не более 64 tracks и 32 MB/s суммарного трафика на node;
subscription limits — 4 video и 2 audio tracks на участника.

Логический guest call resource сам по себе не резервирует media capacity и не
продлевает 48-часовой TTL guest room. Первый фактический call-token activation
занимает durable provisional slot на 15 минут. Presence poll продлевает его только
для реально занятой SFU room; повторные call-token запросы provisional lease не
продлевают. Неоднозначная ошибка provisioning сохраняет bounded lease, чтобы
параллельный успешный запрос не потерял reservation; подтверждённо пустая room
в одной transaction ставится в durable delete outbox, меняет внутреннюю room
generation и освобождает slot. Следующая активация использует другое имя, поэтому
задержавшийся retry старой room не может оборвать новый звонок. Лимит 32 относится
к activating/occupied calls, а `Retry-After` указывает
на ближайшее реальное окончание lease. Поэтому создание call resources с разных
IP не исчерпывает media capacity.

Migration 21 содержит LiveKit delete-room outbox. Lesson finish/cancel/delete,
account suspend/reset/change-secret и guest Call lease release/expiry/cancel
пишут старое opaque room name в той же SQLite transaction, что capability/status
mutation или cascade. Payload не содержит JWT, LiveKit keys, share key,
credential или participant identity. Worker запускается при старте, по явному
post-commit сигналу и отдельным пятисекундным timer. За один проход он обрабатывает
до четырёх batches по 16 rooms с concurrency 4; `404` означает success. Ошибка
оставляет row, увеличивает `attempts` максимум до 30 и назначает exponential
retry (5 секунд .. 15 минут); после 30 попыток job не удаляется и продолжает
повторяться с 15-минутным интервалом.

Проверка backlog без вывода capability payload:

```bash
sqlite3 data/eduri.sqlite "SELECT count(*) AS queued, max(attempts) AS max_attempts, min(next_attempt_at) AS next_retry FROM livekit_room_revocation_outbox;"
```

Ненулевой backlog во время краткого outage допустим. Растущий `queued`,
`max_attempts = 30` после восстановления management RPC или просроченный
`next_retry` дольше одного worker interval требуют alert/диагностики. Raw SDK
errors и room names не должны выводиться этим monitor или application logs.

Для медиатрафика увеличьте UDP buffers хоста и сохраните настройки после reboot:

```bash
sudo install -m 0644 ops/sysctl/99-eduri-livekit.conf \
  /etc/sysctl.d/99-eduri-livekit.conf
sudo sysctl --system
```

На VPS с 4 GB RAM должен быть аварийный swap, но нормальная работа не должна его
использовать. Запись и транскодирование на этом сервере не запускаются.

## Malware scanner для Code blobs и materials

Compose запускает pinned `clamav/clamav:1.4.6` по OCI digest, сохраняет базы
сигнатур в Docker volume `clamav-db-v2` и не публикует clamd port `3310` на host.
App передает bytes только по `INSTREAM`; ClamAV не монтирует `data/`. Production
config требует `CODE_BLOB_CLAMD_HOST`, а Compose задает внутреннее имя `clamav`
и не запускает app до healthy scanner. Тот же scanner является обязательной
fail-closed границей для file-materials. Для запуска API вне Compose нужно явно
указать host/port работающего clamd; отсутствие scanner не включает bypass, а
оставляет Code blob и file-material publication недоступными.

ClamAV использует официальный `/init-unprivileged` под пользователем `clamav`,
read-only root filesystem, `cap_drop: ALL`, no-new-privileges и только bounded
tmpfs для `/tmp`, `/run/clamav`, `/var/log/clamav`; writable persistent volume
оставлен только для сигнатур. Версионированные `ops/clamav/*.conf` заменяют
root-entrypoint mutation конфигурации и фиксируют scan/thread/queue limits.
Compose healthcheck отправляет `PING` на явный IPv4 loopback `127.0.0.1:3310`:
`clamd` намеренно слушает IPv4, поэтому image helper с `localhost`, который
может разрешиться в `::1`, не является корректной проверкой этой конфигурации.
Переход на `clamav-db-v2` намеренно создаёт volume из подписанной базы,
встроенной в pinned image, вместо повторного использования устаревшей базы из
прежнего `clamav-db`. Старый volume не удаляется автоматически и остаётся
доступен для расследования до успешных health/EICAR/clean-file smoke tests.

Clamd ограничен двумя scan threads, очередью, 25-секундным scan time, 40 MiB
stream/file и 96 MiB aggregate unpacked scan. Превышение лимитов и encrypted
archive считаются detection, а не clean. App ограничивает полный wall time
30 секундами и вход 32 MiB. Не увеличивайте client/server blob limit без
одновременного пересмотра ClamAV, RAM, archive-bomb guards и focused tests.

File-material ограничен 25 MiB. Перед multipart write app создаёт durable
reservation полного максимального размера и проверяет 2 GiB per-tutor, 20 GiB
global, не более 4/32 одновременных uploads, десятиминутный budget 100 MiB/1 GiB
и минимум 512 MiB свободного диска (production floor не ниже общего asset
setting). Scanner допускает не более 4 активных material scans и 64 ожидающих;
один legacy file при параллельных downloads сканируется ровно один раз.

Fileless materials имеют отдельные hard limits: 10 000 rows и 256 MiB UTF-8
text на tutor; 100 000 rows и 2 GiB global. За десять минут допускается 240
material mutations и 20 MiB material text на tutor, 2 400 mutations и 200 MiB
global. File reservations и material-mutation events имеют разные safe prefixes,
но хранятся в общей `material_upload_rate_events`, поэтому оба бюджета общие для
всех app workers и переживают restart. Не очищайте таблицу вручную для обхода
`429`; сначала проверьте источник нагрузки и окончание окна.

Миграция v17 добавляет reservations, scan attestations и
`material_file_gc_queue`. При startup незавершённые quarantine/final uploads
переносятся в GC, expired reservations очищаются каждую минуту. Удаление file
material или tutor записывает storage key в GC в той же transaction, что row
delete/cascade; unlink failure увеличивает `attempts` и повторяется после
restart. Не удаляйте private `uploads/.quarantine`, `uploads/files` или GC rows
вручную: это может нарушить crash-recovery contract.

Первый старт может занять несколько минут, пока загружаются базы сигнатур;
последующие старты используют volume и FreshClam обновляет его ежедневно.

Все внешние container images закреплены одновременно tag и OCI index digest. При
обновлении сначала сверьте digest и нужную архитектуру через registry API, затем
обновите container deployment contract test. Root filesystem app работает read-only;
единственные writable paths — bind mount `/app/data` и ограниченный tmpfs `/tmp`.
Проверка состояния и журналов:

```bash
docker compose ps app clamav livekit
docker compose logs --tail 100 clamav
```

ClamAV имеет лимит 1 GiB RAM и 0.75 CPU. Вместе с app и LiveKit это оставляет
маленький запас на 4 GB host, поэтому swap/OOM/container restart нужно наблюдать
особенно во время звонка и binary upload. Signature volume содержит только
восстанавливаемые публичные базы и намеренно не входит в Eduri data backup.

## Authentication rate limits

Миграция v18 создаёт `auth_rate_limit_buckets`. Это общее SQLite-хранилище
фиксированных 15-минутных login/activation окон для всех app workers. В нём есть
только HMAC subject hashes, counters и timestamps; raw IP, login, password,
student code и invite token туда не записываются. Buckets логически истекают
через два окна, удаляются при старте и ограниченными batches на следующих auth
requests, а их hard cap равен 50 000 rows. При заполнении cap новые subjects
отклоняются fail-closed.

После deploy проверьте с отдельного тестового IP повторные неверные login и
activation preview: после документированного бюджета ответ должен стать `429` с
одинаковым generic body, `Retry-After` и `Cache-Control: no-store`. Затем
убедитесь, что после конца фиксированного окна доступ восстанавливается без
ручной разблокировки. Не очищайте buckets в ответ на жалобу, пока не проверены
nginx source IP, время/NTP и признаки распределённого перебора.

## Хранилище и compaction Code sync

Миграция v13 добавляет к `code_documents` high-water sequence и агрегатные
счетчики. Она автоматически выполняется при старте приложения и backfill-ит их
из существующих `code_updates` и `code_update_receipts`. До первого запуска
версии с v13 обязателен обычный pre-deploy backup. Не удаляйте строки Code sync
и не создавайте snapshot вручную через SQL: snapshot является полным Yjs
update-v1 состоянием и должен пройти реконструкцию и schema validation.

Текущая server policy задана в коде и не является настройкой `.env`:

- soft compaction после 64 update rows или 2 MiB update-log bytes;
- hard limit 127 update rows и 64 MiB на snapshot + update log + state vector
  одного workspace;
- hard limit 32 768 durable receipts;
- не более 128 persisted parts в cold sync.

Receipts сохраняются после compaction, чтобы exact retry возвращал исходный
sequence. Pending Yjs dependency временно оставляет update в журнале и
откладывает compaction; predecessor на hard boundary принимается только если он
разрешает dependency и позволяет атомарно создать snapshot. Любой отказ по
row/byte/receipt quota откатывает update, receipt и счетчики одной SQLite
транзакцией.

Для read-only проверки крупнейших и приближающихся к лимитам workspace:

```bash
sqlite3 -readonly /home/user1/eduri/data/eduri.sqlite <<'SQL'
.headers on
.mode column
SELECT
  workspace.id AS workspace_id,
  workspace.room_resource_id,
  document.snapshot_sequence,
  document.last_sequence,
  document.update_log_count,
  document.snapshot_bytes + document.update_log_bytes
    + document.state_vector_bytes AS durable_bytes,
  document.receipt_count,
  document.compacted_at
FROM code_documents AS document
JOIN code_workspaces AS workspace ON workspace.id = document.workspace_id
WHERE document.update_log_count >= 64
   OR document.snapshot_bytes + document.update_log_bytes
        + document.state_vector_bytes >= 50331648
   OR document.receipt_count >= 24576
ORDER BY durable_bytes DESC, document.receipt_count DESC;
SQL
```

Пустой результат ожидаем. Устойчивый `update_log_count >= 64` означает, что
soft compaction не смогла завершиться: сначала ищите causal gap от старого
клиента или snapshot больше 4 MiB. `durable_bytes >= 50331648` и
`receipt_count >= 24576` — operational warning на 75% hard limit. Не повышайте
лимиты без одновременного пересмотра WebSocket frame guards, SQLite latency,
guest-room TTL, backup size и focused quota/compaction tests.

После миграции и при расследовании `STORAGE_ERROR` проверьте согласованность
счетчиков; запрос должен вернуть ноль строк:

```bash
sqlite3 -readonly /home/user1/eduri/data/eduri.sqlite <<'SQL'
SELECT document.id
FROM code_documents AS document
WHERE document.update_log_count != (
        SELECT COUNT(*) FROM code_updates AS update_row
        WHERE update_row.document_id = document.id
      )
   OR document.update_log_bytes != COALESCE((
        SELECT SUM(update_row.update_bytes) FROM code_updates AS update_row
        WHERE update_row.document_id = document.id
      ), 0)
   OR document.receipt_count != (
        SELECT COUNT(*) FROM code_update_receipts AS receipt
        WHERE receipt.document_id = document.id
      );
SQL
```

Миграция v20 создаёт `code_storage_usage` и singleton
`code_guest_storage_usage`, выполняет одноразовую сверку существующих Code
workspace и далее поддерживает счётчики SQLite-триггерами. Общий hard limit —
512 MiB учтённого guest Code CRDT storage. В него входят snapshot, state
vector, update payload, идентификаторы receipts и консервативный резерв под
строки/индексы. Проверка после миграции и operational warning на 75%:

```bash
sqlite3 -readonly /home/user1/eduri/data/eduri.sqlite <<'SQL'
.headers on
.mode column
SELECT * FROM code_guest_storage_usage WHERE singleton = 1;
SELECT workspace_id, accounted_bytes, receipt_count, metadata_bytes
FROM code_storage_usage
ORDER BY accounted_bytes DESC
LIMIT 20;
SQL
```

`accounted_bytes >= 402653184` требует расследования до исчерпания лимита.
Не редактируйте usage-таблицы вручную: quota admission читает их внутри той же
`BEGIN IMMEDIATE` транзакции, что записывает update и receipt. При удалении
истёкшей комнаты каскадные триггеры должны уменьшить singleton автоматически.

## Развертывание приложения

Скрипт не делает `git pull` и не получает исходники: нужная версия уже должна
находиться в `/home/user1/eduri`. Он проверяет `.env`, пересобирает app image и
получает pinned LiveKit/ClamAV images, пока прежний app продолжает обслуживать
запросы. После healthy state scanner и LiveKit скрипт останавливает app, создает
и проверяет pre-deploy backup с `--leave-stopped`, а затем сразу запускает новый
app. Поэтому backup является точной границей cutover и содержит все
подтвержденные записи прежней версии. Если scanner или LiveKit не стартовал,
cutover не начинается и прежний app остается доступен.

Docker выполняет `npm ci` до `COPY . .`, поэтому runtime assets намеренно не
копируются через `postinstall`. `npm run build:web` после копирования исходников
запускает `prepare:client-assets`: он проверяет точные package versions и
публикует Pyodide/Monaco из `node_modules` в `public/vendor` до Vite build.
Локальный `npm run dev` запускает тот же шаг. Не удаляйте его и не заменяйте
runtime URL на CDN: отсутствие исходников на стадии `npm ci` является ожидаемым.

До создания lock и backup скрипт сравнивает nginx virtual host и Certbot deploy
hook с системными копиями. Если они изменились, сначала выполните отдельный
root-only установщик; он делает `nginx -t` и reload, а при ошибке восстанавливает
старый nginx-конфиг автоматически:

```bash
# Выполнить в root shell (или через sudo у административного пользователя):
bash /home/user1/eduri/ops/scripts/install-edge-config.sh
```

Сам `deploy.sh` запускается только от `user1`: root создал бы backup и lock с
неверным владельцем и нарушил бы последующую ротацию. Если случайно запустить
`deploy.sh` от root при устаревшей edge-конфигурации, он обновит только её и
остановится до операций с данными; после этого повторите deploy от `user1`.

```bash
cd /home/user1/eduri
bash ops/scripts/deploy.sh
```

При неуспешном healthcheck скрипт сохраняет backup и показывает последние 100
строк app logs. Автоматического rollback image в MVP нет; не удаляйте предыдущий
image до smoke tests. Никогда не используйте `docker compose down -v`: bind mount
с данными не должен участвовать в очистке deployment artifacts.

Начиная с миграции v13, предыдущий image нельзя запускать как writer поверх уже
мигрированной базы: старый Code sync не поддерживает новые high-water counters и
может оставить их несогласованными. Rollback через предыдущий image допустим
только вместе с восстановлением matching pre-deploy backup, созданного до
миграции. Если данные после deploy нужно сохранить, исправляйте текущую версию
вперёд; не запускайте старый writer на новой схеме.

После deploy проверьте как минимум:

- вход admin, tutor и тестового student;
- generic `401` для неверного существующего и несуществующего login, а также
  временный generic `429`/`Retry-After` по source IP и account/token fingerprint
  без постоянной блокировки после завершения 15-минутного окна;
- создание и отзыв invite;
- доступ tutor только к собственному student;
- Socket.IO-доску из двух браузеров;
- на staging или с временно уменьшенными лимитами: app-wide Socket.IO admission
  отклоняет следующее соединение после total/per-IP cap, а disconnect немедленно
  освобождает место для нового соединения;
- на staging: malformed Socket.IO event размером около 5 MiB получает
  `RATE_LIMITED`/`rate-limited` и disconnect до protocol parse; parallel socket и
  reconnect того же user/workspace остаются ограничены до конца минутного окна,
  а Code revision/другие persisted данные не меняются;
- LiveKit camera/microphone/screen-share из двух браузерных сессий; проверить, что
  room не появляется от join JWT без предварительного app provisioning и не
  воссоздаётся старым JWT после удаления;
- семь независимых IP создают guest call resources без расходования media slots;
  slot появляется лишь при call-token activation, а для 33-го activation `429`
  содержит `Retry-After` до ближайшего lease; никогда не занятая room освобождается
  после 15 минут и presence confirmation;
- удаление test student и test tutor с активным звонком: HTTP session и
  Socket.IO/Board/Code connections отключены, participant/room исчезают до account
  cascade; при искусственно недоступном LiveKit ответ `503`, account остаётся
  suspended и успешно удаляется точным retry после восстановления RPC;
- на staging остановить management RPC, выполнить lesson finish, account
  suspend/reset и guest-room expiry, перезапустить app, восстановить RPC и
  убедиться, что migration-v21 jobs удалили старые rooms; concurrent re-enqueue
  не должен быть подтверждён старым in-flight worker, а job с `attempts = 30`
  остаётся durable и планирует следующий retry;
- ICE через UDP, затем отдельная проверка TCP/TURN fallback;
- загрузку материала и запуск Pyodide; в DevTools все runtime-запросы должны
  оставаться на `https://eduri.ru/vendor/pyodide/0.27.5/`, без jsDelivr/PyPI;
- загрузку чистого binary файла в guest Code room и отказ публикации стандартного
  EICAR test fixture с `MALWARE_DETECTED`; после отказа status/content не должны
  возвращать blob как ready;
- fail-closed поведение Code blob finalize при недоступном clamd: ответ `503`,
  отсутствие ready metadata и успешный exact retry после восстановления scanner;
- загрузку чистого file-material и отказ EICAR/недоступного clamd до появления
  material row или downloadable final file; проверить `422`/`503`, пустую
  quarantine и отсутствие осиротевшей reservation;
- управляемое превышение file quota/free-disk floor и fileless material row/write
  budget: явные `413`/`429`/`507`, без частично вставленной material row;
- удаление test tutor с file-material: database cascade оставляет durable GC
  event до успешного unlink; после имитации unlink failure и restart файл
  удаляется повторной обработкой очереди;
- отсутствие CSP, mixed-content и WebSocket ошибок в DevTools;
- `/api/health`, healthy `docker compose ps clamav livekit`, свежие ClamAV
  signatures и отсутствие ошибок в ClamAV/LiveKit logs;
- запрет GET и неавторизованного POST к `/twirp/`, а также отсутствие
  `/livekit/`, `/twirp/`, `/room/:shareKey` и
  `/api/guest/rooms/:shareKey/...` в nginx access log;
- ровно один COOP, CORP, X-Frame-Options и другие canonical security headers
  в production response, а также отсутствие COEP на основном origin;
- ответ `429` при управляемом превышении edge connection/request budget и
  нормальный reconnect без моргания после окончания burst;
- audit events.

## Ежедневные backup

Установка timer:

```bash
sudo bash /home/user1/eduri/ops/scripts/install-maintenance.sh --run-now
systemctl status eduri-backup.timer
journalctl -u eduri-backup.service --since today
```

Timer запускается ежедневно в 02:30 по timezone сервера со случайной задержкой
до 45 минут. Backup script берет общую maintenance lock, кратко останавливает
app, архивирует только `data/`, запускает app и проверяет health. Это дает
консистентную SQLite-копию, но создает короткое окно недоступности. Затем
проверяются SHA-256, структура tar и `PRAGMA quick_check` каждой найденной
SQLite-базы. Сохраняются 14 последних успешно созданных архивов.

Ручной запуск и повторная проверка:

```bash
bash ops/scripts/backup.sh
bash ops/scripts/check-backup.sh \
  /home/user1/eduri/backups/eduri-data-YYYYMMDDTHHMMSSNNNNNNNNNZ-PID.tar.gz
```

Backup состоит из `.tar.gz`, `.tar.gz.sha256` и `.tar.gz.meta`. В нем есть
персональные данные, результаты занятий и password hashes, поэтому права 0600
не заменяют шифрование. `.env` намеренно не входит в архив.

Четырнадцать копий на том же диске защищают от логической ошибки, но не от
поломки диска, удаления VM или компрометации сервера. После выбора хранилища
нужно добавить отдельную зашифрованную off-site репликацию с ключом вне сервера.
До этого disaster recovery остается незакрытым риском. Не добавляйте cloud
credentials прямо в scripts или systemd unit.

## Restore

Restore требует точный archive path и явную подтверждающую фразу. Перед заменой
данных он проверяет архив и, если текущая SQLite-база проходит integrity check,
создает еще одну текущую копию. Отсутствующая или поврежденная текущая база не
блокирует disaster recovery: во всех случаях исходный каталог не удаляется, а
перемещается в
`data.pre-restore-<timestamp>`. Если restored app не проходит healthcheck,
directory swap автоматически откатывается, а неудачные данные сохраняются в
`data.failed-restore-<timestamp>`.

```bash
bash ops/scripts/restore.sh \
  --archive /home/user1/eduri/backups/eduri-data-YYYYMMDDTHHMMSSNNNNNNNNNZ-PID.tar.gz \
  --confirm RESTORE-EDURI-DATA
```

После restore выполните полный smoke test. Удаляйте `data.pre-restore-*` и
`data.failed-restore-*` только вручную, по одному проверенному абсолютному пути,
после подтверждения корректности данных. Ежемесячно проводите restore drill на
изолированной машине; непротестированный архив не является надежным backup.

## Наблюдение и обновления

- Следите за `nginx`, `certbot.timer`, health контейнеров `app`/`clamav`/`livekit` и
  `eduri-backup.service`; настройте внешнюю проверку HTTPS и срока сертификата.
- Проверяйте FreshClam update errors и возраст signature database. Pinned ClamAV
  digest обновляется вручную после проверки новой patch image и EICAR/clean/
  outage smoke tests; старый engine нельзя оставлять после security advisory.
  Если CDN продолжает отвечать `403`, каждое проверенное обновление official
  non-base image должно использовать новый versioned DB volume (либо отдельный
  аудитируемый reseed): одна смена tag/digest не заменяет базу в уже смонтированном
  persistent volume. После deploy проверяйте активный ответ `VERSION`, возраст и
  подпись CVD; предыдущий volume сохраняйте до завершения smoke tests.
- Не логируйте cookie, Authorization, invite tokens, code words, `.env` или
  request bodies auth endpoints. Ограничьте retention логов.
- Обновления base image и npm dependencies сначала проверяйте на staging или
  локальной копии production backup.
- Регулярно проверяйте свободное место. Автоматическая ротация касается только
  строго распознанных Eduri backup; Docker images и журналы требуют отдельной,
  явно ограниченной политики.
- Проверяйте время сервера и NTP: session expiry, invite expiry, TLS и audit
  зависят от корректных часов.
- Во время звонков следите за CPU, RAM, packet loss и Docker restarts. При
  устойчивом CPU выше 60% или потерях выше 1% снижайте качество и разбирайте
  маршрут до добавления нагрузки.
- Следите за агрегатами `livekit_room_revocation_outbox` без выборки `room_name`:
  после восстановления LiveKit due backlog должен убывать. Attempts насыщается
  на 30, но job не теряется; длительный backlog означает неисправность private
  management plane либо worker.
