import { TrackSource } from "livekit-server-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  listCallLobbyParticipants,
  type LiveKitRoomService,
} from "./livekit.js";

function roomService(
  listParticipants: NonNullable<LiveKitRoomService["listParticipants"]>,
): LiveKitRoomService {
  return {
    createRoom: async () => undefined,
    listRooms: async () => [],
    deleteRoom: async () => undefined,
    removeParticipant: async () => undefined,
    listParticipants,
  };
}

describe("LiveKit call lobby roster", () => {
  it("maps only active media publications into safe participant state", async () => {
    const listParticipants = vi.fn(async () => [
      {
        identity: "tutor:1",
        name: "  Tutor   One ",
        attributes: { "eduri.color": "#ABCDEF" },
        tracks: [
          { source: TrackSource.MICROPHONE, muted: true },
          { source: TrackSource.CAMERA, muted: false },
          { source: TrackSource.SCREEN_SHARE, muted: false },
        ],
      },
      {
        identity: "student:1",
        name: "",
        attributes: { "eduri.color": "not-a-color" },
        tracks: [{ source: TrackSource.MICROPHONE, muted: false }],
      },
    ]);

    await expect(listCallLobbyParticipants(roomService(listParticipants), "room-1"))
      .resolves.toEqual([
        {
          identity: "tutor:1",
          displayName: "Tutor One",
          color: "#abcdef",
          microphoneEnabled: false,
          cameraEnabled: true,
          screenShareEnabled: true,
        },
        {
          identity: "student:1",
          displayName: "Участник",
          color: "#2563eb",
          microphoneEnabled: true,
          cameraEnabled: false,
          screenShareEnabled: false,
        },
      ]);
    expect(listParticipants).toHaveBeenCalledWith("room-1");
  });

  it("treats a missing ephemeral room as an empty roster", async () => {
    const service = roomService(async () => {
      throw { status: 404 };
    });
    await expect(listCallLobbyParticipants(service, "missing-room")).resolves.toEqual([]);
  });
});
