import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getDatabase, limitToLast, onValue, orderByChild, push, query, ref, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const SESSION_KEY = "cameraCueSessionV1";
const LAST_READ_PREFIX = "cameraCueChatRead:";
const app = isFirebaseConfigured ? (getApps().length ? getApp() : initializeApp(firebaseConfig)) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getDatabase(app) : null;

const ui = buildChatUi();
let user = null;
let roomId = null;
let displayName = null;
let roomMessagesOff = null;
let messages = [];
let open = false;
let lastSessionSignature = "";

if (auth && db) {
  onAuthStateChanged(auth, (nextUser) => {
    user = nextUser;
    syncSession();
  });
  window.setInterval(syncSession, 700);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncSession();
  });
}

function buildChatUi() {
  const launcher = document.createElement("button");
  launcher.id = "chatLauncher";
  launcher.className = "chat-launcher";
  launcher.type = "button";
  launcher.innerHTML = `<span aria-hidden="true">💬</span><span>Чат</span><span id="chatUnread" class="chat-launcher__badge">0</span>`;

  const overlay = document.createElement("div");
  overlay.id = "chatOverlay";
  overlay.className = "chat-overlay";
  overlay.innerHTML = `
    <section class="chat-panel" role="dialog" aria-modal="true" aria-labelledby="chatTitle">
      <header class="chat-header">
        <div><h2 id="chatTitle">Чат комнаты</h2><p id="chatRoomLabel">Ожидание подключения…</p></div>
        <button id="chatClose" class="chat-close" type="button" aria-label="Закрыть чат">×</button>
      </header>
      <div id="chatMessages" class="chat-messages" aria-live="polite"></div>
      <form id="chatForm" class="chat-form">
        <textarea id="chatInput" class="chat-input" maxlength="500" rows="1" placeholder="Сообщение…" aria-label="Текст сообщения"></textarea>
        <button id="chatSend" class="chat-send" type="submit" aria-label="Отправить">➤</button>
        <p id="chatError" class="chat-error"></p>
      </form>
    </section>`;

  document.body.append(launcher, overlay);
  const result = {
    launcher,
    overlay,
    unread: overlay.ownerDocument.getElementById("chatUnread"),
    roomLabel: overlay.querySelector("#chatRoomLabel"),
    close: overlay.querySelector("#chatClose"),
    messages: overlay.querySelector("#chatMessages"),
    form: overlay.querySelector("#chatForm"),
    input: overlay.querySelector("#chatInput"),
    send: overlay.querySelector("#chatSend"),
    error: overlay.querySelector("#chatError")
  };

  launcher.addEventListener("click", () => setOpen(true));
  result.close.addEventListener("click", () => setOpen(false));
  overlay.addEventListener("click", (event) => { if (event.target === overlay) setOpen(false); });
  result.form.addEventListener("submit", sendMessage);
  result.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      result.form.requestSubmit();
    }
  });
  return result;
}

function syncSession() {
  const session = readSession();
  const controllerVisible = !document.getElementById("controllerView")?.classList.contains("hidden");
  const receiverVisible = !document.getElementById("receiverView")?.classList.contains("hidden");
  const activeRoom = Boolean(user && session?.roomId && (controllerVisible || receiverVisible));
  const signature = activeRoom ? `${session.roomId}:${session.name}:${user.uid}` : "";

  ui.launcher.classList.toggle("is-visible", activeRoom);
  if (!activeRoom) {
    if (roomId) leaveChatRoom();
    return;
  }
  if (signature === lastSessionSignature) return;
  lastSessionSignature = signature;
  enterChatRoom(session.roomId, session.name);
}

function readSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!value?.roomId || !value?.name) return null;
    return { roomId: String(value.roomId).toUpperCase(), name: String(value.name).slice(0, 40) };
  } catch { return null; }
}

