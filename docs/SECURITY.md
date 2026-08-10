# Security model

Development/test entrypoint привязан к `127.0.0.1`; известные локальные
development credentials не должны быть доступны другим узлам LAN. Production
слушает все container interfaces только с обязательной fail-closed проверкой
секретов, а host publication остаётся loopback-only за nginx.

Production принимает `X-Real-IP`/forwarding attribution только от точного
Compose gateway `10.253.0.1`. Boolean/hop-count proxy trust запрещён, поэтому
скомпрометированный sibling container не может подменить source IP и обойти
application rate/admission budgets.

Nginx отклоняет неизвестный Host на default HTTP/HTTPS listeners кодом `444`;
canonical HTTP redirect строится только с фиксированным `eduri.ru`, поэтому
Host-header injection не создаёт attacker-controlled redirect.

Public CI независимо отклоняет force-added database/WAL/archive/private-key и
environment credential paths, проверяет magic bytes SQLite/private keys,
запускает `npm audit --audit-level=low` и сканирует полную Git history pinned
Gitleaks binary с проверяемым SHA-256. В настройках public GitHub repository
дополнительно включаются Secret Protection, push protection, Dependabot alerts
и branch protection для CI/CodeQL/security jobs; bypass секретов не является
обычным способом публикации.

ClamAV, разбирающий недоверенные Code blobs, запускается как `clamav` через
официальный unprivileged entrypoint, без Linux capabilities и с read-only root
filesystem. Только signature volume и bounded noexec tmpfs остаются writable;
app data в scanner container не монтируется.

Eduri хранит данные преподавателей и несовершеннолетних учеников и доступен из
интернета, даже если регистрация закрыта. «Непубличный» сервис не считается
доверенной сетью. Ниже зафиксированы границы безопасности MVP и обязательные
операционные меры.

## Активы и границы доверия

Наиболее чувствительные активы:

- admin/tutor credentials, student code hashes, sessions и invite tokens;
- имена учеников, история занятий, домашние работы и материалы;
- содержимое досок, загруженные файлы и результаты исполнения кода;
- SQLite database, audit log, `.env`, TLS/SSH keys и backup archives;
- право создать tutor, student, invite или присоединиться к lesson room.

Основные границы: browser -> public nginx -> app на loopback -> SQLite/data;
browser -> nginx -> self-hosted LiveKit/WebRTC/TURN; browser -> nginx ->
self-hosted pinned Pyodide/Monaco static assets; Socket.IO room; Docker host;
локальные и off-site backup. npm registry остается build-time поставщиком, но
browser не обращается к CDN или PyPI при загрузке runtime и выполнении кода.

Рассматриваемые атакующие:

- интернет-бот, перебирающий login, code word или invite URL;
- авторизованный student, меняющий resource IDs или Socket.IO room IDs;
- tutor, пытающийся получить tenant другого tutor;
- похититель invite/session link или скомпрометированного browser;
- вредоносный upload, код ученика или dependency/CDN compromise;
- злоумышленник с украденным SSH/admin credential или backup archive.

Компрометация устройства tutor/admin и целевая атака уровня государства не
устраняются приложением; их риск снижается MFA, обновлениями endpoint, disk
encryption и минимальными правами.

## Обязательные инварианты

- Публичного signup нет. Tutor создается только admin, student — tutor внутри
  собственного tenant.
- Client никогда не назначает себе `role`, `tenant_id`, `owner_id` или
  `created_by`. Они берутся из server-side session.
- Любой tenant resource читается/изменяется по `(resource_id, tenant_id)`;
  student дополнительно ограничен собственным `student_id` и назначениями.
- Одинаковые отображаемые имена допустимы. Если вход использует только имя и
  code word, полная пара должна быть уникальна: две одинаковые пары невозможно
  однозначно сопоставить аккаунтам. Для lookup используется keyed fingerprint,
  а для проверки — медленный password hash; raw code не хранится и не логируется.
