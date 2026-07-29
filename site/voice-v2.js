import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getDatabase, get, onDisconnect, onValue, push, ref, remove, serverTimestamp, set, update
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const SESSION_KEY = "cameraCueSessionV1";
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ],
  iceCandidatePoolSize: 6
};

const app = isFirebaseConfigured ? (getApps().length ? getApp() : initializeApp(firebaseConfig)) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getDatabase(app) : null;

const ui = buildUi();
let user = null;
let roomId = null;
let displayName = null;
let joined = false;
let muted = false;
let talking = false;
let localStream = null;
let memberDisconnect = null;
let membersOff = null;
let speakerOff = null;
let incomingOff = null;
let lastSignature = "";
let retryTimer = null;
const peers = new Map();

if (auth && db && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection) {
  onAuthStateChanged(auth, (nextUser) => { user = nextUser; syncSession(); });
  setInterval(syncSession, 800);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      resumeRemoteAudio();
      syncSession();
    }
  });
}

function buildUi() {
  document.querySelectorAll(".voice-dock,.voice-status,.voice-audio").forEach((node) => node.remove());
  const dock = document.createElement("div");
  dock.className = "voice-dock";
  dock.innerHTML = `
    <button class="voice-join" type="button">🎙 Включить рацию</button>
    <button class="voice-ptt" type="button">Удерживайте: говорить</button>
    <button class="voice-mute" type="button" aria-label="Отключить входящий звук">🔊</button>`;
  const status = document.createElement("div");
  status.className = "voice-status";
  status.textContent = "Голосовая связь выключена";
  const audio = document.createElement("div");
  audio.className = "voice-audio";
  document.body.append(dock, status, audio);
  const result = {
    dock,
    join: dock.querySelector(".voice-join"),
    ptt: dock.querySelector(".voice-ptt"),
    mute: dock.querySelector(".voice-mute"),
    status,
    audio
  };
  result.join.addEventListener("click", joinVoice);
  result.mute.addEventListener("click", toggleMute);
  result.ptt.addEventListener("pointerdown", startTalking, { passive: false });
  for (const eventName of ["pointerup", "pointercancel", "mouseleave"]) {
    result.ptt.addEventListener(eventName, stopTalking, { passive: false });
  }
  return result;
}

function readSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY));
    return value?.roomId && value?.name
      ? { roomId: String(value.roomId).toUpperCase(), name: String(value.name).slice(0, 40) }
      : null;
  } catch {
    return null;
  }
}

function syncSession() {
  const session = readSession();
  const controllerVisible = !document.getElementById("controllerView")?.classList.contains("hidden");
  const receiverVisible = !document.getElementById("receiverView")?.classList.contains("hidden");
  const active = Boolean(user && session && (controllerVisible || receiverVisible));
  ui.dock.classList.toggle("is-visible", active);
  ui.status.classList.toggle("is-visible", active && joined);
  if (!active) {
    leaveVoice();
    return;
  }
  const signature = `${session.roomId}:${session.name}:${user.uid}`;
  if (signature === lastSignature) return;
  if (joined) leaveVoice();
  roomId = session.roomId;
  displayName = session.name;
  lastSignature = signature;
}

async function joinVoice() {
  if (!roomId || !user || joined) return;
  ui.join.disabled = true;
  setStatus("Запрашиваем доступ к микрофону…");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    localStream.getAudioTracks().forEach((track) => { track.enabled = false; });
    joined = true;
    ui.join.hidden = true;
    ui.ptt.classList.add("is-ready");
    ui.mute.classList.add("is-visible");
    ui.status.classList.add("is-visible");

    await set(ref(db, `rooms/${roomId}/voice/members/${user.uid}`), {
      name: displayName,
      joinedAt: serverTimestamp(),
      talking: false
    });
    memberDisconnect = onDisconnect(ref(db, `rooms/${roomId}/voice/members/${user.uid}`));
    await memberDisconnect.remove();

    watchMembers();
    watchIncomingCalls();
    watchSpeaker();
    scheduleHealthCheck();
    setStatus("Рация включена. Ждём второго участника…");
  } catch (error) {
    console.error(error);
    setStatus(error?.name === "NotAllowedError"
      ? "Доступ к микрофону запрещён. Разрешите микрофон в настройках браузера."
      : "Не удалось включить голосовую связь.");
    ui.join.disabled = false;
  }
}

