#!/usr/bin/env sh
set -eu

APP_ROOT="/home/user1/eduri"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
LIVEKIT_HEALTH_URL="http://127.0.0.1:7880/"
TURN_CERTIFICATE="/etc/letsencrypt/live/eduri.ru/fullchain.pem"
TURN_PRIVATE_KEY="/etc/letsencrypt/live/eduri.ru/privkey.pem"

NGINX="/usr/sbin/nginx"
SYSTEMCTL="/usr/bin/systemctl"
DOCKER="/usr/bin/docker"
CURL="/usr/bin/curl"
OPENSSL="/usr/bin/openssl"
TIMEOUT="/usr/bin/timeout"
SLEEP="/usr/bin/sleep"

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

for executable in "$NGINX" "$SYSTEMCTL" "$DOCKER" "$CURL" "$OPENSSL" "$TIMEOUT" "$SLEEP"; do
    [ -x "$executable" ] || die "required executable is missing: $executable"
done
[ -f "$COMPOSE_FILE" ] || die "missing Docker Compose file: $COMPOSE_FILE"
[ -r "$TURN_CERTIFICATE" ] || die "TURN certificate is not readable: $TURN_CERTIFICATE"
[ -r "$TURN_PRIVATE_KEY" ] || die "TURN private key is not readable: $TURN_PRIVATE_KEY"

# Validate both service configurations before replacing either process.
"$DOCKER" compose --project-directory "$APP_ROOT" \
    --file "$COMPOSE_FILE" config --quiet
"$NGINX" -t

"$SYSTEMCTL" reload nginx
if ! "$DOCKER" compose --project-directory "$APP_ROOT" \
    --file "$COMPOSE_FILE" restart livekit; then
    "$DOCKER" compose --project-directory "$APP_ROOT" \
        --file "$COMPOSE_FILE" logs --tail 100 livekit >&2 || true
    die "LiveKit restart failed after certificate renewal"
fi

attempt=1
while [ "$attempt" -le 45 ]; do
    if "$CURL" --fail --silent --show-error --max-time 3 \
        "$LIVEKIT_HEALTH_URL" >/dev/null 2>&1; then
        break
    fi
    if [ "$attempt" -eq 45 ]; then
        "$DOCKER" compose --project-directory "$APP_ROOT" \
            --file "$COMPOSE_FILE" ps livekit >&2 || true
        "$DOCKER" compose --project-directory "$APP_ROOT" \
            --file "$COMPOSE_FILE" logs --tail 100 livekit >&2 || true
        die "LiveKit did not become healthy after certificate renewal"
    fi
    attempt=$((attempt + 1))
    "$SLEEP" 2
done

expected_fingerprint="$(
    "$OPENSSL" x509 -in "$TURN_CERTIFICATE" -noout -sha256 -fingerprint
)"

attempt=1
presented_fingerprint=""
while [ "$attempt" -le 15 ]; do
    if presented_fingerprint="$(
        "$TIMEOUT" 5 "$OPENSSL" s_client \
            -connect 127.0.0.1:5349 -servername eduri.ru </dev/null 2>/dev/null \
            | "$OPENSSL" x509 -noout -sha256 -fingerprint 2>/dev/null
    )" && [ "$presented_fingerprint" = "$expected_fingerprint" ]; then
        break
    fi
    if [ "$attempt" -eq 15 ]; then
        "$DOCKER" compose --project-directory "$APP_ROOT" \
            --file "$COMPOSE_FILE" logs --tail 100 livekit >&2 || true
        die "LiveKit TURN/TLS is not presenting the renewed certificate"
    fi
    attempt=$((attempt + 1))
    "$SLEEP" 2
done

printf 'Renewed certificate loaded by nginx and LiveKit TURN/TLS.\n'
