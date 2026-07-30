import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getDatabase, get, onDisconnect, onValue, ref, remove, runTransaction, set, update
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const SESSION_KEY = "cameraCueSessionV1";
const ALERTS_KEY = "cameraCueAlertsV1";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const $ = (id) => document.getElementById(id);
const el = {
  themeColorMeta: $("themeColorMeta"),
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
  participantSearchInput: $("participantSearchInput"), controllerRoomCode: $("controllerRoomCode"),
  finishRoomButton: $("finishRoomButton"), receiverSignal: $("receiverSignal"), receiverKicker: $("receiverKicker"),
  receiverStatusText: $("receiverStatusText"), receiverSubtext: $("receiverSubtext"), receiverOwnName: $("receiverOwnName"),
  enableAlertsButton: $("enableAlertsButton"), enableAlertsLabel: $("enableAlertsLabel"), alertsStatus: $("alertsStatus"),
  leaveRoomButton: $("leaveRoomButton"), backToStartButton: $("backToStartButton"),
  installAppPanel: $("installAppPanel"), installAppButton: $("installAppButton"), installAppStatus: $("installAppStatus"),
  installDialog: $("installDialog"), installDialogTitle: $("installDialogTitle"), installInstructions: $("installInstructions"),
  confirmDialog: $("confirmDialog"), confirmDialogTitle: $("confirmDialogTitle"), confirmDialogText: $("confirmDialogText"),
  confirmDialogAccept: $("confirmDialogAccept"), toastRegion: $("toastRegion")
};

const state = {
  app: null, auth: null, db: null, user: null, roomId: null, role: null, name: null,
  room: null, connected: false, roomOff: null, connectionOff: null, disconnectOp: null,
  wakeLock: null, lastActive: null, saved: readSession(),
  alertsEnabled: false, serviceWorkerRegistration: null, installPrompt: null,
  participantFilter: "", confirmResolve: null,
  alertsPreferred: localStorage.getItem(ALERTS_KEY) === "enabled"
};

bindUi();
setViewMode("setup");
applyUrl();
setupInstallExperience();
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
  el.controllerRoomCode.addEventListener("click", copyRoomCode);
  document.querySelectorAll("[data-share-room]").forEach((button) => button.addEventListener("click", shareRoom));
  el.clearActiveButton.addEventListener("click", () => chooseParticipant(null));
  el.finishRoomButton.addEventListener("click", finishRoom);
  el.enableAlertsButton.addEventListener("click", enableAlerts);
  el.leaveRoomButton.addEventListener("click", leaveRoom);
  el.backToStartButton.addEventListener("click", resetToSetup);
  el.resumeButton.addEventListener("click", resumeSession);
  el.forgetSessionButton.addEventListener("click", forgetSession);
  el.installAppButton.addEventListener("click", installApp);
  el.participantSearchInput.addEventListener("input", () => {
    state.participantFilter = el.participantSearchInput.value.trim().toLocaleLowerCase("ru");
    if (state.room) renderController();
  });
  el.roomInput.addEventListener("input", () => { el.roomInput.value = normalizeCode(el.roomInput.value); });
  el.roomInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  el.receiverNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  el.controllerNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") createRoom(); });
  [el.controllerTab, el.receiverTab].forEach((tab) => tab.addEventListener("keydown", handleRoleTabKeys));
  el.confirmDialog.addEventListener("close", () => {
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    resolve?.(el.confirmDialog.returnValue === "confirm");
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && state.roomId && !state.wakeLock) await requestWakeLock();
  });
}

