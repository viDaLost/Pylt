import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getDatabase, get, onDisconnect, onValue, ref, remove, runTransaction, set, update
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const SESSION_KEY = "cameraCueSessionV1";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const $ = (id) => document.getElementById(id);
const el = {
  topbar: $("topbar"), connectionDot: $("connectionDot"), connectionText: $("connectionText"),
  roomCodeButton: $("roomCodeButton"), roomCodeText: $("roomCodeText"), setupView: $("setupView"),
  controllerView: $("controllerView"), receiverView: $("receiverView"), endedView: $("endedView"),
  configWarning: $("configWarning"), errorBox: $("errorBox"), resumeCard: $("resumeCard"),
  resumeTitle: $("resumeTitle"), resumeDescription: $("resumeDescription"), resumeButton: $("resumeButton"),
  forgetSessionButton: $("forgetSessionButton"), controllerTab: $("controllerTab"), receiverTab: $("receiverTab"),
  controllerSetup: $("controllerSetup"), receiverSetup: $("receiverSetup"), controllerNameInput: $("controllerNameInput"),
  roomInput: $("roomInput"), receiverNameInput: $("receiverNameInput"), createRoomButton: $("createRoomButton"),
  joinRoomButton: $("joinRoomButton"), activePersonName: $("activePersonName"), participantSummary: $("participantSummary"),
  activeSignal: $("activeSignal"), shareRoomButton: $("shareRoomButton"), clearActiveButton: $("clearActiveButton"),
  receiverCount: $("receiverCount"), participantsList: $("participantsList"), emptyParticipants: $("emptyParticipants"),
  finishRoomButton: $("finishRoomButton"), receiverSignal: $("receiverSignal"), receiverKicker: $("receiverKicker"),
  receiverStatusText: $("receiverStatusText"), receiverSubtext: $("receiverSubtext"), receiverOwnName: $("receiverOwnName"),
  leaveRoomButton: $("leaveRoomButton"), backToStartButton: $("backToStartButton")
};

const state = {
  app: null, auth: null, db: null, user: null, roomId: null, role: null, name: null,
  room: null, connected: false, roomOff: null, connectionOff: null, disconnectOp: null,
  wakeLock: null, lastActive: null, saved: readSession()
};

bindUi();
applyUrl();
registerServiceWorker();
init();

async function init() {
  if (!isFirebaseConfigured) {
    el.configWarning.classList.remove("hidden");
    setSetupEnabled(false);
    return;
  }
  try {
    state.app = initializeApp(firebaseConfig);
    state.auth = getAuth(state.app);
    state.db = getDatabase(state.app);
    state.user = await ensureUser();
    setSetupEnabled(true);
    showResume();
  } catch (error) {
    showError(messageFor(error));
    setSetupEnabled(false);
  }
}

function bindUi() {
  el.controllerTab.addEventListener("click", () => setSetupRole("controller"));
  el.receiverTab.addEventListener("click", () => setSetupRole("receiver"));
  el.createRoomButton.addEventListener("click", createRoom);
  el.joinRoomButton.addEventListener("click", joinRoom);
  el.shareRoomButton.addEventListener("click", shareRoom);
  el.roomCodeButton.addEventListener("click", copyRoomCode);
  el.clearActiveButton.addEventListener("click", () => chooseParticipant(null));
  el.finishRoomButton.addEventListener("click", finishRoom);
  el.leaveRoomButton.addEventListener("click", leaveRoom);
  el.backToStartButton.addEventListener("click", resetToSetup);
  el.resumeButton.addEventListener("click", resumeSession);
  el.forgetSessionButton.addEventListener("click", forgetSession);
  el.roomInput.addEventListener("input", () => { el.roomInput.value = normalizeCode(el.roomInput.value); });
  el.roomInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  el.receiverNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  el.controllerNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") createRoom(); });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && state.roomId && !state.wakeLock) await requestWakeLock();
  });
}

function applyUrl() {
  const params = new URLSearchParams(location.search);
  const room = normalizeCode(params.get("room") || "");
  if (room) {
    el.roomInput.value = room;
    setSetupRole(params.get("role") === "controller" ? "controller" : "receiver");
  }
}

