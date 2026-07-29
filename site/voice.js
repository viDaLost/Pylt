import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getDatabase, get, onDisconnect, onValue, push, ref, remove, serverTimestamp, set, update
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const SESSION_KEY = "cameraCueSessionV1";
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };
const app = isFirebaseConfigured ? (getApps().length ? getApp() : initializeApp(firebaseConfig)) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getDatabase(app) : null;

const ui = buildUi();
let user = null;
let roomId = null;
let name = null;
let joined = false;
let muted = false;
let talking = false;
let localStream = null;
let membersOff = null;
let speakerOff = null;
let memberDisconnect = null;
let lastSignature = "";
const peers = new Map();

if (auth && db && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection) {
  onAuthStateChanged(auth, (nextUser) => { user = nextUser; syncSession(); });
  window.setInterval(syncSession, 800);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncSession(); });
}

function buildUi() {
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
  const result = { dock, join: dock.querySelector(".voice-join"), ptt: dock.querySelector(".voice-ptt"), mute: dock.querySelector(".voice-mute"), status, audio };
  result.join.addEventListener("click", joinVoice);
  result.mute.addEventListener("click", toggleMute);
  for (const eventName of ["pointerdown", "touchstart", "mousedown"]) result.ptt.addEventListener(eventName, startTalking, { passive: false });
  for (const eventName of ["pointerup", "pointercancel", "touchend", "touchcancel", "mouseup", "mouseleave"]) result.ptt.addEventListener(eventName, stopTalking, { passive: false });
  return result;
}

function readSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY));
    return value?.roomId && value?.name ? { roomId: String(value.roomId).toUpperCase(), name: String(value.name).slice(0, 40) } : null;
  } catch { return null; }
}

function syncSession() {
  const session = readSession();
  const controllerVisible = !document.getElementById("controllerView")?.classList.contains("hidden");
  const receiverVisible = !document.getElementById("receiverView")?.classList.contains("hidden");
  const active = Boolean(user && session && (controllerVisible || receiverVisible));
  ui.dock.classList.toggle("is-visible", active);
  ui.status.classList.toggle("is-visible", active && joined);
  if (!active) { leaveVoice(); return; }
  const signature = `${session.roomId}:${session.name}:${user.uid}`;
  if (signature === lastSignature) return;
  if (joined) leaveVoice();
  roomId = session.roomId;
  name = session.name;
  lastSignature = signature;
}

async function joinVoice() {
  if (!roomId || !user || joined) return;
  ui.join.disabled = true;
  setStatus("Запрашиваем доступ к микрофону…");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    localStream.getAudioTracks().forEach((track) => { track.enabled = false; });
    joined = true;
    ui.join.hidden = true;
    ui.ptt.classList.add("is-ready");
    ui.mute.classList.add("is-visible");
    ui.status.classList.add("is-visible");
    await set(ref(db, `rooms/${roomId}/voice/members/${user.uid}`), { name, joinedAt: serverTimestamp(), talking: false });
    memberDisconnect = onDisconnect(ref(db, `rooms/${roomId}/voice/members/${user.uid}`));
    await memberDisconnect.remove();
    watchMembers();
    watchSpeaker();
    setStatus("Рация включена. Удерживайте кнопку, чтобы говорить.");
  } catch (error) {
    console.error(error);
    setStatus(error?.name === "NotAllowedError" ? "Доступ к микрофону запрещён. Разрешите микрофон в настройках браузера." : "Не удалось включить голосовую связь.");
    ui.join.disabled = false;
  }
}

function watchMembers() {
  membersOff?.();
  membersOff = onValue(ref(db, `rooms/${roomId}/voice/members`), (snapshot) => {
    const members = snapshot.val() || {};
    const current = new Set(Object.keys(members).filter((uid) => uid !== user.uid));
    for (const uid of current) if (!peers.has(uid)) createPeer(uid);
    for (const uid of peers.keys()) if (!current.has(uid)) closePeer(uid);
  });
}

function watchSpeaker() {
  speakerOff?.();
  speakerOff = onValue(ref(db, `rooms/${roomId}/voice/speaker`), (snapshot) => {
    const value = snapshot.val();
    if (!value?.uid) {
      if (!talking) setStatus("Рация включена. Удерживайте кнопку, чтобы говорить.");
      ui.status.classList.remove("is-speaking");
      return;
    }
    ui.status.classList.toggle("is-speaking", value.uid !== user.uid);
    setStatus(value.uid === user.uid ? "Вы говорите" : `${value.name || "Участник"} говорит`);
  });
}