function watchMembers() {
  membersOff?.();
  membersOff = onValue(ref(db, `rooms/${roomId}/voice/members`), (snapshot) => {
    const members = snapshot.val() || {};
    const remoteUids = Object.keys(members).filter((uid) => uid !== user.uid);
    const current = new Set(remoteUids);

    for (const uid of remoteUids) {
      if (user.uid < uid && !peers.has(uid)) createOutgoingCall(uid).catch(console.warn);
    }
    for (const uid of [...peers.keys()]) {
      if (!current.has(uid)) closePeer(uid, true);
    }
    updateConnectionStatus();
  });
}

function watchIncomingCalls() {
  incomingOff?.();
  incomingOff = onValue(
    ref(db, `rooms/${roomId}/voice/connections/incoming/${user.uid}`),
    (snapshot) => {
      const calls = snapshot.val() || {};
      for (const [callerUid, call] of Object.entries(calls)) {
        if (call?.offer?.sdp && !peers.has(callerUid)) {
          acceptIncomingCall(callerUid, call).catch(console.warn);
        }
      }
    }
  );
}

function watchSpeaker() {
  speakerOff?.();
  speakerOff = onValue(ref(db, `rooms/${roomId}/voice/speaker`), (snapshot) => {
    const value = snapshot.val();
    if (!value?.uid) {
      if (!talking) updateConnectionStatus();
      ui.status.classList.remove("is-speaking");
      return;
    }
    ui.status.classList.toggle("is-speaking", value.uid !== user.uid);
    setStatus(value.uid === user.uid ? "Вы говорите" : `${value.name || "Участник"} говорит`);
    resumeRemoteAudio();
  });
}

function createPeer(remoteUid, callRoot) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const remoteStream = new MediaStream();
  const pending = [];
  const seen = new Set();
  const cleanup = [];
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.muted = muted;
  audio.srcObject = remoteStream;
  ui.audio.append(audio);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  pc.ontrack = (event) => {
    const tracks = event.streams?.[0]?.getTracks?.() || [event.track];
    for (const track of tracks) {
      if (!remoteStream.getTracks().some((item) => item.id === track.id)) remoteStream.addTrack(track);
    }
    audio.srcObject = remoteStream;
    if (!muted) audio.play().catch(() => setStatus("Нажмите 🔊 один раз для входящего звука"));
  };
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      push(ref(db, `${callRoot}/candidates/${user.uid}`), event.candidate.toJSON()).catch(console.warn);
    }
  };
  pc.onconnectionstatechange = () => {
    updateConnectionStatus();
    if (["failed", "closed"].includes(pc.connectionState)) closePeer(remoteUid, false);
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") pc.restartIce?.();
    updateConnectionStatus();
  };

  peers.set(remoteUid, { pc, audio, cleanup, callRoot, pending, seen, connectedAt: 0 });

  const flush = async () => {
    if (!pc.remoteDescription) return;
    while (pending.length) {
      try { await pc.addIceCandidate(pending.shift()); } catch (error) { console.warn(error); }
    }
  };

  cleanup.push(onValue(ref(db, `${callRoot}/candidates/${remoteUid}`), (snapshot) => {
    const values = snapshot.val() || {};
    for (const [key, candidate] of Object.entries(values)) {
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push(candidate);
    }
    flush();
  }));

  return { pc, flush };
}

async function createOutgoingCall(remoteUid) {
  const callRoot = `rooms/${roomId}/voice/connections/incoming/${remoteUid}/${user.uid}`;
  await remove(ref(db, callRoot)).catch(() => {});
  const { pc, flush } = createPeer(remoteUid, callRoot);
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  await set(ref(db, `${callRoot}/offer`), {
    from: user.uid,
    type: pc.localDescription.type,
    sdp: pc.localDescription.sdp,
    createdAt: serverTimestamp()
  });

  const peer = peers.get(remoteUid);
  peer.cleanup.push(onValue(ref(db, `${callRoot}/answer`), async (snapshot) => {
    const answer = snapshot.val();
    if (!answer?.sdp || pc.remoteDescription) return;
    await pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
    await flush();
  }));
}

async function acceptIncomingCall(callerUid, call) {
  const callRoot = `rooms/${roomId}/voice/connections/incoming/${user.uid}/${callerUid}`;
  const { pc, flush } = createPeer(callerUid, callRoot);
  await pc.setRemoteDescription({ type: call.offer.type, sdp: call.offer.sdp });
  await flush();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await set(ref(db, `${callRoot}/answer`), {
    from: user.uid,
    type: pc.localDescription.type,
    sdp: pc.localDescription.sdp,
    createdAt: serverTimestamp()
  });
}

