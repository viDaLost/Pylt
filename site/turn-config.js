const TURN_WORKER_URL = "https://pylt-turn.vitaledanilov.workers.dev/";
const NativeRTCPeerConnection = window.RTCPeerConnection;

let turnIceServers = null;

try {
  const response = await fetch(TURN_WORKER_URL, {
    method: "GET",
    mode: "cors",
    cache: "no-store",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`TURN Worker returned ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data?.iceServers) || data.iceServers.length === 0) {
    throw new Error("TURN Worker returned no iceServers");
  }

  turnIceServers = data.iceServers;
  console.info("TURN servers loaded", turnIceServers.length);
} catch (error) {
  console.error("Could not load TURN servers; falling back to STUN", error);
}

if (NativeRTCPeerConnection && turnIceServers) {
  class TurnPeerConnection extends NativeRTCPeerConnection {
    constructor(configuration = {}) {
      super({
        ...configuration,
        iceServers: turnIceServers,
        iceCandidatePoolSize: Math.max(configuration.iceCandidatePoolSize || 0, 6)
      });
    }
  }

  window.RTCPeerConnection = TurnPeerConnection;
}
