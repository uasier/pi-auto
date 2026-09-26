import { play, type Cell } from "./idle-state";
import { applyStep, queueAiTurn, refreshGameBackends, resetSnake, startControlLoop, syncStartButton, waitingToStart } from "./snake";
import { beginDino, onDinoKey, resetDino, stopDino } from "./dino";
import { $ } from "./dom";

export { refreshGameBackends };

type SnakeDriver = "manual" | "jev" | "laya";
const SNAKE_DRIVER_KEY = "pi-auto-snake-driver";
const DINO_DRIVER_KEY = "pi-auto-dino-driver";

function storedDriver(game: IdleGameKind): SnakeDriver {
  const value = localStorage.getItem(game === "dino" ? DINO_DRIVER_KEY : SNAKE_DRIVER_KEY);
  if (game === "dino") return value === "laya" ? "laya" : "manual";
  return value === "jev" || value === "laya" ? value : "manual";
}

export function snakeDriver(): SnakeDriver {
  const value = $<HTMLSelectElement>("idle-driver").value;
  if (idleGame() === "dino") return value === "laya" ? "laya" : "manual";
  return value === "jev" || value === "laya" ? value : "manual";
}

type IdleGameKind = "snake" | "dino";
const IDLE_GAME_KEY = "pi-auto-idle-game";

export function idleGame(): IdleGameKind {
  const value = $<HTMLSelectElement>("idle-game-kind").value;
  return value === "dino" ? "dino" : "snake";
}

export function dinoUsesLaya() {
  return idleGame() === "dino" && snakeDriver() === "laya";
}

export function syncDriverOptions() {
  const snake = idleGame() === "snake";
  const jevOpt = $<HTMLOptionElement>("idle-driver-jev");
  const layaOpt = $<HTMLOptionElement>("idle-driver-laya");
  jevOpt.hidden = !snake;
  jevOpt.disabled = !snake || !play.backends.jev;
  layaOpt.disabled = !play.backends.laya;
  jevOpt.textContent = play.backends.jev ? "Jev" : "Jev 未接入";
  layaOpt.textContent = play.backends.laya ? "Laya" : "Laya 未接入";
  syncStartButton();
}

function loadDriverSelect(game: IdleGameKind = idleGame()) {
  const select = $<HTMLSelectElement>("idle-driver");
  const driver = storedDriver(game);
  syncDriverOptions();
  if (select.value !== driver) select.value = driver;
}

export function syncSnakeControls() {
  const snake = idleGame() === "snake";
  $("idle-game").classList.toggle("hidden", !snake);
  $("idle-dino").classList.toggle("hidden", snake);
  $("idle-snake-log").classList.toggle("hidden", !snake);
  $("idle-dino-log").classList.toggle("hidden", snake);
  syncDriverOptions();
}


export function beginGame() {
  if (idleGame() === "dino") {
    beginDino();
    return;
  }
  const driver = snakeDriver();
  if (driver === "jev" && !play.backends.jev) return;
  if (driver === "laya" && !play.backends.laya) return;
  stopDino();
  play.snakeRunning = true;
  resetSnake();
  startControlLoop();
  syncStartButton();
}



export function showIdleGame() {
  if (play.snakeShown) return;
  play.snakeShown = true;
  syncSnakeControls();
  if (idleGame() === "dino") resetDino();
  else {
    resetSnake();
    startControlLoop();
  }
  void refreshGameBackends();
  if (play.snakeProbe == null) play.snakeProbe = window.setInterval(() => void refreshGameBackends(), 8000);
}

export function hideIdleGame() {
  play.snakeShown = false;
  play.snakeEpoch += 1;
  play.snakeRunning = false;
  if (play.snakeTimer != null) {
    window.clearInterval(play.snakeTimer);
    play.snakeTimer = null;
  }
  if (play.snakeProbe != null) {
    window.clearInterval(play.snakeProbe);
    play.snakeProbe = null;
  }
  stopDino();
}

export function onIdleGameKey(event: KeyboardEvent) {
  if ($("preview-empty").classList.contains("hidden")) return;
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (idleGame() === "dino") {
    onDinoKey(event);
    return;
  }
  const turn: Record<string, Cell> = {
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    w: { x: 0, y: -1 },
    s: { x: 0, y: 1 },
    a: { x: -1, y: 0 },
    d: { x: 1, y: 0 },
  };
  const next = turn[event.key];
  if (next) {
    event.preventDefault();
    if (waitingToStart()) return;
    if (next.x === -play.snakeDir.x && next.y === -play.snakeDir.y) return;
    if (snakeDriver() === "manual") {
      play.snakeNext = next;
      return;
    }
    play.snakeEpoch += 1;
    applyStep(next);
    if (!play.snakeOver) queueAiTurn();
    return;
  }
  if ((event.key === " " || event.key === "Enter") && waitingToStart()) {
    event.preventDefault();
    beginGame();
  }
}

export function installIdleGame() {
  window.addEventListener("keydown", onIdleGameKey);
  window.addEventListener("keyup", (event) => {
    if ((event.key === "ArrowDown" || event.key === "s") && !dinoUsesLaya()) play.dinoDuck = false;
  });
  const driver = $<HTMLSelectElement>("idle-driver");
  const kind = $<HTMLSelectElement>("idle-game-kind");
  kind.value = localStorage.getItem(IDLE_GAME_KEY) === "dino" ? "dino" : "snake";
  loadDriverSelect();
  $("idle-dino-best").textContent = String(play.dinoBest);
  driver.addEventListener("change", () => {
    const game = idleGame();
    const next = snakeDriver();
    localStorage.setItem(game === "dino" ? DINO_DRIVER_KEY : SNAKE_DRIVER_KEY, next);
    play.snakeEpoch += 1;
    play.snakeRunning = false;
    if (play.snakeTimer != null) {
      window.clearInterval(play.snakeTimer);
      play.snakeTimer = null;
    }
    stopDino();
    syncSnakeControls();
    if ($("preview-empty").classList.contains("hidden")) return;
    if (game === "dino") resetDino();
    else startControlLoop();
  });
  kind.addEventListener("change", () => {
    const game = idleGame();
    localStorage.setItem(IDLE_GAME_KEY, game);
    loadDriverSelect(game);
    play.snakeEpoch += 1;
    play.snakeRunning = false;
    if (play.snakeTimer != null) {
      window.clearInterval(play.snakeTimer);
      play.snakeTimer = null;
    }
    stopDino();
    syncSnakeControls();
    if ($("preview-empty").classList.contains("hidden")) return;
    if (game === "dino") resetDino();
    else {
      resetSnake();
      startControlLoop();
    }
  });
  $("idle-start").addEventListener("click", beginGame);
  showIdleGame();
}