function applyUrl() {
  const params = new URLSearchParams(location.search);
  const room = normalizeCode(params.get("room") || "");
  const role = params.get("role");
  if (room) el.roomInput.value = room;
  if (role === "controller" || role === "receiver") setSetupRole(role);
  else if (room) setSetupRole("receiver");
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
  if (!state.db || !state.user) return showError("Сервис ещё подключается. Попробуйте через несколько секунд.");
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
  if (!state.db || !state.user) return showError("Сервис ещё подключается. Попробуйте через несколько секунд.");
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
  el.controllerRoomCode.querySelector("span").textContent = roomId;
  el.receiverOwnName.textContent = name;
  if (role === "receiver") renderAlertsState();
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
  const onlineCount = receivers.filter(([, p]) => p.online).length;
  const filteredReceivers = receivers
    .filter(([, p]) => !state.participantFilter || p.name.toLocaleLowerCase("ru").includes(state.participantFilter))
    .sort((a, b) => {
      if (a[0] === activeId) return -1;
      if (b[0] === activeId) return 1;
      if (a[1].online !== b[1].online) return a[1].online ? -1 : 1;
      return a[1].name.localeCompare(b[1].name, "ru");
    });

  el.activePersonName.textContent = active?.name || "Никто";
  el.participantSummary.textContent = receivers.length
    ? `${onlineCount} онлайн · всего ${receivers.length}`
    : "Ожидание участников…";
  el.receiverCount.textContent = String(receivers.length);
  el.receiverCount.setAttribute("aria-label", `Участников: ${receivers.length}`);
  el.activeSignal.classList.toggle("mini-signal--green", Boolean(active));
  el.activeSignal.classList.toggle("mini-signal--red", !active);
  el.activeSignal.setAttribute("aria-label", active ? `Зелёный сигнал: в кадре ${active.name}` : "Красный сигнал: никто не выбран");
  el.participantsList.replaceChildren();
  el.emptyParticipants.classList.toggle("hidden", filteredReceivers.length > 0);

  const emptyTitle = el.emptyParticipants.querySelector("h3");
  const emptyText = el.emptyParticipants.querySelector("p");
  const emptyShare = el.emptyParticipants.querySelector("[data-share-room]");
  if (!filteredReceivers.length && receivers.length && state.participantFilter) {
    emptyTitle.textContent = "Никого не найдено";
    emptyText.textContent = "Попробуйте изменить запрос или очистить строку поиска.";
    emptyShare.classList.add("hidden");
  } else {
    emptyTitle.textContent = "Ждём команду";
    emptyText.textContent = "Поделитесь ссылкой — новые участники сразу появятся в этом списке.";
    emptyShare.classList.remove("hidden");
  }

  for (const [uid, p] of filteredReceivers) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `participant-card${uid === activeId ? " is-active" : ""}${p.online ? "" : " is-offline"}`;
    card.innerHTML = `<span class="participant-card__signal"></span><span class="participant-card__info"><span class="participant-card__name"></span><span class="participant-card__status"></span></span><span class="participant-card__action">${uid === activeId ? "В кадре" : "Выбрать"}</span>`;
    card.querySelector(".participant-card__name").textContent = p.name;
    card.querySelector(".participant-card__status").textContent = p.online ? "Онлайн · готов к сигналу" : "Не в сети";
    card.setAttribute("aria-pressed", String(uid === activeId));
    card.setAttribute("aria-label", `${p.name}: ${p.online ? "онлайн" : "не в сети"}${uid === activeId ? ", сейчас в кадре" : ""}`);
    card.disabled = !p.online && uid !== activeId;
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
  el.themeColorMeta.setAttribute("content", isActive ? "#087b49" : "#9b2030");

  if (state.lastActive === null) {
    state.lastActive = isActive;
    updateAppBadge(isActive);
    return;
  }

  if (state.lastActive !== isActive) {
    state.lastActive = isActive;
    triggerReceiverAlert(isActive, activeName);
  }
}

async function enableAlerts() {
  clearError();
  setLoading(el.enableAlertsButton, true);
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Этот браузер не поддерживает звуковые сигналы.");

    state.alertsEnabled = true;
    state.alertsPreferred = true;
    localStorage.setItem(ALERTS_KEY, "enabled");

    let notificationPermission = "unsupported";
    if ("Notification" in window) {
      notificationPermission = Notification.permission;
      if (notificationPermission === "default") {
        try {
          notificationPermission = await Notification.requestPermission();
        } catch (error) {
          console.info("Запрос системных уведомлений недоступен", error);
        }
      }
    }

    navigator.vibrate?.([60, 45, 60]);
    window.dispatchEvent(new CustomEvent("camera-cue:alerts-enabled"));
    renderAlertsState(notificationPermission);
  } catch (error) {
    state.alertsEnabled = false;
    showError(messageFor(error));
    renderAlertsState();
  } finally {
    setLoading(el.enableAlertsButton, false);
  }
}

function renderAlertsState(permission = ("Notification" in window ? Notification.permission : "unsupported")) {
  if (!state.alertsEnabled) {
    el.enableAlertsLabel.textContent = state.alertsPreferred ? "Включить оповещения снова" : "Включить звук и уведомления";
    el.enableAlertsButton.classList.remove("is-enabled");
    el.alertsStatus.textContent = "Нажмите один раз перед съёмкой. На iPhone установите приложение на экран «Домой».";
    return;
  }

  el.enableAlertsLabel.textContent = "Оповещения включены";
  el.enableAlertsButton.classList.add("is-enabled");
  if (permission === "granted") {
    el.alertsStatus.textContent = "Звук включён. При свёрнутом приложении также появится системное уведомление.";
  } else if (permission === "denied") {
    el.alertsStatus.textContent = "Звук включён, но системные уведомления запрещены в настройках телефона.";
  } else {
    el.alertsStatus.textContent = "Звук включён. Системные уведомления недоступны в этом режиме браузера.";
  }
}

