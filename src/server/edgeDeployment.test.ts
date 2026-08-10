import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nginx = readFileSync(
  new URL("../../ops/nginx/eduri.ru.conf", import.meta.url),
  "utf8",
);

function countLiteral(value: string): number {
  return nginx.split(value).length - 1;
}

function locationBlocks(opening: string): string[] {
  const lines = nginx.split(/\r?\n/u);
  const blocks: string[] = [];
  lines.forEach((line, start) => {
    if (line !== `    ${opening} {`) return;
    const end = lines.findIndex((candidate, index) => (
      index > start && candidate === "    }"
    ));
    if (end < 0) throw new Error(`Unterminated nginx location: ${opening}`);
    blocks.push(lines.slice(start, end + 1).join("\n"));
  });
  return blocks;
}

function locationBlock(opening: string): string {
  const blocks = locationBlocks(opening);
  if (blocks.length !== 1) {
    throw new Error(`Expected one nginx location for ${opening}, got ${blocks.length}`);
  }
  return blocks[0];
}

function regexLocationPattern(opening: string): RegExp {
  const match = /^location ~ "([^"]+)"$/u.exec(opening);
  if (!match) throw new Error(`Not a quoted regex location: ${opening}`);
  return new RegExp(match[1], "u");
}

describe("nginx edge deployment contract", () => {
  it("rejects unknown Host values and never reflects them into redirects", () => {
    expect(nginx).toContain("listen 80 default_server;");
    expect(nginx).toContain("listen 443 ssl http2 default_server;");
    expect(countLiteral("if ($host != eduri.ru) {")).toBe(2);
    expect(countLiteral("return 301 https://eduri.ru$request_uri;")).toBe(3);
    expect(nginx).not.toContain("https://$host$request_uri");
  });

  it("makes nginx the single authority for security headers", () => {
    const canonicalHeaders = [
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "X-Permitted-Cross-Domain-Policies",
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Embedder-Policy",
      "Cross-Origin-Resource-Policy",
      "Origin-Agent-Cluster",
      "X-DNS-Prefetch-Control",
      "X-Download-Options",
      "X-XSS-Protection",
      "Permissions-Policy",
      "Content-Security-Policy",
    ] as const;

    for (const name of canonicalHeaders) {
      expect(countLiteral(`add_header ${name} `), name).toBe(1);
      expect(countLiteral(`proxy_hide_header ${name};`), name).toBe(1);
    }

    expect(nginx).toContain('add_header X-Frame-Options "DENY" always;');
    expect(nginx).toContain('add_header Cross-Origin-Opener-Policy "same-origin" always;');
    expect(nginx).toContain('add_header Cross-Origin-Embedder-Policy "require-corp" always;');
    expect(nginx).toContain('add_header Cross-Origin-Resource-Policy "same-origin" always;');
    expect(nginx).toContain("proxy_hide_header Content-Security-Policy-Report-Only;");
    expect(nginx).toContain("proxy_hide_header X-Powered-By;");
  });

  it("never writes a valid guest bearer capability to the access log", () => {
    const roomOpening = 'location ~ "^/room/[A-Za-z0-9_-]{43}(?:/|$)"';
    const apiOpening = 'location ~ "^/api/guest/rooms/[A-Za-z0-9_-]{43}(?:/|$)"';
    const roomBlocks = locationBlocks(roomOpening);
    const capabilityApiBlocks = locationBlocks(apiOpening);
    const ordinaryGuestApi = locationBlock("location /api/guest/rooms");
    const key = "Abcdefghijklmnopqrstuvwxyz_0123456789-ABCDE";
    expect(key).toHaveLength(43);

    const roomPattern = regexLocationPattern(roomOpening);
    const apiPattern = regexLocationPattern(apiOpening);
    expect(roomPattern.test(`/room/${key}`)).toBe(true);
    expect(roomPattern.test(`/room/${key}/board`)).toBe(true);
    expect(apiPattern.test(`/api/guest/rooms/${key}`)).toBe(true);
    expect(apiPattern.test(`/api/guest/rooms/${key}/code-blobs/begin`)).toBe(true);
    expect(roomPattern.test(`/room/${key.slice(1)}`)).toBe(false);
    expect(apiPattern.test("/api/guest/rooms")).toBe(false);

    expect(roomBlocks).toHaveLength(2);
    expect(capabilityApiBlocks).toHaveLength(2);
    for (const block of [...roomBlocks, ...capabilityApiBlocks]) {
      expect(block).toContain("access_log off;");
    }
    expect(roomBlocks[0]).toContain("return 301 https://eduri.ru$request_uri;");
    expect(capabilityApiBlocks[0]).toContain("return 301 https://eduri.ru$request_uri;");
    expect(roomBlocks[1]).toContain("proxy_pass http://127.0.0.1:3020;");
    expect(capabilityApiBlocks[1]).toContain("proxy_pass http://127.0.0.1:3020;");
    expect(roomBlocks[1]).toContain("error_log /var/log/nginx/error.log crit;");
    expect(capabilityApiBlocks[1]).toContain("error_log /var/log/nginx/error.log crit;");
    expect(ordinaryGuestApi).not.toContain("access_log off;");
    expect(countLiteral("access_log off;")).toBe(7);
  });

  it("bounds every public realtime and guest edge per IP without losing upgrades", () => {
    const contracts = [
      {
        zone: "limit_conn_zone $binary_remote_addr zone=eduri_board_connections:1m;",
        rate: "limit_req_zone $binary_remote_addr zone=eduri_board_handshakes:1m rate=5r/s;",
        opening: "location = /api/board-v2/sync",
        conn: "limit_conn eduri_board_connections 8;",
        req: "limit_req zone=eduri_board_handshakes burst=10 nodelay;",
        websocket: true,
      },
      {
        zone: "limit_conn_zone $binary_remote_addr zone=eduri_socketio_connections:1m;",
        rate: "limit_req_zone $binary_remote_addr zone=eduri_socketio_requests:1m rate=10r/s;",
        opening: "location ^~ /socket.io/",
        conn: "limit_conn eduri_socketio_connections 16;",
        req: "limit_req zone=eduri_socketio_requests burst=20 nodelay;",
        websocket: true,
      },
      {
        zone: "limit_conn_zone $binary_remote_addr zone=eduri_guest_connections:1m;",
        rate: "limit_req_zone $binary_remote_addr zone=eduri_guest_requests:1m rate=5r/s;",
        opening: "location /api/guest/rooms",
        conn: "limit_conn eduri_guest_connections 24;",
        req: "limit_req zone=eduri_guest_requests burst=20 nodelay;",
        websocket: false,
      },
      {
        zone: "limit_conn_zone $binary_remote_addr zone=eduri_livekit_connections:1m;",
        rate: "limit_req_zone $binary_remote_addr zone=eduri_livekit_handshakes:1m rate=5r/s;",
        opening: "location ^~ /livekit/",
        conn: "limit_conn eduri_livekit_connections 16;",
        req: "limit_req zone=eduri_livekit_handshakes burst=10 nodelay;",
        websocket: true,
      },
    ] as const;

    expect(countLiteral("limit_conn_status 429;")).toBe(1);
    expect(countLiteral("limit_req_status 429;")).toBe(1);
    for (const contract of contracts) {
      expect(nginx).toContain(contract.zone);
      expect(nginx).toContain(contract.rate);
      const block = locationBlock(contract.opening);
      expect(block).toContain(contract.conn);
      expect(block).toContain(contract.req);
      if (contract.websocket) {
        expect(block).toContain("proxy_http_version 1.1;");
        expect(block).toContain("proxy_set_header Upgrade $http_upgrade;");
        expect(block).toContain("proxy_set_header Connection $eduri_connection_upgrade;");
        expect(block).toContain("proxy_read_timeout 1h;");
      }
    }
    const livekit = locationBlock("location ^~ /livekit/");
    expect(livekit).toContain("error_log /var/log/nginx/error.log crit;");
  });

  it("never exposes the LiveKit management plane on the public origin", () => {
    const twirp = locationBlock("location ^~ /twirp");
    const nestedTwirp = locationBlock("location ^~ /livekit/twirp");
    for (const block of [twirp, nestedTwirp]) {
      expect(block).toContain("return 404;");
      expect(block).toContain("access_log off;");
      expect(block).toContain("error_log /var/log/nginx/error.log crit;");
      expect(block).not.toContain("proxy_pass");
    }
    expect(nginx).not.toContain("eduri_twirp_");
  });
});