function scheduleHealthCheck() {
  clearInterval(retryTimer);
  retryTimer = setInterval(() => {
    if (!joined) return;
    for (const [uid, peer] of peers.entries()) {
      const state = peer.pc.connectionState;
      if (["new", "connecting", "failed", "disconnected"].includes(state)) {
        closePeer(uid, true);
        if (user.uid < uid) setTimeout(() => createOutgoingCall(uid).catch(console.warn), 500);
      }
    }
  }, 12000);
}

function updateConnectionStatus() {
  if (!joined || talking) return;
  const states = [...peers.values()].map(({ pc }) => pc.connectionState);
  if (!states.length) setStatus("Рация включена. Ждём второго участника…");
  else if (states.some((state) => state === "connected")) setStatus("Рация подключена. Удерживайте кнопку, чтобы говорить.");
  else if (states.some((state) => ["new", "connecting"].includes(state))) setStatus("Соединяем голосовой канал…");
  else setStatus("Перезапускаем голосовой канал…");
}

async function startTalking(event) {
  event?.preventDefault();
  event?.currentTarget?.setPointerCapture?.(event.pointerId);
  if (!joined || talking || ![...peers.values()].some(({ pc }) => pc.connectionState === "connected")) {
    navigator.vibrate?.(60);
    return;
  }
  try {
    const speakerRef = ref(db, `rooms/${roomId}/voice/speaker`);
    const current = await get(speakerRef);
    if (current.exists() && current.val()?.uid !== user.uid) {
      navigator.vibrate?.(80);
      return;
    }
    talking = true;
    localStream.getAudioTracks().forEach((track) => { track.enabled = true; });
    ui.ptt.classList.add("is-talking");
    await set(speakerRef, { uid: user.uid, name: displayName, startedAt: serverTimestamp() });
    await update(ref(db, `rooms/${roomId}/voice/members/${user.uid}`), { talking: true });
  } catch (error) {
    console.warn(error);
    stopTalking();
  }
}

async function stopTalking(event) {
  event?.preventDefault();
  if (!talking) return;
  talking = false;
  localStream?.getAudioTracks().forEach((track) => { track.enabled = false; });
  ui.ptt.classList.remove("is-talking");
  try {
    const speakerRef = ref(db, `rooms/${roomId}/voice/speaker`);
    const current = await get(speakerRef);
    if (current.val()?.uid === user.uid) await remove(speakerRef);
    await update(ref(db, `rooms/${roomId}/voice/members/${user.uid}`), { talking: false });
  } catch (error) {
    console.warn(error);
  }
  updateConnectionStatus();
}

function toggleMute() {
  muted = !muted;
  ui.mute.textContent = muted ? "🔇" : "🔊";
  ui.mute.classList.toggle("is-muted", muted);
  for (const peer of peers.values()) {
    peer.audio.muted = muted;
    if (!muted) peer.audio.play().catch(() => {});
  }
}

function resumeRemoteAudio() {
  for (const peer of peers.values()) {
    if (!muted) peer.audio.play().catch(() => {});
  }
}

async function leaveVoice() {
  if (!joined && !roomId) return;
  stopTalking();
  membersOff?.();
  speakerOff?.();
  incomingOff?.();
  membersOff = speakerOff = incomingOff = null;
  clearInterval(retryTimer);
  retryTimer = null;
  for (const uid of [...peers.keys()]) closePeer(uid, true);
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  if (joined && roomId && user) {
    await remove(ref(db, `rooms/${roomId}/voice/members/${user.uid}`)).catch(() => {});
    await remove(ref(db, `rooms/${roomId}/voice/connections/incoming/${user.uid}`)).catch(() => {});
  }
  memberDisconnect?.cancel?.().catch?.(() => {});
  memberDisconnect = null;
  joined = false;
  ui.join.hidden = false;
  ui.join.disabled = false;
  ui.ptt.classList.remove("is-ready", "is-talking");
  ui.mute.classList.remove("is-visible", "is-muted");
  ui.status.classList.remove("is-visible", "is-speaking");
}

function closePeer(uid, removeSignal) {
  const peer = peers.get(uid);
  if (!peer) return;
  peer.cleanup.forEach((off) => off?.());
  peer.pc.close();
  peer.audio.remove();
  peers.delete(uid);
  if (removeSignal) remove(ref(db, peer.callRoot)).catch(() => {});
}

function setStatus(text) {
  ui.status.textContent = text;
}
