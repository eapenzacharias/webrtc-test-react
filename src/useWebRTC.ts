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
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);

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
      // Clean up any existing PeerConnection
      if (pcRef.current) {
        log("Closing previous PeerConnection...");
        pcRef.current.close();
      }

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

      // Set up ontrack early so we never miss incoming remote tracks
      pc.ontrack = (event) => {
        log(
          `Remote track received: ${event.track.kind} (mid=${event.transceiver.mid})`
        );
        const stream = event.streams[0] || new MediaStream([event.track]);
        setState((s) => {
          const updated = new Map(s.remoteStreams);
          updated.set(stream.id, stream);
          return { ...s, remoteStreams: updated };
        });
      };

      pcRef.current = pc;
      return pc;
    },
    [log]
  );

  // Step 1: Join room — get CF session + ICE servers
  const join = useCallback(async () => {
    try {
      log("Joining room...");
      const res = await api.joinRoom(roomId);
      log(`Joined! session_id=${res.session_id}`);

      const iceServers: RTCIceServer[] =
        Array.isArray(res.ice_servers) && res.ice_servers.length > 0
          ? res.ice_servers
          : [{ urls: "stun:stun.cloudflare.com:3478" }];

      log(`ICE servers: ${iceServers.length} entries`);

      // Store in ref so callbacks always have the latest value
      iceServersRef.current = iceServers;

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

      // Read ICE servers from ref (avoids stale closure)
      const iceServers = iceServersRef.current.length > 0
        ? iceServersRef.current
        : [{ urls: "stun:stun.cloudflare.com:3478" }];

      const pc = createPC(iceServers);

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
        `Track mids: ${trackInfos.map((t) => `${t.trackName}=${t.mid}`).join(", ")}`
      );

      // Send to backend
      const res = await api.publish(
        roomId,
        pc.localDescription!.sdp,
        trackInfos
      );
      log(
        `Publish response: answer_sdp=${!!res.answer_sdp}, ` +
          `${res.tracks?.length || 0} tracks, renego=${res.requires_immediate_renegotiation}`
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
        const reRes = await api.renegotiate(roomId, pc.localDescription!.sdp);
        if (reRes.sdp) {
          await pc.setRemoteDescription({
            type: reRes.type || "answer",
            sdp: reRes.sdp,
          });
          log("Renegotiation complete");
        }
      }

      // Store in ref so leave() always has the current stream
      localStreamRef.current = stream;
      setState((s) => ({ ...s, localStream: stream }));
      return res;
    } catch (e: any) {
      log(`Publish failed: ${e.message}`);
      throw e;
    }
  }, [roomId, log, createPC]);

  // Step 3: Subscribe to a remote participant's tracks
  const subscribeTo = useCallback(
    async (remoteSessionId: string, trackNames: string[]) => {
      try {
        log(`Subscribing to session ${remoteSessionId}...`);

        const pc = pcRef.current;
        if (!pc) throw new Error("No PeerConnection — publish first");

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

        // Send SDP offer + tracks to backend
        const res = await api.subscribe(
          roomId,
          pc.localDescription!.sdp,
          tracks
        );
        log(
          `Subscribe response: answer_sdp=${!!res.answer_sdp}, ` +
            `tracks=${JSON.stringify(res.tracks?.map((t: any) => ({ name: t.trackName, error: t.errorCode })))}`
        );

        if (res.answer_sdp) {
          await pc.setRemoteDescription({
            type: res.answer_type || "answer",
            sdp: res.answer_sdp,
          });
          log("Set subscribe remote description (answer)");
        } else {
          log("WARNING: No answer SDP in subscribe response!");
          // Log individual track errors
          res.tracks?.forEach((t: any) => {
            if (t.errorCode)
              log(
                `Track error: ${t.trackName} — ${t.errorCode}: ${t.errorDescription}`
              );
          });
        }

        // Handle renegotiation if needed
        if (res.requires_immediate_renegotiation) {
          log("Subscribe requires renegotiation...");
          const reOffer = await pc.createOffer();
          await pc.setLocalDescription(reOffer);
          const reRes = await api.renegotiate(roomId, pc.localDescription!.sdp);
          if (reRes.sdp) {
            await pc.setRemoteDescription({
              type: reRes.type || "answer",
              sdp: reRes.sdp,
            });
            log("Subscribe renegotiation complete");
          }
        }

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

      // Use refs to avoid stale closures
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;

      pcRef.current?.close();
      pcRef.current = null;

      iceServersRef.current = [];

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
  }, [roomId, log]);

  return { ...state, logs, log, join, publishTracks, subscribeTo, leave };
}
