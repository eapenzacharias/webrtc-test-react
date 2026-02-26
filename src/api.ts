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
  sdp: string,
  tracks: { trackName: string; mid: string; kind: string }[]
) =>
  request("POST", `/webrtc/rooms/${roomId}/publish`, {
    sdp,
    type: "offer",
    tracks,
  });

// POST /webrtc/rooms/:room_id/subscribe
export const subscribe = (
  roomId: string,
  sdp: string,
  tracks: { trackName: string; sessionId: string }[]
) => request("POST", `/webrtc/rooms/${roomId}/subscribe`, { sdp, type: "offer", tracks });

// POST /webrtc/rooms/:room_id/subscribe/answer
export const subscribeAnswer = (roomId: string, sdp: string) =>
  request("POST", `/webrtc/rooms/${roomId}/subscribe/answer`, {
    sdp,
    type: "answer",
  });

// POST /webrtc/rooms/:room_id/renegotiate
export const renegotiate = (roomId: string, sdp: string) =>
  request("POST", `/webrtc/rooms/${roomId}/renegotiate`, {
    sdp,
    type: "offer",
  });

// POST /webrtc/rooms/:room_id/leave
export const leaveRoom = (roomId: string) =>
  request("POST", `/webrtc/rooms/${roomId}/leave`);