async function triggerReceiverAlert(isActive, activeName) {
  navigator.vibrate?.(isActive ? [110, 65, 110] : [70]);
  await updateAppBadge(isActive);
  if (document.visibilityState !== "visible") await showSystemNotification(isActive, activeName);
}

async function showSystemNotification(isActive, activeName) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const registration = state.serviceWorkerRegistration || await navigator.serviceWorker?.ready;
    if (!registration) return;
    await registration.showNotification(isActive ? "Вы в кадре" : "Вы не в кадре", {
      body: isActive ? "Камера сейчас снимает вас." : activeName ? `Сейчас в кадре: ${activeName}` : "Сейчас никто не выбран.",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "camera-cue-status",
      renotify: true,
      silent: false,
      vibrate: isActive ? [110, 65, 110] : [70],
      data: { url: location.href }
    });
  } catch (error) {
    console.info("Системное уведомление недоступно", error);
  }
}

async function updateAppBadge(isActive) {
  try {
    if (isActive) await navigator.setAppBadge?.(1);
    else await navigator.clearAppBadge?.();
  } catch (error) {
    console.info("Badge API недоступен", error);
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
  const confirmed = await confirmAction({
    title: "Завершить комнату?",
    text: "Все участники будут отключены, а история этой съёмочной комнаты станет недоступна.",
    confirmLabel: "Завершить"
  });
  if (!confirmed) return;
  try { await remove(ref(state.db, `rooms/${state.roomId}`)); }
  catch (error) { showError(messageFor(error)); }
}

async function leaveRoom() {
  const confirmed = await confirmAction({
    title: "Выйти из комнаты?",
    text: "Ваше устройство пропадёт из списка онлайн. Вы сможете подключиться снова по коду.",
    confirmLabel: "Выйти"
  });
  if (!confirmed) return;
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
  window.dispatchEvent(new CustomEvent("camera-cue:session-changed", { detail: null }));
}

async function shareRoom() {
  const url = joinUrl();
  try {
    if (navigator.share) {
      await navigator.share({ title: "Кадр", text: `Подключайтесь к съёмочной комнате ${state.roomId}`, url });
    } else {
      await copyText(url);
      showToast("Ссылка приглашения скопирована");
    }
  } catch (error) { if (error?.name !== "AbortError") showError(messageFor(error)); }
}

async function copyRoomCode() {
  if (!state.roomId) return;
  try {
    await copyText(state.roomId);
    showToast(`Код ${state.roomId} скопирован`);
  }
  catch { showError("Не удалось скопировать код."); }
}

function participant(name, role, online) {
  return { name, role, online, updatedAt: Date.now(), lastSeen: Date.now() };
}

function showRoom(role) {
  clearError();
  setViewMode(role);
  el.themeColorMeta.setAttribute("content", role === "receiver" ? "#9b2030" : "#080b0d");
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
  updateAppBadge(false);
  setViewMode("ended");
  el.themeColorMeta.setAttribute("content", "#080b0d");
  el.setupView.classList.add("hidden");
  el.controllerView.classList.add("hidden");
  el.receiverView.classList.add("hidden");
  el.topbar.classList.add("hidden");
  el.endedView.classList.remove("hidden");
}

async function resetToSetup() {
  await cleanupSubscriptions();
  await releaseWakeLock();
  await updateAppBadge(false);
  forgetSession();
  Object.assign(state, { roomId: null, role: null, name: null, room: null, lastActive: null, alertsEnabled: false });
  state.participantFilter = "";
  el.participantSearchInput.value = "";
  setViewMode("setup");
  el.themeColorMeta.setAttribute("content", "#080b0d");
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
  const compact = window.matchMedia("(max-width: 540px)").matches;
  el.connectionText.textContent = state.connected ? (compact ? "Онлайн" : "Связь установлена") : "Нет связи";
}

function setSetupRole(role) {
  const controller = role === "controller";
  el.controllerTab.classList.toggle("is-active", controller);
  el.receiverTab.classList.toggle("is-active", !controller);
  el.controllerTab.setAttribute("aria-selected", String(controller));
  el.receiverTab.setAttribute("aria-selected", String(!controller));
  el.controllerSetup.classList.toggle("hidden", !controller);
  el.receiverSetup.classList.toggle("hidden", controller);
  el.controllerSetup.setAttribute("aria-hidden", String(!controller));
  el.receiverSetup.setAttribute("aria-hidden", String(controller));
}

function handleRoleTabKeys(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const receiver = event.key === "ArrowRight" || event.key === "End";
  setSetupRole(receiver ? "receiver" : "controller");
  (receiver ? el.receiverTab : el.controllerTab).focus();
}

function setSetupEnabled(enabled) {
  el.createRoomButton.disabled = !enabled;
  el.joinRoomButton.disabled = !enabled;
  el.resumeButton.disabled = !enabled;
}

function saveSession(session) {
  state.saved = session;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  window.dispatchEvent(new CustomEvent("camera-cue:session-changed", { detail: session }));
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
function showError(message) {
  if (!el.setupView.classList.contains("hidden")) {
    el.errorBox.textContent = message;
    el.errorBox.classList.remove("hidden");
    el.errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    showToast(message, true);
  }
}
function setLoading(button, loading) {
  button.disabled = loading;
  button.classList.toggle("is-loading", loading);
  button.setAttribute("aria-busy", String(loading));
}

function setViewMode(mode) {
  document.body.classList.remove("is-setup", "is-controller", "is-receiver", "is-ended");
  document.body.classList.add(`is-${mode}`);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  Object.assign(input.style, { position: "fixed", opacity: "0", pointerEvents: "none" });
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy failed");
}

function showToast(message, error = false) {
  const toast = document.createElement("div");
  toast.className = `toast${error ? " is-error" : ""}`;
  toast.setAttribute("role", error ? "alert" : "status");
  toast.textContent = message;
  el.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

function confirmAction({ title, text, confirmLabel }) {
  if (typeof el.confirmDialog?.showModal !== "function") {
    return Promise.resolve(window.confirm(text));
  }
  if (el.confirmDialog.open) el.confirmDialog.close("cancel");
  el.confirmDialogTitle.textContent = title;
  el.confirmDialogText.textContent = text;
  el.confirmDialogAccept.textContent = confirmLabel;
  el.confirmDialog.returnValue = "";
  el.confirmDialog.showModal();
  return new Promise((resolve) => { state.confirmResolve = resolve; });
}

function setupInstallExperience() {
  renderInstallState();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    renderInstallState();
  });
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    renderInstallState(true);
    showToast("«Кадр» установлен на устройство");
  });
}

