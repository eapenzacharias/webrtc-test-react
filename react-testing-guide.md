# WebRTC Testing Guide — React

A minimal React app to test the Convose WebRTC backend (`be-v2.convose.com`).

## Prerequisites

- A valid Convose auth token (from login/registration)
- A chat channel ID (room_id) where your user is a member
- Two browser tabs/devices to test publish + subscribe

---

## 1. Project Setup

```bash
npx create-react-app webrtc-test --template typescript
cd webrtc-test
npm install actioncable
npm start
```

---

## 2. API Client

Create `src/api.ts`:

```ts
const BASE_URL = "https://be-v2.convose.com";

let authToken = "";

export function setToken(token: string) {
  authToken = token;
}

async function request(method: string, path: string, body?: object) {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

// GET /webrtc/config
export const getConfig = () => request("GET", "/webrtc/config");

// POST /webrtc/credentials
export const getCredentials = () => request("POST", "/webrtc/credentials");

// POST /webrtc/rooms/:room_id/join
export const joinRoom = (roomId: string, participantType = "publisher") =>
  request("POST", `/webrtc/rooms/${roomId}/join`, {
    participant_type: participantType,
  });

// POST /webrtc/rooms/:room_id/publish
export const publish = (
  roomId: string,
  sessionId: string,
  sdp: string,
  tracks: { trackName: string; mid: string; kind: string }[],
) =>
  request("POST", `/webrtc/rooms/${roomId}/publish`, {
    session_id: sessionId,
    sdp,
    type: "offer",
    tracks,
  });

// POST /webrtc/rooms/:room_id/subscribe
export const subscribe = (
  roomId: string,
  sessionId: string,
  sdp: string,
  tracks: { trackName: string; sessionId: string }[],
) =>
  request("POST", `/webrtc/rooms/${roomId}/subscribe`, {
    session_id: sessionId,
    sdp,
    type: "offer",
    tracks,
  });

// POST /webrtc/rooms/:room_id/subscribe/answer
export const subscribeAnswer = (
  roomId: string,
  sessionId: string,
  sdp: string,
) =>
  request("POST", `/webrtc/rooms/${roomId}/subscribe/answer`, {
    session_id: sessionId,
    sdp,
    type: "answer",
  });

// POST /webrtc/rooms/:room_id/renegotiate
export const renegotiate = (roomId: string, sessionId: string, sdp: string) =>
  request("POST", `/webrtc/rooms/${roomId}/renegotiate`, {
    session_id: sessionId,
    sdp,
    type: "offer",
  });

// POST /webrtc/rooms/:room_id/leave
export const leaveRoom = (roomId: string) =>
  request("POST", `/webrtc/rooms/${roomId}/leave`);
```

---

## 3. WebRTC Hook

Create `src/useWebRTC.ts`:

```ts
import { useRef, useState, useCallback } from "react";
import * as api from "./api";

interface RoomState {
  sessionId: string | null;
  room: any;
  iceServers: RTCIceServer[];
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
}

export function useWebRTC(roomId: string) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [state, setState] = useState<RoomState>({
    sessionId: null,
    room: null,
    iceServers: [],
    localStream: null,
    remoteStreams: new Map(),
  });
  const [logs, setLogs] = useState<string[]>([]);

  const log = useCallback((msg: string) => {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    setLogs((prev) => [...prev.slice(-99), entry]);
  }, []);

  // Helper: create RTCPeerConnection with monitoring
  const createPC = useCallback(
    (iceServers: RTCIceServer[]) => {
      const pc = new RTCPeerConnection({
        iceServers,
        bundlePolicy: "max-bundle", // required by Cloudflare Calls
      });

      pc.oniceconnectionstatechange = () =>
        log(`ICE connection: ${pc.iceConnectionState}`);
      pc.onconnectionstatechange = () =>
        log(`PC connection: ${pc.connectionState}`);
      pc.onicegatheringstatechange = () =>
        log(`ICE gathering: ${pc.iceGatheringState}`);
      pc.onicecandidate = (e) => {
        if (e.candidate)
          log(`ICE candidate: ${e.candidate.candidate.slice(0, 60)}...`);
      };

      pcRef.current = pc;
      return pc;
    },
    [log],
  );

  // Step 1: Join room — get CF session + ICE servers
  const join = useCallback(async () => {
    try {
      log("Joining room...");
      const res = await api.joinRoom(roomId);
      log(`Joined! session_id=${res.session_id}`);

      // ice_servers is already an array of RTCIceServer objects
      const iceServers: RTCIceServer[] =
        Array.isArray(res.ice_servers) && res.ice_servers.length > 0
          ? res.ice_servers
          : [{ urls: "stun:stun.cloudflare.com:3478" }];

      log(`ICE servers: ${iceServers.length} entries`);

      setState((s) => ({
        ...s,
        sessionId: res.session_id,
        room: res.room,
        iceServers,
      }));

      return { sessionId: res.session_id, iceServers };
    } catch (e: any) {
      log(`Join failed: ${e.message}`);
      throw e;
    }
  }, [roomId, log]);

  // Step 2: Publish local audio/video
  const publishTracks = useCallback(async () => {
    try {
      log("Getting user media...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });

      const pc = createPC(state.iceServers);

      // Add local tracks to PC
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
        log(`Added local track: ${track.kind} (id=${track.id.slice(0, 8)})`);
      });

      // Create offer — mids are assigned after setLocalDescription
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      log("Created SDP offer, set as local description");

      // Now read mids from transceivers (they are assigned after setLocalDescription)
      const trackInfos = pc.getTransceivers().map((t) => ({
        trackName: `${t.sender.track?.kind || "unknown"}-${t.mid}`,
        mid: t.mid || "",
        kind: t.sender.track?.kind || "unknown",
      }));
      log(
        `Track mids: ${trackInfos.map((t) => `${t.trackName}=${t.mid}`).join(", ")}`,
      );

      // Send to backend (include session_id for cleanup-worker resilience)
      const res = await api.publish(
        roomId,
        state.sessionId!,
        pc.localDescription!.sdp,
        trackInfos,
      );
      log(
        `Publish response: answer_sdp=${!!res.answer_sdp}, ` +
          `${res.tracks?.length || 0} tracks, renego=${res.requires_immediate_renegotiation}`,
      );

      // Set remote answer
      if (res.answer_sdp) {
        await pc.setRemoteDescription({
          type: res.answer_type || "answer",
          sdp: res.answer_sdp,
        });
        log("Set remote description (answer)");
      } else {
        log("WARNING: No answer SDP from publish!");
      }

      // Handle renegotiation if needed
      if (res.requires_immediate_renegotiation) {
        log("Server requires immediate renegotiation...");
        const reOffer = await pc.createOffer();
        await pc.setLocalDescription(reOffer);
        const reRes = await api.renegotiate(
          roomId,
          state.sessionId!,
          pc.localDescription!.sdp,
        );
        if (reRes.sdp) {
          await pc.setRemoteDescription({ type: reRes.type, sdp: reRes.sdp });
          log("Renegotiation complete");
        }
      }

      setState((s) => ({ ...s, localStream: stream }));
      return res;
    } catch (e: any) {
      log(`Publish failed: ${e.message}`);
      throw e;
    }
  }, [roomId, state.sessionId, state.iceServers, log, createPC]);

  // Step 3: Subscribe to a remote participant's tracks
  const subscribeTo = useCallback(
    async (remoteSessionId: string, trackNames: string[]) => {
      try {
        log(`Subscribing to session ${remoteSessionId}...`);

        const pc = pcRef.current;
        if (!pc) throw new Error("No PeerConnection — publish first");

        // Listen for incoming tracks
        pc.ontrack = (event) => {
          log(
            `Remote track received: ${event.track.kind} (mid=${event.transceiver.mid})`,
          );
          const stream = event.streams[0] || new MediaStream([event.track]);
          setState((s) => {
            const updated = new Map(s.remoteStreams);
            updated.set(remoteSessionId, stream);
            return { ...s, remoteStreams: updated };
          });
        };

        // Add recvonly transceivers for each remote track
        trackNames.forEach((name) => {
          const kind = name.startsWith("video") ? "video" : "audio";
          pc.addTransceiver(kind, { direction: "recvonly" });
          log(`Added recvonly transceiver for ${name} (${kind})`);
        });

        // Create offer with the new transceivers
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        log("Created subscribe SDP offer");

        const tracks = trackNames.map((name) => ({
          trackName: name,
          sessionId: remoteSessionId,
        }));

        // Send SDP offer + tracks to backend (include session_id for cleanup-worker resilience)
        const res = await api.subscribe(
          roomId,
          state.sessionId!,
          pc.localDescription!.sdp,
          tracks,
        );
        log(
          `Subscribe response: answer_sdp=${!!res.answer_sdp}, ` +
            `tracks=${JSON.stringify(res.tracks?.map((t: any) => ({ name: t.trackName, error: t.errorCode })))}`,
        );

        if (res.answer_sdp) {
          await pc.setRemoteDescription({
            type: res.answer_type || "answer",
            sdp: res.answer_sdp,
          });
          log("Set subscribe remote description (answer)");
        } else {
          log("WARNING: No answer SDP in subscribe response!");
          // Check if tracks have errors
          res.tracks?.forEach((t: any) => {
            if (t.errorCode)
              log(
                `Track error: ${t.trackName} — ${t.errorCode}: ${t.errorDescription}`,
              );
          });
        }

        // Handle renegotiation if needed
        if (res.requires_immediate_renegotiation) {
          log("Subscribe requires renegotiation...");
          const reOffer = await pc.createOffer();
          await pc.setLocalDescription(reOffer);
          const reRes = await api.renegotiate(
            roomId,
            state.sessionId!,
            pc.localDescription!.sdp,
          );
          if (reRes.sdp) {
            await pc.setRemoteDescription({ type: reRes.type, sdp: reRes.sdp });
            log("Subscribe renegotiation complete");
          }
        }

        return res;
      } catch (e: any) {
        log(`Subscribe failed: ${e.message}`);
        throw e;
      }
    },
    [roomId, log],
  );

  // Leave room
  const leave = useCallback(async () => {
    try {
      log("Leaving room...");

      // Cleanup local media
      state.localStream?.getTracks().forEach((t) => t.stop());
      pcRef.current?.close();
      pcRef.current = null;

      await api.leaveRoom(roomId);
      log("Left room");

      setState({
        sessionId: null,
        room: null,
        iceServers: [],
        localStream: null,
        remoteStreams: new Map(),
      });
    } catch (e: any) {
      log(`Leave failed: ${e.message}`);
    }
  }, [roomId, state.localStream, log]);

  return { ...state, logs, join, publishTracks, subscribeTo, leave };
}
```