- Invite — случайный одноразовый bearer token с коротким TTL; в базе хранится
  hash. GET не активирует аккаунт, повторная выдача отзывает предыдущий token.
- Reset code, password/code change, смена роли, suspend и credential compromise
  в одной SQLite transaction отзывают все sessions, меняют capability имена
  scheduled/active lesson rooms и ставят прежние opaque room names в durable
  delete outbox. После commit realtime connections отключаются, а worker
  немедленно запускается; сбой management RPC не теряет отзыв и повторяется
  после restart. Outbox не хранит JWT, API key, guest share key, credential или
  participant identity.
  Удаление student или tutor сначала атомарно переводит account в `suspended`,
  отзывает HTTP sessions и через общий registry отключает Socket.IO, Board и Code
  connections. До database cascade server обязан успешно отозвать participant и
  удалить все scheduled/active LiveKit rooms удаляемого пользователя; при ошибке
  management RPC удаление возвращает `503`, account остается suspended, а точный
  retry после восстановления LiveKit безопасно завершает cascade и material GC.
  Та же suspension transaction заранее сохраняет delete-room outbox target как
  дополнительную restart-safe страховку, но worker не заменяет strict
  revoke-before-cascade границу удаления account.
- Admin/tutor используют более сильную staff authentication; MFA обязательно
  перед расширением доступа другим преподавателям.
- WebSocket проверяет Origin, session, tenant и room membership не только при
  handshake, но и для каждого изменения состояния.
- HTTPS обязателен. App port доступен только через loopback; database/data не
  публикуются nginx и не монтируются в web root.

Ошибки входа не раскрывают существование имени/account. Login и activation
используют общий для всех app workers SQLite limiter одновременно по source IP и
keyed credential/account fingerprint. Raw IP, login и invite token в limiter не
хранятся: subject идентифицируется HMAC-SHA-256 с `AUTH_LOOKUP_KEY`. За 15 минут
разрешается 30 login attempts с одного IP, 15 на один staff/student account
fingerprint, 30 activation requests с IP и 10 на один invite token. Превышение
любой границы возвращает одинаковый `429` с `Retry-After` и
`Cache-Control: no-store`, не раскрывая, какая граница сработала или существует
ли account.

Окна фиксированные и не продлеваются повторными отклонёнными запросами, поэтому
permanent account lockout отсутствует. Успешный login/activation очищает
соответствующий account/token bucket. Неактивные bucket rows перестают
участвовать в решении максимум через два окна, удаляются при старте и
ограниченными batches на следующих auth requests. Жёсткая граница в 50 000 rows
fail-closed не позволяет распределённой атаке неограниченно увеличивать SQLite.
Express доверяет proxy headers только от loopback nginx.

Новая student code phrase должна после NFKC-normalization содержать минимум 10
символов и не быть распространённым, полностью цифровым, повторяющимся или
совпадающим с именем входа значением. Эта policy применяется только при
activation/reset/change: существующие bcrypt hashes коротких legacy code phrases
остаются пригодны для login и не блокируются миграцией.

## Upload, board, video и code execution

Upload ограничивается размером и allowlist типов, получает server-generated
filename и хранится вне web root. Скачать файл можно только после tenant ACL;
активный HTML/SVG отдается как attachment либо с отдельного недоверенного origin.

Capability-scoped guest Code blobs допускают произвольные binary bytes, поэтому
для них malware scan является fail-closed границей публикации. До 32 MiB
принимаются только в private staging вне web root, после полной проверки размера
и SHA-256 передаются в отдельный ClamAV container по bounded `INSTREAM`. Строка
`code_blobs`, status `ready`, dedup и download становятся доступны только после
явного ответа `clean` и durable server-side scan attestation. `FOUND` удаляет
upload/старую unverified blob metadata и ставит private bytes в GC; timeout,
ошибка протокола, недоступный scanner и превышение scanner limit возвращают
fail-closed ошибку без публикации. Существующие до migration v14 blob rows не
считаются чистыми и проходят scan при первом dedup/read. Clamd не получает mount
к `data/`, а его TCP port не публикуется на host. Download по capability всегда
остается attachment с `nosniff`.