function renderInstallState(justInstalled = false) {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true || justInstalled;
  el.installAppPanel.classList.toggle("is-installed", standalone);
  if (standalone) {
    el.installAppButton.textContent = "Установлено";
    el.installAppButton.disabled = true;
    el.installAppStatus.textContent = "Приложение открывается с главного экрана.";
    return;
  }
  el.installAppButton.disabled = false;
  el.installAppButton.textContent = state.installPrompt ? "Установить" : "Инструкция";
  el.installAppStatus.textContent = state.installPrompt
    ? "Готово к установке — это займёт несколько секунд."
    : "Открывайте с главного экрана без панели браузера.";
}

async function installApp() {
  if (state.installPrompt) {
    const prompt = state.installPrompt;
    state.installPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") showToast("Установка приложения началась");
    renderInstallState(choice.outcome === "accepted");
    return;
  }

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isAndroid = /android/i.test(navigator.userAgent);
  el.installDialogTitle.textContent = isIos
    ? "Добавьте «Кадр» на экран «Домой»"
    : "Добавьте «Кадр» на главный экран";

  const steps = isIos
    ? [
        "Откройте эту страницу в Safari.",
        "Нажмите кнопку «Поделиться» в панели браузера.",
        "Выберите «На экран Домой», затем нажмите «Добавить»."
      ]
    : isAndroid
      ? [
          "Откройте меню браузера ⋮.",
          "Выберите «Установить приложение» или «Добавить на главный экран».",
          "Подтвердите установку — ярлык появится рядом с приложениями."
        ]
      : [
          "Откройте меню браузера.",
          "Найдите пункт «Установить Кадр» или значок установки в адресной строке.",
          "Подтвердите установку приложения."
        ];

  el.installInstructions.replaceChildren(...steps.map((text, index) => {
    const item = document.createElement("div");
    item.className = "install-step";
    const number = document.createElement("span");
    number.textContent = String(index + 1);
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    item.append(number, paragraph);
    return item;
  }));
  el.installDialog.showModal();
}

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
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      state.serviceWorkerRegistration = await navigator.serviceWorker.register("./sw.js");
      state.serviceWorkerRegistration.addEventListener("updatefound", () => {
        const worker = state.serviceWorkerRegistration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            showToast("Обновление готово и применится при следующем запуске");
          }
        });
      });
    } catch (error) {
      console.info("Service Worker недоступен", error);
    }
  });
}
