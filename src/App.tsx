import React, { useState, useRef, useEffect } from "react";
import { setToken, getConfig } from "./api";
import { useWebRTC } from "./useWebRTC";

function VideoPlayer({ stream, muted, label }: {
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
  const [remoteTracks, setRemoteTracks] = useState("audio-0,video-1");
  const [config, setConfig] = useState<any>(null);
  const [connected, setConnected] = useState(false);

  const webrtc = useWebRTC(roomId);

  const handleConnect = () => {
    setToken(token);
    setConnected(true);
  };

  const handleGetConfig = async () => {
    try {
      const cfg = await getConfig();
      setConfig(cfg);
    } catch (e: any) {
      webrtc.log(`Get config failed: ${e.message}`);
    }
  };

  const handleJoin = async () => {
    try { await webrtc.join(); } catch {}
  };

  const handlePublish = async () => {
    try { await webrtc.publishTracks(); } catch {}
  };

  const handleSubscribe = async () => {
    try {
      const names = remoteTracks.split(",").map((s) => s.trim());
      await webrtc.subscribeTo(remoteSession, names);
    } catch {}
  };

  const handleLeave = async () => {
    try { await webrtc.leave(); } catch {}
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
            <pre style={{ background: "#f5f5f5", padding: 8, marginBottom: 16 }}>
              {JSON.stringify(config, null, 2)}
            </pre>
          )}

          {/* Room state */}
          {webrtc.room && (
            <details style={{ marginBottom: 16 }}>
              <summary>
                Room state (session: {webrtc.sessionId})
              </summary>
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
              )
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