function ensureUser() {
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(state.auth, async (user) => {
      if (user) { stop(); resolve(user); return; }
      try { await signInAnonymously(state.auth); } catch (error) { stop(); reject(error); }
    }, reject);
  });
}

async function createRoom() {
  clearError();
  setLoading(el.createRoomButton, true);
  try {
    const name = cleanName(el.controllerNameInput.value) || "Режиссёр";
    let roomId = null;
    for (let i = 0; i < 8 && !roomId; i += 1) {
      const candidate = randomCode();
      const result = await runTransaction(ref(state.db, `rooms/${candidate}`), (current) => {
        if (current !== null) return;
        const now = Date.now();
        return {
          meta: { controllerUid: state.user.uid, controllerName: name, createdAt: now, updatedAt: now, version: 1 },
          participants: { [state.user.uid]: participant(name, "controller", true) }
        };
      }, { applyLocally: false });
      if (result.committed) roomId = candidate;
    }
    if (!roomId) throw new Error("Не удалось подобрать свободный код комнаты.");
    await enterRoom(roomId, "controller", name);
  } catch (error) { showError(messageFor(error)); }
  finally { setLoading(el.createRoomButton, false); }
}

async function joinRoom() {
  clearError();
  const roomId = normalizeCode(el.roomInput.value);
  const name = cleanName(el.receiverNameInput.value);
  if (roomId.length !== 6) return showError("Введите шестизначный код комнаты.");
  if (!name) return showError("Введите имя участника.");
  setLoading(el.joinRoomButton, true);
  try {
    const meta = await get(ref(state.db, `rooms/${roomId}/meta`));
    if (!meta.exists()) throw new Error("Комната с таким кодом не найдена.");
    await enterRoom(roomId, "receiver", name);
  } catch (error) { showError(messageFor(error)); }
  finally { setLoading(el.joinRoomButton, false); }
}

async function enterRoom(roomId, role, name) {
  await cleanupSubscriptions();
  state.roomId = roomId;
  state.role = role;
  state.name = name;
  state.lastActive = null;
  saveSession({ roomId, role, name });
  showRoom(role);
  el.roomCodeText.textContent = roomId;
  el.receiverOwnName.textContent = name;
  await setPresence(true);
  subscribeConnection();
  subscribeRoom();
  await requestWakeLock();
  updateUrl(role === "receiver" ? joinUrl() : location.pathname);
}

async function setPresence(online) {
  if (!state.roomId || !state.user) return;
  const pRef = ref(state.db, `rooms/${state.roomId}/participants/${state.user.uid}`);
  await set(pRef, participant(state.name, state.role, online));
  if (state.disconnectOp) await state.disconnectOp.cancel().catch(() => {});
  state.disconnectOp = onDisconnect(pRef);
  await state.disconnectOp.set(participant(state.name, state.role, false));
}

function subscribeConnection() {
  state.connectionOff?.();
  state.connectionOff = onValue(ref(state.db, ".info/connected"), async (snap) => {
    state.connected = snap.val() === true;
    renderConnection();
    if (state.connected && state.roomId) {
      try { await setPresence(true); } catch (error) { console.warn(error); }
    }
  });
}

function subscribeRoom() {
  state.roomOff?.();
  state.roomOff = onValue(ref(state.db, `rooms/${state.roomId}`), (snap) => {
    if (!snap.exists()) { showEnded(); return; }
    state.room = snap.val();
    if (state.role === "controller") renderController();
    else renderReceiver();
  }, (error) => showError(messageFor(error)));
}

function renderController() {
  const participants = state.room?.participants || {};
  const receivers = Object.entries(participants).filter(([, p]) => p.role === "receiver");
  const activeId = state.room?.activeParticipantId || null;
  const active = activeId ? participants[activeId] : null;
  el.activePersonName.textContent = active?.name || "Никто";
  el.participantSummary.textContent = `${receivers.filter(([, p]) => p.online).length} онлайн из ${receivers.length}`;
  el.receiverCount.textContent = String(receivers.length);
  el.activeSignal.classList.toggle("mini-signal--green", Boolean(active));
  el.activeSignal.classList.toggle("mini-signal--red", !active);
  el.participantsList.replaceChildren();
  el.emptyParticipants.classList.toggle("hidden", receivers.length > 0);
  for (const [uid, p] of receivers.sort((a, b) => a[1].name.localeCompare(b[1].name, "ru"))) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `participant-card${uid === activeId ? " is-active" : ""}${p.online ? "" : " is-offline"}`;
    card.innerHTML = `<span class="participant-card__signal"></span><span class="participant-card__info"><span class="participant-card__name"></span><span class="participant-card__status"></span></span><span class="participant-card__action">${uid === activeId ? "В кадре" : "Выбрать"}</span>`;
    card.querySelector(".participant-card__name").textContent = p.name;
    card.querySelector(".participant-card__status").textContent = p.online ? "Устройство онлайн" : "Нет связи";
    card.addEventListener("click", () => chooseParticipant(uid));
    el.participantsList.append(card);
  }
}

