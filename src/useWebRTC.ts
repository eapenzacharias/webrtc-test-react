import { useRef, useState, useCallback } from "react";
import * as api from "./api";

interface RoomState {
  sessionId: string | null;
  room: any;
  iceServers: any;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
}

export function useWebRTC(roomId: string) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [state, setState] = useState<RoomState>({
    sessionId: null,
    room: null,
    iceServers: null,
    localStream: null,
    remoteStreams: new Map(),
  });
  const [logs, setLogs] = useState<string[]>([]);

  const log = useCallback((msg: string) => {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    setLogs((prev) => [...prev.slice(-99), entry]);
  }, []);

  // Step 1: Join room — get CF session + ICE servers
  const join = useCallback(async () => {
    try {
      log("Joining room...");
      const res = await api.joinRoom(roomId);
      log(`Joined! session_id=${res.session_id}`);

      // ice_servers is already an array in the response, use it directly
      const iceServers = Array.isArray(res.ice_servers) && res.ice_servers.length > 0
        ? res.ice_servers
        : [{ urls: "stun:stun.cloudflare.com:3478" }];

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

      // Create PeerConnection
      const pc = new RTCPeerConnection({
        iceServers: state.iceServers || [
          { urls: "stun:stun.cloudflare.com:3478" },
        ],
      });
      pcRef.current = pc;

      // Add local tracks to PC
      const trackInfos: { trackName: string; mid: string; kind: string }[] = [];
      stream.getTracks().forEach((track, i) => {
        const sender = pc.addTrack(track, stream);
        const transceiver = pc.getTransceivers().find(
          (t) => t.sender === sender
        );
        const trackName = `${track.kind}-${i}`;
        trackInfos.push({
          trackName,
          mid: transceiver?.mid || String(i),
          kind: track.kind,
        });
        log(`Added local track: ${trackName} (${track.kind})`);
      });

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      log("Created SDP offer");

      // Send to backend
      const res = await api.publish(roomId, offer.sdp!, trackInfos);
      log(`Publish response: answer_sdp received, ${res.tracks?.length || 0} tracks confirmed`);

      // Set remote answer
      if (res.answer_sdp) {
        await pc.setRemoteDescription({
          type: res.answer_type || "answer",
          sdp: res.answer_sdp,
        });
        log("Set remote description (answer)");
      }

      // Handle renegotiation if needed
      if (res.requires_immediate_renegotiation) {
        log("Server requires immediate renegotiation...");
        const reOffer = await pc.createOffer();
        await pc.setLocalDescription(reOffer);
        const reRes = await api.renegotiate(roomId, reOffer.sdp!);
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
  }, [roomId, state.iceServers, log]);

  // Step 3: Subscribe to a remote participant's tracks
  const subscribeTo = useCallback(
    async (remoteSessionId: string, trackNames: string[]) => {
      try {
        log(`Subscribing to session ${remoteSessionId}...`);

        const pc = pcRef.current;
        if (!pc) throw new Error("No PeerConnection — publish first");

        // Listen for incoming tracks
        pc.ontrack = (event) => {
          log(`Remote track received: ${event.track.kind}`);
          const stream =
            event.streams[0] || new MediaStream([event.track]);
          setState((s) => {
            const updated = new Map(s.remoteStreams);
            updated.set(remoteSessionId, stream);
            return { ...s, remoteStreams: updated };
          });
        };

        // Add recvonly transceivers for the tracks we want to receive
        for (const name of trackNames) {
          const kind = name.startsWith("audio") ? "audio" : "video";
          pc.addTransceiver(kind, { direction: "recvonly" });
          log(`Added recvonly transceiver for ${name} (${kind})`);
        }

        // Create a new offer that includes the recvonly transceivers
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        log("Created subscribe SDP offer");

        const tracks = trackNames.map((name) => ({
          trackName: name,
          sessionId: remoteSessionId,
        }));

        // Send offer + tracks to subscribe endpoint
        const res = await api.subscribe(roomId, offer.sdp!, tracks);
        log(`Subscribe response received`);

        // Set the answer from the server
        const answerSdp = res.answer_sdp || res.sdp;
        const answerType = res.answer_type || res.type || "answer";
        if (answerSdp) {
          await pc.setRemoteDescription({ type: answerType, sdp: answerSdp });
          log("Set remote description (subscribe answer)");
        }

        // Handle renegotiation if needed
        if (res.requires_immediate_renegotiation) {
          log("Server requires renegotiation after subscribe...");
          const reOffer = await pc.createOffer();
          await pc.setLocalDescription(reOffer);
          const reRes = await api.renegotiate(roomId, reOffer.sdp!);
          if (reRes.sdp) {
            await pc.setRemoteDescription({ type: reRes.type, sdp: reRes.sdp });
          }
          log("Subscribe renegotiation complete");
        }

        log("Subscribe handshake complete");
        return res;
      } catch (e: any) {
        log(`Subscribe failed: ${e.message}`);
        throw e;
      }
    },
    [roomId, log]
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
        iceServers: null,
        localStream: null,
        remoteStreams: new Map(),
      });
    } catch (e: any) {
      log(`Leave failed: ${e.message}`);
    }
  }, [roomId, state.localStream, log]);

  return { ...state, logs, log, join, publishTracks, subscribeTo, leave };
}