Обычные file-materials используют ту же fail-closed malware boundary. Multer
пишет bytes только в private `.quarantine`; до ответа scanner `clean`, проверки
реального regular-file размера и SHA-256 строка `materials` не публикуется.
Публикация private final file, полной scan attestation и material row связана
durable reservation/outbox протоколом. `FOUND` удаляет quarantine bytes; timeout,
ошибка scanner/protocol или недоступность ClamAV возвращает явный fail-closed
ответ. Legacy file rows с пустой attestation проходят scan при первом download;
одновременные запросы одного legacy file используют один in-flight scan, а все
material scans ограничены четырьмя активными и bounded очередью. Final storage
keys immutable и находятся вне web root; download повторно проверяет tenant ACL,
regular-file metadata и отдаёт attachment с `nosniff`.

File reservations транзакционно учитывают ready bytes, конкурентные uploads,
per-tutor/global quotas, десятиминутный write budget и free-disk floor до записи.
Fileless note/task/link spam также ограничен persistent per-tutor/global
material row, UTF-8 text-byte, write-count и write-byte budgets; проверка и
запись event выполняются в той же SQLite transaction, что material mutation.
Удаление material или tutor ставит private keys в durable GC queue в одной
transaction с database cascade. Ошибка unlink не возвращает удалённую запись и
не теряет file: queue переживает restart и повторяется maintenance worker.

Знание lesson/board ID не дает права присоединиться. Signaling и persisted board
operations проверяют участника занятия. LiveKit JWT выдаётся только участнику
конкретного незавершённого lesson, ограничен одной room и живёт 15 минут. TURN
credentials также короткоживущие; постоянный LiveKit API secret не отправляется
browser. WebSocket handshake передаёт room JWT в query string, поэтому nginx
access log для `/livekit/` отключён. Серверные management RPC идут по приватному
`LIVEKIT_API_URL` на точный loopback/RFC1918 IP; production отклоняет hostname и
публичный адрес, а публичные `/twirp/` и `/livekit/twirp/` безусловно возвращают
`404`. Для URL с
guest/LiveKit bearer capability nginx также подавляет не-критические location
error logs, чтобы rejected rate-limit запрос не записал секретный URI.
LiveKit работает с `room.auto_create: false`: приложение явно создаёт только
авторизованную lesson/guest room перед выдачей JWT и повторно проверяет
account/session/membership после management RPC. Join JWT не имеет room-create или
admin grants, не может публиковать data/metadata и ограничен camera, microphone,
screen share и screen-share audio. Поэтому старый, ещё не истёкший JWT не может
заново создать room после удаления lesson, student или tutor.
Завершение/отмена/удаление lesson атомарно меняет meeting capability и ставит
старую room в migration-v21 outbox до изменения/cascade. Worker обрабатывает
только opaque room name, признаёт `404` успешным, защищает concurrent re-enqueue
generation/CAS-проверкой и никогда не удаляет job из-за достижения лимита
попыток: счётчик насыщается на 30, backoff — на 15 мин, а retry продолжается.
Guest call получает persistent provisional activation lease на 15 минут только
при фактическом запросе call token; создание логического call resource не занимает
один из 32 media slots и не продлевает 48-часовой TTL комнаты. Каноническое
присутствие продлевает lease, подтверждённо пустой SFU room атомарно ставится в
outbox, сменяет внутреннюю room generation и освобождает lease, а
`Retry-After` вычисляется по ближайшему реальному окончанию активного lease.
Валидные guest share keys дают bearer-доступ, поэтому URL вида `/room/:shareKey`
и `/api/guest/rooms/:shareKey/...` также исключены из nginx access log как на HTTPS,
так и на HTTP→HTTPS redirect.
Независимые per-IP edge budgets ограничивают concurrent connections и request bursts
для Board WebSocket, Socket.IO, guest API и LiveKit signaling; они не заменяют
проверку session/capability и tenant/account quotas в app.
Socket.IO дополнительно имеет app-wide Engine.IO admission: total/per-IP
connection caps, fixed global/IP handshake-attempt budgets и bounded IP registry.
Каждый namespace-auth packet и event учитывается по conservative byte size до
application parse/validation; malformed payload не является бесплатным. После
auth общий guard одновременно применяет process-global, trusted-IP и стабильный
user/workspace budget. Нарушение блокирует event и разрывает socket, а parallel
connections, device/session rotation и reconnect не сбрасывают окно. Admission
reservation освобождается при disconnect и по короткому timeout незавершённого
handshake; `X-Real-IP` доверяется только при совпадении direct peer с точным
настроенным IP nginx.
Запись аудио/видео по умолчанию выключена и не включается без явного согласия и
политики retention.