function enterChatRoom(nextRoomId, nextName) {
  roomMessagesOff?.();
  roomId = nextRoomId;
  displayName = nextName;
  messages = [];
  ui.roomLabel.textContent = `Комната ${roomId}`;
  ui.messages.innerHTML = `<div class="chat-empty">Сообщений пока нет. Напишите первое сообщение.</div>`;
  const messagesQuery = query(ref(db, `rooms/${roomId}/messages`), orderByChild("createdAt"), limitToLast(100));
  roomMessagesOff = onValue(messagesQuery, (snapshot) => {
    const data = snapshot.val() || {};
    messages = Object.entries(data)
      .map(([id, value]) => ({ id, ...value }))
      .filter((message) => typeof message.text === "string")
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    renderMessages();
    updateUnread();
  }, () => showError("Чат недоступен. Опубликуйте обновлённые правила Firebase."));
}

function leaveChatRoom() {
  roomMessagesOff?.();
  roomMessagesOff = null;
  roomId = null;
  displayName = null;
  lastSessionSignature = "";
  setOpen(false);
}

function setOpen(nextOpen) {
  if (!roomId) return;
  open = nextOpen;
  ui.overlay.classList.toggle("is-open", open);
  document.body.style.overflow = open ? "hidden" : "";
  if (open) {
    markRead();
    window.setTimeout(() => {
      scrollToBottom();
      ui.input.focus({ preventScroll: true });
    }, 40);
  }
}

async function sendMessage(event) {
  event.preventDefault();
  clearError();
  const text = ui.input.value.trim();
  if (!text || !roomId || !user) return;
  ui.send.disabled = true;
  try {
    await push(ref(db, `rooms/${roomId}/messages`), {
      uid: user.uid,
      name: displayName,
      text: text.slice(0, 500),
      createdAt: serverTimestamp()
    });
    ui.input.value = "";
    markRead();
  } catch (error) {
    console.error(error);
    showError(error?.code?.includes("permission-denied")
      ? "Firebase пока запрещает отправку. Обновите правила базы."
      : "Не удалось отправить сообщение.");
  } finally {
    ui.send.disabled = false;
  }
}

function renderMessages() {
  if (!messages.length) {
    ui.messages.innerHTML = `<div class="chat-empty">Сообщений пока нет. Напишите первое сообщение.</div>`;
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    const item = document.createElement("article");
    item.className = `chat-message${message.uid === user?.uid ? " is-own" : ""}`;
    const bubble = document.createElement("div");
    bubble.className = "chat-message__bubble";
    const meta = document.createElement("div");
    meta.className = "chat-message__meta";
    const name = document.createElement("span");
    name.className = "chat-message__name";
    name.textContent = message.uid === user?.uid ? "Вы" : String(message.name || "Участник");
    const time = document.createElement("time");
    time.textContent = formatTime(message.createdAt);
    const text = document.createElement("p");
    text.className = "chat-message__text";
    text.textContent = message.text;
    meta.append(name, time);
    bubble.append(meta, text);
    item.append(bubble);
    fragment.append(item);
  }
  ui.messages.replaceChildren(fragment);
  if (open) scrollToBottom();
}

function updateUnread() {
  if (!roomId) return;
  if (open) { markRead(); return; }
  const lastRead = Number(localStorage.getItem(`${LAST_READ_PREFIX}${roomId}`) || 0);
  const unread = messages.filter((message) => message.uid !== user?.uid && Number(message.createdAt || 0) > lastRead).length;
  ui.unread.textContent = unread > 99 ? "99+" : String(unread);
  ui.unread.classList.toggle("has-unread", unread > 0);
}

function markRead() {
  if (!roomId) return;
  const newest = messages.reduce((max, message) => Math.max(max, Number(message.createdAt || 0)), Date.now());
  localStorage.setItem(`${LAST_READ_PREFIX}${roomId}`, String(newest));
  ui.unread.classList.remove("has-unread");
  ui.unread.textContent = "0";
}

function scrollToBottom() { ui.messages.scrollTop = ui.messages.scrollHeight; }
function formatTime(value) {
  const date = new Date(Number(value || Date.now()));
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date);
}
function showError(text) { ui.error.textContent = text; ui.error.classList.add("is-visible"); }
function clearError() { ui.error.textContent = ""; ui.error.classList.remove("is-visible"); }