function renderReceiver() {
  const participants = state.room?.participants || {};
  const activeId = state.room?.activeParticipantId || null;
  const isActive = activeId === state.user.uid;
  const activeName = activeId ? participants[activeId]?.name : null;
  el.receiverSignal.classList.toggle("receiver-signal--green", isActive);
  el.receiverSignal.classList.toggle("receiver-signal--red", !isActive);
  el.receiverKicker.textContent = isActive ? "СИГНАЛ РЕЖИССЁРА" : "ОЖИДАНИЕ КОМАНДЫ";
  el.receiverStatusText.textContent = isActive ? "ВЫ В КАДРЕ" : "НЕ В КАДРЕ";
  el.receiverSubtext.textContent = isActive ? "Камера сейчас снимает вас" : activeName ? `Сейчас в кадре: ${activeName}` : "Сейчас никто не выбран";
  if (state.lastActive !== isActive) {
    state.lastActive = isActive;
    navigator.vibrate?.(isActive ? [140, 80, 140] : [80]);
  }
}

async function chooseParticipant(uid) {
  if (state.role !== "controller") return;
  try {
    if (uid) await update(ref(state.db, `rooms/${state.roomId}`), { activeParticipantId: uid, "meta/updatedAt": Date.now() });
    else {
      await remove(ref(state.db, `rooms/${state.roomId}/activeParticipantId`));
      await update(ref(state.db, `rooms/${state.roomId}/meta`), { updatedAt: Date.now() });
    }
  } catch (error) { showError(messageFor(error)); }
}

async function finishRoom() {
  if (state.role !== "controller") return;
  try { await remove(ref(state.db, `rooms/${state.roomId}`)); }
  catch (error) { showError(messageFor(error)); }
}

async function leaveRoom() {
  try {
    if (state.roomId && state.user) await set(ref(state.db, `rooms/${state.roomId}/participants/${state.user.uid}/online`), false);
  } catch (error) { console.warn(error); }
  await resetToSetup();
}

async function resumeSession() {
  if (!state.saved) return;
  setLoading(el.resumeButton, true);
  try {
    const snap = await get(ref(state.db, `rooms/${state.saved.roomId}`));
    if (!snap.exists()) throw new Error("Сохранённая комната уже завершена.");
    if (state.saved.role === "controller" && snap.val()?.meta?.controllerUid !== state.user.uid) throw new Error("Эта комната больше не принадлежит текущему пульту.");
    await enterRoom(state.saved.roomId, state.saved.role, state.saved.name);
  } catch (error) { forgetSession(); showError(messageFor(error)); }
  finally { setLoading(el.resumeButton, false); }
}

function showResume() {
  if (!state.saved) return;
  el.resumeTitle.textContent = state.saved.role === "controller" ? "Продолжить как пульт" : "Продолжить как приёмник";
  el.resumeDescription.textContent = `${state.saved.name} · комната ${state.saved.roomId}`;
  el.resumeCard.classList.remove("hidden");
}

function forgetSession() {
  state.saved = null;
  localStorage.removeItem(SESSION_KEY);
  el.resumeCard.classList.add("hidden");
}

async function shareRoom() {
  const url = joinUrl();
  try {
    if (navigator.share) await navigator.share({ title: "Кадр-Сигнал", text: `Подключитесь к комнате ${state.roomId}`, url });
    else { await navigator.clipboard.writeText(url); temporaryLabel(el.shareRoomButton, "Ссылка скопирована"); }
  } catch (error) { if (error?.name !== "AbortError") showError(messageFor(error)); }
}