Код ученика нельзя выполнять в основном app container или shell сервера. Для
server-side execution необходим одноразовый non-root sandbox без host mounts и
secrets, с запрещенным/allowlisted network egress, seccomp и лимитами CPU, RAM,
PID, output и времени. Browser Pyodide уменьшает server RCE risk, но не является
полной границей для секретов browser. Pyodide `0.27.5` и Monaco `0.55.1`
фиксируются lock-файлом, копируются из npm packages в same-origin build assets и
не загружаются с CDN/PyPI во время работы. Каждый явный browser-run получает новый
Worker; client завершает его после результата, ошибки protocol/runtime/worker,
отмены или 45-секундного timeout, а Worker также сам закрывается после terminal
response. Loader получает пустой frozen `jsglobals`; после загрузки только
pinned runtime и до первого пользовательского Python вызова Worker удаляет
известные network, persistent-storage, cross-tab и nested-worker API. Если хотя
бы один из них нельзя удалить, выполнение fail closed. Это не позволяет Python
state и MEMFS пережить запуск и закрывает известные browser capabilities, но
blacklist на основном application origin все еще не равен отдельному sandbox
origin и не считается общей границей для произвольного недоверенного кода.

## Credential rotation

Любой credential, опубликованный в чате, issue, логе или shell transcript,
считается скомпрометированным. Переданный ранее SSH password необходимо сменить
до запуска production. Затем:

1. Добавьте отдельный SSH key, проверьте новую сессию и только потом отключите
   password authentication/root login.
2. Ограничьте SSH firewall, удалите неиспользуемые authorized keys и проверьте
   `auth.log` за период возможной компрометации.
3. Создайте новые случайные app/admin secrets вне репозитория, отзовите sessions
   и незавершенные invites, затем проверьте audit.
4. Не удаляйте старый secret до завершения миграции данных, если он участвует в
   keyed lookup/encryption.

`AUTH_LOOKUP_KEY` нельзя просто заменить, если сохраненные student login
fingerprints вычислены этим ключом. Нужна versioned dual-key migration при
успешном login либо принудительный reset student codes. Ротация password hashing
parameters применяется к новым секретам и при штатном reset/change flow;
существующий hash с прежней стоимостью сам по себе при login не переписывается.
Admin/tutor credential меняется через штатный reset flow, после чего sessions
отзываются.

TLS renew выполняет Certbot timer; deploy hook reload-ит nginx, перезапускает
LiveKit и сверяет сертификат TURN/TLS с обновлённым файлом. LiveKit/TURN, SMTP,
object storage, registry и off-site backup keys ротируются отдельно и никогда
не попадают в frontend bundle.
Периодическая смена сильного password без признаков компрометации не заменяет
MFA; ротация обязательна при утечке, увольнении, смене владельца или подозрении
на доступ.

