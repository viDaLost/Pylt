const VOLUME_KEY = "cameraCueVolumeV2";
const ALERTS_KEY = "cameraCueAlertsV1";

const receiverSignal = document.getElementById("receiverSignal");
const enableButton = document.getElementById("enableAlertsButton");
const alertsStatus = document.getElementById("alertsStatus");
const controls = document.querySelector(".alert-controls");

let audioContext = null;
let lastIsActive = receiverSignal?.classList.contains("receiver-signal--green") ?? false;
let initialized = false;
let previewTimer = null;

const savedVolume = Number.parseInt(localStorage.getItem(VOLUME_KEY) || "90", 10);
let volume = Number.isFinite(savedVolume) ? Math.min(100, Math.max(0, savedVolume)) : 90;

if (controls && enableButton && receiverSignal) {
  buildVolumeControls();
  simplifyEnableButton();
  bindAudioUnlock();
  watchSignalChanges();
}

function buildVolumeControls() {
  const panel = document.createElement("div");
  panel.className = "volume-panel";
  panel.innerHTML = `
    <div class="volume-panel__header">
      <label for="alertVolume">Громкость сигнала</label>
      <output id="alertVolumeValue" for="alertVolume">${volume}%</output>
    </div>
    <div class="volume-panel__row">
      <span aria-hidden="true">🔈</span>
      <input id="alertVolume" type="range" min="0" max="100" step="5" value="${volume}" aria-label="Громкость сигнала">
      <span aria-hidden="true">🔊</span>
    </div>
    <p class="volume-panel__hint">Установите громкость телефона выше и отключите беззвучный режим.</p>
    <details class="android-help">
      <summary>Как включить уведомления на Android</summary>
      <ol>
        <li>Нажмите кнопку «Включить всё одним нажатием».</li>
        <li>В окне Chrome нажмите «Разрешить».</li>
        <li>Если запроса нет: Настройки телефона → Приложения → Chrome → Уведомления → Разрешить.</li>
        <li>Для более надёжной работы: меню Chrome ⋮ → «Добавить на главный экран».</li>
      </ol>
    </details>
  `;

  enableButton.insertAdjacentElement("afterend", panel);

  const slider = panel.querySelector("#alertVolume");
  const output = panel.querySelector("#alertVolumeValue");

  slider.addEventListener("input", () => {
    volume = Number(slider.value);
    output.value = `${volume}%`;
    localStorage.setItem(VOLUME_KEY, String(volume));
  });

  slider.addEventListener("change", () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      await unlockAudio();
      playEnhancedCue(true, true);
    }, 80);
  });
}

function simplifyEnableButton() {
  const label = enableButton.querySelector("#enableAlertsLabel") || enableButton;
  if (!enableButton.classList.contains("is-enabled")) {
    label.textContent = "Включить всё одним нажатием";
  }

  const updatePermissionText = () => {
    if (!("Notification" in window)) return;

    if (Notification.permission === "granted") {
      alertsStatus.textContent = "Звук и уведомления разрешены. Оставьте громкость телефона включённой.";
    } else if (Notification.permission === "denied") {
      alertsStatus.textContent = "Уведомления запрещены. Android: Настройки → Приложения → Chrome → Уведомления → Разрешить.";
    } else if (localStorage.getItem(ALERTS_KEY) === "enabled") {
      alertsStatus.textContent = "Нажмите кнопку ещё раз и выберите «Разрешить» в запросе браузера.";
    }
  };

  enableButton.addEventListener("click", () => {
    setTimeout(() => {
      if (enableButton.classList.contains("is-enabled")) {
        label.textContent = "Оповещения включены";
      }
      updatePermissionText();
    }, 700);
  });

  setTimeout(updatePermissionText, 500);
}

function bindAudioUnlock() {
  const unlock = async () => {
    await unlockAudio();
    if (!initialized) {
      initialized = true;
      playEnhancedCue(true, true);
    }
  };

  enableButton.addEventListener("pointerdown", unlock, { passive: true });
  enableButton.addEventListener("click", unlock);
}

async function unlockAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;

  audioContext ||= new AudioContextClass();
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch {
      return false;
    }
  }
  return true;
}

function watchSignalChanges() {
  const observer = new MutationObserver(() => {
    const isActive = receiverSignal.classList.contains("receiver-signal--green");
    if (isActive === lastIsActive) return;

    lastIsActive = isActive;
    const enabled = localStorage.getItem(ALERTS_KEY) === "enabled" || enableButton.classList.contains("is-enabled");
    if (!enabled) return;

    playEnhancedCue(isActive);
    navigator.vibrate?.(isActive ? [250, 100, 250, 100, 400] : [180]);
  });

  observer.observe(receiverSignal, { attributes: true, attributeFilter: ["class"] });
}

async function playEnhancedCue(isActive, isPreview = false) {
  if (!(await unlockAudio()) || !audioContext || volume === 0) return;

  const master = audioContext.createGain();
  const compressor = audioContext.createDynamicsCompressor();
  const now = audioContext.currentTime + 0.015;
  const level = Math.max(0.01, volume / 100);

  compressor.threshold.setValueAtTime(-18, now);
  compressor.knee.setValueAtTime(12, now);
  compressor.ratio.setValueAtTime(8, now);
  compressor.attack.setValueAtTime(0.003, now);
  compressor.release.setValueAtTime(0.18, now);

  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(Math.min(0.95, level * (isPreview ? 0.62 : 0.9)), now + 0.025);

  const pulses = isActive
    ? [
        { offset: 0, duration: 0.2, frequencies: [740, 1110, 1480] },
        { offset: 0.27, duration: 0.28, frequencies: [880, 1320, 1760] }
      ]
    : [
        { offset: 0, duration: 0.32, frequencies: [330, 440] }
      ];

  let end = now;
  for (const pulse of pulses) {
    const start = now + pulse.offset;
    const stop = start + pulse.duration;
    end = Math.max(end, stop);

    pulse.frequencies.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const voiceGain = audioContext.createGain();
      oscillator.type = index === 0 ? "square" : "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      voiceGain.gain.setValueAtTime(0.0001, start);
      voiceGain.gain.exponentialRampToValueAtTime(index === 0 ? 0.34 : 0.2, start + 0.012);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, stop);
      oscillator.connect(voiceGain).connect(master);
      oscillator.start(start);
      oscillator.stop(stop + 0.02);
    });
  }

  master.gain.setValueAtTime(Math.min(0.95, level * (isPreview ? 0.62 : 0.9)), Math.max(now + 0.03, end - 0.05));
  master.gain.exponentialRampToValueAtTime(0.0001, end + 0.04);
  master.connect(compressor).connect(audioContext.destination);
}
