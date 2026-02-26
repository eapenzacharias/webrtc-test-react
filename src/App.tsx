import React, { useState, useRef, useEffect } from "react";
import { setToken, getConfig } from "./api";
import { useWebRTC } from "./useWebRTC";
import "./App.css";

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
    <div className="video-cell">
      <div className="video-label">{label}</div>
      <video ref={ref} autoPlay playsInline muted={muted} />
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
    try { await webrtc.join(); } catch (e: any) {
      webrtc.log(`Join error: ${e.message}`);
    }
  };

  const handlePublish = async () => {
    try { await webrtc.publishTracks(); } catch (e: any) {
      webrtc.log(`Publish error: ${e.message}`);
    }
  };

  const handleSubscribe = async () => {
    try {
      const names = remoteTracks.split(",").map((s) => s.trim());
      await webrtc.subscribeTo(remoteSession, names);
    } catch (e: any) {
      webrtc.log(`Subscribe error: ${e.message}`);
    }
  };

  const handleLeave = async () => {
    try { await webrtc.leave(); } catch (e: any) {
      webrtc.log(`Leave error: ${e.message}`);
    }
  };

  return (
    <div className="app">
      <h2>Convose WebRTC Test</h2>

      {/* Auth */}
      <div className="auth-section">
        <input
          placeholder="Auth token"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
        />
        <input
          placeholder="Room ID (chat channel)"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
        />
        <button onClick={handleConnect} disabled={!token || !roomId}>
          Set Token
        </button>
      </div>

      {connected && (
        <>
          {/* Actions */}
          <div className="actions">
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
            <div className="subscribe-section">
              <input
                placeholder="Remote session ID"
                value={remoteSession}
                onChange={(e) => setRemoteSession(e.target.value)}
              />
              <input
                placeholder="Track names (comma-sep)"
                value={remoteTracks}
                onChange={(e) => setRemoteTracks(e.target.value)}
              />
              <button onClick={handleSubscribe} disabled={!remoteSession}>
                Subscribe
              </button>
            </div>
          )}

          {/* Config */}
          {config && (
            <pre className="config-block">
              {JSON.stringify(config, null, 2)}
            </pre>
          )}

          {/* Room state */}
          {webrtc.room && (
            <details className="room-details">
              <summary>
                Room state (session: {webrtc.sessionId})
              </summary>
              <pre>{JSON.stringify(webrtc.room, null, 2)}</pre>
            </details>
          )}

          {/* Video */}
          <div className="video-grid">
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
          <div className="log-panel">
            {webrtc.logs.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