---

## 4. Test UI

Replace `src/App.tsx`:

```tsx
import React, { useState, useRef, useEffect } from "react";
import { setToken, getConfig } from "./api";
import { useWebRTC } from "./useWebRTC";

function VideoPlayer({
  stream,
  muted,
  label,
}: {
  stream: MediaStream | null;
  muted: boolean;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <div style={{ margin: 8 }}>
      <div style={{ fontWeight: "bold", marginBottom: 4 }}>{label}</div>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        style={{ width: 320, height: 240, background: "#222" }}
      />
    </div>
  );
}

export default function App() {
  const [token, setTokenInput] = useState("");
  const [roomId, setRoomId] = useState("");
  const [remoteSession, setRemoteSession] = useState("");
  const [remoteTracks, setRemoteTracks] = useState("");
  const [config, setConfig] = useState<any>(null);
  const [connected, setConnected] = useState(false);

  const webrtc = useWebRTC(roomId);

  const handleConnect = () => {
    setToken(token);
    setConnected(true);
  };

  const handleGetConfig = async () => {
    const cfg = await getConfig();
    setConfig(cfg);
  };

  const handleJoin = async () => {
    await webrtc.join();
  };

  const handlePublish = async () => {
    await webrtc.publishTracks();
  };

  const handleSubscribe = async () => {
    const names = remoteTracks.split(",").map((s) => s.trim());
    await webrtc.subscribeTo(remoteSession, names);
  };

  const handleLeave = async () => {
    await webrtc.leave();
  };

  return (
    <div style={{ fontFamily: "monospace", padding: 20 }}>
      <h2>Convose WebRTC Test</h2>

      {/* Auth */}
      <div style={{ marginBottom: 16 }}>
        <input
          placeholder="Auth token"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          style={{ width: 400, marginRight: 8 }}
        />
        <input
          placeholder="Room ID (chat channel)"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          style={{ width: 250, marginRight: 8 }}
        />
        <button onClick={handleConnect} disabled={!token || !roomId}>
          Set Token
        </button>
      </div>

      {connected && (
        <>
          {/* Actions */}
          <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
            <button onClick={handleGetConfig}>Get Config</button>
            <button onClick={handleJoin} disabled={!!webrtc.sessionId}>
              Join Room
            </button>
            <button onClick={handlePublish} disabled={!webrtc.sessionId}>
              Publish Audio+Video
            </button>
            <button onClick={handleLeave} disabled={!webrtc.sessionId}>
              Leave Room
            </button>
          </div>

          {/* Subscribe controls */}
          {webrtc.sessionId && (
            <div style={{ marginBottom: 16 }}>
              <input
                placeholder="Remote session ID"
                value={remoteSession}
                onChange={(e) => setRemoteSession(e.target.value)}
                style={{ width: 300, marginRight: 8 }}
              />
              <input
                placeholder="Track names (comma-sep)"
                value={remoteTracks}
                onChange={(e) => setRemoteTracks(e.target.value)}
                style={{ width: 200, marginRight: 8 }}
              />
              <button onClick={handleSubscribe} disabled={!remoteSession}>
                Subscribe
              </button>
            </div>
          )}

          {/* Config */}
          {config && (
            <pre
              style={{ background: "#f5f5f5", padding: 8, marginBottom: 16 }}
            >
              {JSON.stringify(config, null, 2)}
            </pre>
          )}

          {/* Room state */}
          {webrtc.room && (
            <details style={{ marginBottom: 16 }}>
              <summary>Room state (session: {webrtc.sessionId})</summary>
              <pre style={{ background: "#f5f5f5", padding: 8 }}>
                {JSON.stringify(webrtc.room, null, 2)}
              </pre>
            </details>
          )}

          {/* Video */}
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {webrtc.localStream && (
              <VideoPlayer
                stream={webrtc.localStream}
                muted={true}
                label="Local (you)"
              />
            )}
            {Array.from(webrtc.remoteStreams.entries()).map(
              ([sessionId, stream]) => (
                <VideoPlayer
                  key={sessionId}
                  stream={stream}
                  muted={false}
                  label={`Remote: ${sessionId.slice(0, 12)}...`}
                />
              ),
            )}
          </div>

          {/* Logs */}
          <div
            style={{
              marginTop: 16,
              background: "#1e1e1e",
              color: "#0f0",
              padding: 12,
              height: 200,
              overflow: "auto",
              fontSize: 12,
            }}
          >
            {webrtc.logs.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

---

## 5. Testing Flow

### Single-user test (verify API works)

1. Paste your auth token and a room_id (chat channel where you're a member)
2. Click **Set Token**
3. Click **Get Config** — should show `webrtc_enabled: true`
4. Click **Join Room** — logs show `Joined! session_id=...`
5. Click **Publish Audio+Video** — browser asks for mic/camera permission, then watch logs for:
   - `Created SDP offer` — local tracks added
   - `Track mids: audio-0=0, video-1=1` — mids assigned
   - `ICE connection: checking` → `connected` — media path established
   - `PC connection: connected` — fully connected
6. Click **Leave Room** — cleanup

### Two-user test (full publish + subscribe)

**Tab 1 (Publisher):**

1. Set token for User A, set room_id
2. Join Room → note the `session_id` from logs
3. Publish Audio+Video → tracks published

**Tab 2 (Subscriber):**

1. Set token for User B, same room_id
2. Join Room
3. Publish Audio+Video (needed to create the PeerConnection)
4. Paste User A's `session_id` into "Remote session ID"
5. Copy User A's track names from their log (e.g., `audio-0,video-1`)
6. Click Subscribe → check logs for ICE connection state and remote track events

---

## 6. API Endpoints Reference

| Method | Path                                      | Purpose                                       |
| ------ | ----------------------------------------- | --------------------------------------------- |
| `GET`  | `/webrtc/config`                          | Feature flags and capabilities                |
| `POST` | `/webrtc/credentials`                     | TURN/STUN ICE credentials                     |
| `POST` | `/webrtc/rooms/:room_id/join`             | Join room, get CF session                     |
| `POST` | `/webrtc/rooms/:room_id/publish`          | Publish local tracks (send offer, get answer) |
| `POST` | `/webrtc/rooms/:room_id/unpublish`        | Stop publishing tracks                        |
| `POST` | `/webrtc/rooms/:room_id/subscribe`        | Subscribe to remote tracks                    |
| `POST` | `/webrtc/rooms/:room_id/subscribe/answer` | Complete subscribe renegotiation              |
| `POST` | `/webrtc/rooms/:room_id/unsubscribe`      | Stop subscribing to tracks                    |
| `POST` | `/webrtc/rooms/:room_id/renegotiate`      | ICE restart or SDP update                     |
| `POST` | `/webrtc/rooms/:room_id/leave`            | Leave room, cleanup                           |

All endpoints require `Authorization: Bearer <token>` header or `?token=<token>` query param.

---

## 7. WebSocket Signals

The backend broadcasts these signals on ActionCable channel `chat_{room_id}`:

| Action                | When                  | Key Fields                                      |
| --------------------- | --------------------- | ----------------------------------------------- |
| `participant_joined`  | User joins room       | `participant.uuid`, `participant.session_id`    |
| `tracks_published`    | User publishes tracks | `publisher.session_id`, `tracks[]`              |
| `tracks_unpublished`  | User unpublishes      | `publisher.uuid`, `track_names[]`               |
| `participant_left`    | User leaves           | `participant.uuid`, `reason`, `remaining_count` |
| `media_state_changed` | Mute/unmute           | `sender_uuid`, `audio_muted`, `video_muted`     |
| `force_mute`          | Admin mutes user      | `target_uuid`, `sender_uuid`                    |

Listen for `message_type: 'webrtc_signal'` on the chat channel.

---

## 8. Error Responses

| Status | Meaning                                          |
| ------ | ------------------------------------------------ |
| `401`  | Missing or invalid auth token                    |
| `403`  | Not in room (must join first)                    |
| `429`  | Cloudflare rate limit                            |
| `502`  | Cloudflare SFU/TURN API error                    |
| `503`  | WebRTC feature disabled (`WEBRTC_ENABLED=false`) |