Минимальный порядок ротации: проверить свежий backup, выпустить новый secret,
развернуть dual-read/new-write при необходимости, отозвать старый, сбросить
sessions, выполнить smoke test и сохранить audit event. Старые backup могут
содержать прежние hashes/keys и остаются чувствительными до конца retention.

## Backup и incident response

Локальный timer делает одну консистентную копию в день и хранит 14 последних.
Целевой RPO MVP — до 24 часов, а RTO зависит от ручного restore и smoke tests.
Backup кратко останавливает app, потому что обычный tar работающей SQLite/WAL и
uploads не гарантирует согласованность.

Каждый archive получает SHA-256 и проходит tar/path/type validation и SQLite
`PRAGMA quick_check`. Это обнаруживает повреждение, но SHA-256 sidecar рядом с
архивом не защищает от атакующего, изменившего оба файла. Для off-site нужен
authenticated encryption или immutable storage с отдельным ключом/account.

При инциденте:

1. Сохраните логи и snapshot, ограничьте сеть; не уничтожайте доказательства
   немедленным reinstall.
2. Отзовите затронутые sessions/invites/keys с чистого устройства.
3. Определите tenants и данные в зоне риска по audit и инфраструктурным логам.
4. Восстановите из проверенной копии только после устранения точки входа.
5. Смените все secrets, доступные с скомпрометированного уровня, и сообщите
   затронутым пользователям в соответствии с применимыми требованиями.
6. Зафиксируйте timeline, root cause и конкретные предотвращающие изменения.

## Известные ограничения MVP

- SQLite и один host не дают high availability, point-in-time recovery или
  database row-level security. Tenant isolation пока зависит от корректности
  application queries и обязательных cross-tenant tests.
- Backup вызывает короткий downtime. 14 локальных копий находятся на том же
  диске; автоматической encrypted off-site репликации пока нет.
- Автоматического rollback Docker image и полноценного staging environment нет.
- LiveKit и приложение находятся на одном host: отказ или компрометация VPS
  затрагивает одновременно данные и звонки. WebRTC transport encrypted, но SFU
  не является E2EE boundary; server-side запись при этом отключена.
- CSP не разрешает внешние script/connect origins: pinned Pyodide и Monaco
  обслуживаются самим Eduri. `unsafe-inline` остается только для styles, а
  build-time npm dependency compromise остается supply-chain риском и требует
  проверки lock-файла и собранных artifacts.
- Site-wide cross-origin isolation включена canonical COOP+COEP заголовками
  nginx. Её сохранность зависит от того, что все загружаемые runtime/static
  ресурсы остаются same-origin либо имеют совместимый CORS/CORP; production QA
  проверяет `window.crossOriginIsolated === true`.
- Browser Pyodide не заменяет hardened sandbox. Без отдельного runner нельзя
  безопасно предлагать server-side запуск произвольного кода.
- ClamAV signature scanning покрывает guest Code blobs и file-materials, но не
  является DLP или доказательством безопасности файла. Materials не являются
  произвольным публичным file exchange: доступ остаётся tenant-scoped.
  Централизованный immutable audit, SIEM/alerting, automated secret manager и
  формальная data retention policy еще не внедрены.
- Пока staff MFA/passkeys, recovery codes и step-up authentication не реализованы
  и не протестированы end-to-end, доступ другим tutors расширять нельзя.

Перед переходом от личного использования к нескольким tutors нужен отдельный
security review authorization matrix, cross-tenant integration tests, backup
restore drill и проверка обработки данных несовершеннолетних.
# Guest rooms and code execution

Guest-room capability, expiry, activity, and deletion rules are normative in
[`GUEST_ROOMS_ARCHITECTURE.md`](./GUEST_ROOMS_ARCHITECTURE.md). Code workspace
and sandbox requirements are normative in
[`CODE_WORKSPACE_ARCHITECTURE.md`](./CODE_WORKSPACE_ARCHITECTURE.md). In
particular, unrestricted Python must never execute inside the Eduri API
container or with server/LAN network access.