async function createPeer(remoteUid) {
  const initiator = user.uid < remoteUid;
  const pairId = [user.uid, remoteUid].sort().join("_");
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const remoteStream = new MediaStream();
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = remoteStream;
  audio.muted = muted;
  ui.audio.append(audio);
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  pc.ontrack = (event) => event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track));
  pc.onicecandidate = (event) => {
    if (event.candidate) push(ref(db, `rooms/${roomId}/voice/connections/${pairId}/candidates/${user.uid}`), event.candidate.toJSON()).catch(console.warn);
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) closePeer(remoteUid);
  };
  const cleanup = [];
  peers.set(remoteUid, { pc, audio, cleanup, pairId });

  cleanup.push(onValue(ref(db, `rooms/${roomId}/voice/connections/${pairId}/candidates/${remoteUid}`), (snap) => {
    const values = snap.val() || {};
    for (const [key, candidate] of Object.entries(values)) {
      const marker = `${remoteUid}:${key}`;
      if (pc.__seen?.has(marker)) continue;
      pc.__seen ||= new Set(); pc.__seen.add(marker);
      pc.addIceCandidate(candidate).catch(console.warn);
    }
  }));

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, `rooms/${roomId}/voice/connections/${pairId}/offer`), { from: user.uid, sdp: offer.sdp, type: offer.type });
    cleanup.push(onValue(ref(db, `rooms/${roomId}/voice/connections/${pairId}/answer`), async (snap) => {
      const answer = snap.val();
      if (answer?.sdp && !pc.currentRemoteDescription) await pc.setRemoteDescription(answer).catch(console.warn);
    }));
  } else {
    cleanup.push(onValue(ref(db, `rooms/${roomId}/voice/connections/${pairId}/offer`), async (snap) => {
      const offer = snap.val();
      if (!offer?.sdp || pc.currentRemoteDescription) return;
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await set(ref(db, `rooms/${roomId}/voice/connections/${pairId}/answer`), { from: user.uid, sdp: answer.sdp, type: answer.type });
    }));
  }
}

async function startTalking(event) {
  event?.preventDefault();
  if (!joined || talking) return;
  try {
    const speakerRef = ref(db, `rooms/${roomId}/voice/speaker`);
    const current = await get(speakerRef);
    if (current.exists() && current.val()?.uid !== user.uid) { navigator.vibrate?.(80); return; }
    talking = true;
    localStream.getAudioTracks().forEach((track) => { track.enabled = true; });
    ui.ptt.classList.add("is-talking");
    await set(speakerRef, { uid: user.uid, name, startedAt: serverTimestamp() });
    await update(ref(db, `rooms/${roomId}/voice/members/${user.uid}`), { talking: true });
  } catch (error) { console.warn(error); stopTalking(); }
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
  } catch (error) { console.warn(error); }
}

function toggleMute() {
  muted = !muted;
  ui.mute.textContent = muted ? "🔇" : "🔊";
  ui.mute.classList.toggle("is-muted", muted);
  for (const peer of peers.values()) peer.audio.muted = muted;
}

async function leaveVoice() {
  if (!joined && !roomId) return;
  stopTalking();
  membersOff?.(); speakerOff?.(); membersOff = null; speakerOff = null;
  for (const uid of [...peers.keys()]) closePeer(uid);
  localStream?.getTracks().forEach((track) => track.stop()); localStream = null;
  if (joined && roomId && user) {
    await remove(ref(db, `rooms/${roomId}/voice/members/${user.uid}`)).catch(() => {});
  }
  memberDisconnect?.cancel?.().catch?.(() => {}); memberDisconnect = null;
  joined = false;
  ui.join.hidden = false; ui.join.disabled = false;
  ui.ptt.classList.remove("is-ready", "is-talking");
  ui.mute.classList.remove("is-visible", "is-muted");
  ui.status.classList.remove("is-visible", "is-speaking");
}

function closePeer(uid) {
  const peer = peers.get(uid);
  if (!peer) return;
  peer.cleanup.forEach((off) => off?.());
  peer.pc.close(); peer.audio.remove(); peers.delete(uid);
}

function setStatus(text) { ui.status.textContent = text; }
