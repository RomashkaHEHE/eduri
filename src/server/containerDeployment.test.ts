import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const NODE_IMAGE = "node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436";
const CLAMAV_IMAGE = "clamav/clamav:1.4.6@sha256:7173cd3d57a839c6fee673b07246301e0d1f68f5a14a5ca063f502323bf1cc61";
const LIVEKIT_IMAGE = "livekit/livekit-server:v1.13.4@sha256:189f7c81b704a36642bc5c7e2d3e1ae83744627c11978a23a251bf19fbec64e0";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
const clamdConfig = readFileSync(new URL("../../ops/clamav/clamd.conf", import.meta.url), "utf8");
const livekitConfig = readFileSync(
  new URL("../../ops/livekit/livekit.yaml", import.meta.url),
  "utf8",
);

function composeService(name: string): string {
  const lines = compose.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`Missing Compose service: ${name}`);

  const nextService = lines.findIndex((line, index) => (
    index > start && /^  [a-z0-9_-]+:\s*$/u.test(line)
  ));
  return lines.slice(start, nextService < 0 ? undefined : nextService).join("\n");
}

describe("container deployment contract", () => {
  it("pins every external image to an immutable OCI digest", () => {
    const nodeStages = dockerfile.match(/^FROM node:[^\s]+/gmu) ?? [];
    expect(nodeStages).toEqual([`FROM ${NODE_IMAGE}`, `FROM ${NODE_IMAGE}`]);

    const imageLines = compose.match(/^\s+image:\s+\S+/gmu) ?? [];
    expect(imageLines).toHaveLength(2);
    expect(composeService("clamav")).toContain(`image: ${CLAMAV_IMAGE}`);
    expect(composeService("livekit")).toContain(`image: ${LIVEKIT_IMAGE}`);
    for (const line of imageLines) expect(line).toMatch(/@sha256:[0-9a-f]{64}$/u);
  });

  it("runs npm lifecycle scripts as the unprivileged node user", () => {
    const buildStage = dockerfile.split(/^FROM /mu)[1] ?? "";
    expect(buildStage).toMatch(/\nUSER node\nCOPY --chown=node:node package\*\.json \.\/\nRUN npm ci\n/u);
    expect(dockerfile.match(/^USER node$/gmu)).toHaveLength(2);
  });

  it("keeps the app root filesystem read-only with only bounded writable mounts", () => {
    const app = composeService("app");
    expect(app).toMatch(/environment:\n\s+NODE_ENV: production\n\s+TRUST_PROXY: "10\.253\.0\.1"\n\s+LIVEKIT_API_URL: "http:\/\/10\.253\.0\.1:7880"/u);
    expect(app).toMatch(/volumes:\n\s+- \.\/data:\/app\/data\n\s+ports:/u);
    expect(app).toContain("read_only: true");
    expect(app).toMatch(/tmpfs:\n\s+- \/tmp:size=64m,mode=1777,noexec,nosuid,nodev\n\s+security_opt:/u);
    expect(app).toContain("- no-new-privileges:true");
    expect(app).toMatch(/cap_drop:\n\s+- ALL/u);
    expect(app).toMatch(/networks:\n\s+eduri_backend:\n\s+ipv4_address: 10\.253\.0\.2/u);
    expect(composeService("clamav")).toMatch(
      /networks:\n\s+eduri_backend:\n\s+ipv4_address: 10\.253\.0\.3/u,
    );
    expect(compose).toMatch(
      /networks:\n\s+eduri_backend:\n\s+driver: bridge\n\s+ipam:\n\s+config:\n\s+- subnet: 10\.253\.0\.0\/24\n\s+gateway: 10\.253\.0\.1/u,
    );
  });

  it("runs the untrusted-file scanner unprivileged and read-only", () => {
    const clamav = composeService("clamav");
    expect(clamav).toContain("user: clamav");
    expect(clamav).toContain('entrypoint: ["/init-unprivileged"]');
    expect(clamav).toContain("read_only: true");
    expect(clamav).toMatch(/cap_drop:\n\s+- ALL/u);
    expect(clamav).toContain("- ./ops/clamav/clamd.conf:/etc/clamav/clamd.conf:ro");
    expect(clamav).toContain("- ./ops/clamav/freshclam.conf:/etc/clamav/freshclam.conf:ro");
    expect(clamav).toContain("- clamav-db-v2:/var/lib/clamav");
    expect(compose).toMatch(/^\s{2}clamav-db-v2:\s*$/mu);
    expect(compose).not.toMatch(/^\s{2}clamav-db:\s*$/mu);
    expect(clamav).toContain("- /tmp:size=128m,mode=1777,noexec,nosuid,nodev");
    expect(clamav).toContain("- /run/clamav:size=4m,uid=100,gid=101,mode=0755,noexec,nosuid,nodev");
    expect(clamav).toContain("- /var/log/clamav:size=16m,uid=100,gid=101,mode=0755,noexec,nosuid,nodev");
    expect(clamav).not.toMatch(/^\s+ports:/mu);
    expect(clamav).toContain(
      'test: ["CMD-SHELL", "echo PING | nc -w 3 127.0.0.1 3310 | grep -qx PONG"]',
    );
    expect(clamav).not.toContain('test: ["CMD", "clamdcheck.sh"]');
    expect(clamdConfig).toMatch(/^User clamav$/mu);
    expect(clamdConfig).toMatch(/^TCPSocket 3310$/mu);
    expect(clamdConfig).toMatch(/^TCPAddr 0\.0\.0\.0$/mu);
    expect(clamdConfig).toMatch(/^MaxThreads 2$/mu);
    expect(clamdConfig).toMatch(/^MaxQueue 4$/mu);
    expect(clamdConfig).toMatch(/^MaxScanTime 25000$/mu);
  });

  it("disables JWT-driven room creation and bounds the two-person media node", () => {
    expect(livekitConfig).toMatch(
      /bind_addresses:\n\s+- 127\.0\.0\.1\n\s+- 10\.253\.0\.1/u,
    );
    expect(livekitConfig).toMatch(
      /room:\n\s+auto_create: false\n\s+max_participants: 2\n\s+empty_timeout: 300\n\s+departure_timeout: 60/u,
    );
    expect(livekitConfig).toMatch(
      /limit:\n\s+num_tracks: 64\n\s+bytes_per_sec: 32000000\n\s+subscription_limit_video: 4\n\s+subscription_limit_audio: 2/u,
    );
    expect(livekitConfig).not.toContain("auto_create: true");
  });
});