async function copyRoomCode() {
  if (!state.roomId) return;
  try { await navigator.clipboard.writeText(state.roomId); temporaryLabel(el.roomCodeButton, "Код скопирован"); }
  catch { showError("Не удалось скопировать код."); }
}

function participant(name, role, online) {
  return { name, role, online, updatedAt: Date.now(), lastSeen: Date.now() };
}

function showRoom(role) {
  clearError();
  el.setupView.classList.add("hidden");
  el.endedView.classList.add("hidden");
  el.topbar.classList.remove("hidden");
  el.controllerView.classList.toggle("hidden", role !== "controller");
  el.receiverView.classList.toggle("hidden", role !== "receiver");
}

function showEnded() {
  cleanupSubscriptions();
  forgetSession();
  releaseWakeLock();
  el.setupView.classList.add("hidden");
  el.controllerView.classList.add("hidden");
  el.receiverView.classList.add("hidden");
  el.topbar.classList.add("hidden");
  el.endedView.classList.remove("hidden");
}

async function resetToSetup() {
  await cleanupSubscriptions();
  await releaseWakeLock();
  forgetSession();
  Object.assign(state, { roomId: null, role: null, name: null, room: null, lastActive: null });
  el.topbar.classList.add("hidden");
  el.controllerView.classList.add("hidden");
  el.receiverView.classList.add("hidden");
  el.endedView.classList.add("hidden");
  el.setupView.classList.remove("hidden");
  updateUrl(location.pathname);
}

async function cleanupSubscriptions() {
  state.roomOff?.(); state.connectionOff?.();
  state.roomOff = null; state.connectionOff = null;
  if (state.disconnectOp) await state.disconnectOp.cancel().catch(() => {});
  state.disconnectOp = null;
}

function renderConnection() {
  el.connectionDot.classList.toggle("is-online", state.connected);
  el.connectionDot.classList.toggle("is-offline", !state.connected);
  el.connectionText.textContent = state.connected ? "Связь установлена" : "Нет связи";
}

function setSetupRole(role) {
  const controller = role === "controller";
  el.controllerTab.classList.toggle("is-active", controller);
  el.receiverTab.classList.toggle("is-active", !controller);
  el.controllerTab.setAttribute("aria-selected", String(controller));
  el.receiverTab.setAttribute("aria-selected", String(!controller));
  el.controllerSetup.classList.toggle("hidden", !controller);
  el.receiverSetup.classList.toggle("hidden", controller);
}

function setSetupEnabled(enabled) {
  el.createRoomButton.disabled = !enabled;
  el.joinRoomButton.disabled = !enabled;
  el.resumeButton.disabled = !enabled;
}

function saveSession(session) {
  state.saved = session;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s?.roomId && s?.role && s?.name ? { roomId: normalizeCode(s.roomId), role: s.role === "controller" ? "controller" : "receiver", name: cleanName(s.name) } : null;
  } catch { return null; }
}

function joinUrl() {
  const url = new URL(location.href);
  url.search = ""; url.hash = "";
  url.searchParams.set("room", state.roomId);
  url.searchParams.set("role", "receiver");
  return url.toString();
}

function updateUrl(value) {
  history.replaceState({}, "", value);
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function normalizeCode(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); }
function cleanName(value) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40); }
function clearError() { el.errorBox.textContent = ""; el.errorBox.classList.add("hidden"); }
function showError(message) { el.errorBox.textContent = message; el.errorBox.classList.remove("hidden"); el.errorBox.scrollIntoView({ behavior: "smooth", block: "center" }); }
function setLoading(button, loading) { button.disabled = loading; button.classList.toggle("is-loading", loading); }
function temporaryLabel(button, label) { const old = button.textContent; button.textContent = label; setTimeout(() => { button.textContent = old; }, 1500); }

function messageFor(error) {
  console.error(error);
  const code = error?.code || "";
  if (code.includes("auth/operation-not-allowed")) return "В Firebase нужно включить Anonymous Authentication.";
  if (code.includes("permission-denied")) return "Firebase отклонил запрос. Проверьте правила Realtime Database.";
  if (code.includes("network-request-failed")) return "Нет подключения к интернету.";
  return error?.message || "Произошла ошибка.";
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch (error) { console.info("Wake Lock недоступен", error); }
}

async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.info));
}
