import { invoke } from "@tauri-apps/api/core";
import { $, escapeHtml } from "./dom";
import { keyStorage, providerBase } from "./keys";
import { play, type DinoObstacle } from "./idle-state";
import { dinoUsesLaya, idleGame } from "./idle-game";
import { syncStartButton } from "./snake";

type DinoAction = "run" | "jump" | "duck";
type JevDecision = {
  choice: string;
  confidence: number;
  continueNow: number;
  endpoint?: string | null;
};


const DINO_W = 480;
const DINO_H = 150;
const DINO_GROUND = 118;
const DINO_BEST_KEY = "pi-auto-dino-best";
const DINO_ASK = "恐龙正在实时跑动，不会停。请综合跳跃高度、地面柱子和头顶上挡，选择现在不会撞上的动作。跳能越过柱子，但可能撞上挡；蹲能躲开低处上挡，但过不了柱子；跑保持当前姿态。多个都能过时，优先跑，其次蹲，最后跳。";

export function logDino(detail: string) {
  const box = $("idle-dino-log-list");
  const item = document.createElement("div");
  item.className = "idle-log-item";
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.innerHTML = `<span class="time">${time}</span>${escapeHtml(detail)}`;
  box.prepend(item);
  while (box.childElementCount > 40) box.removeChild(box.lastElementChild as Node);
}

export function dinoBox() {
  if (play.dinoDuck && play.dinoY < 2) return { x: 24, y: DINO_GROUND - 16, w: 38, h: 14 };
  return { x: 28, y: DINO_GROUND - 34 - play.dinoY, w: 20, h: 32 };
}

export function resetDino() {
  play.dinoRunning = false;
  play.dinoOver = false;
  play.dinoScore = 0;
  play.dinoY = 0;
  play.dinoVy = 0;
  play.dinoDuck = false;
  play.dinoSpeed = 2.4;
  play.dinoObstacles = [];
  play.dinoGap = 260;
  play.dinoLeg = 0;
  if (play.dinoRaf != null) {
    cancelAnimationFrame(play.dinoRaf);
    play.dinoRaf = null;
  }
  $("idle-dino-best").textContent = String(play.dinoBest);
  drawDino();
}

export function stopDino() {
  play.dinoEpoch += 1;
  play.dinoRunning = false;
  play.dinoDuck = false;
  play.dinoAsking = false;
  play.dinoSteerNote = "";
  if (play.dinoRaf != null) {
    cancelAnimationFrame(play.dinoRaf);
    play.dinoRaf = null;
  }
}

export function rememberDinoScore() {
  const score = Math.floor(play.dinoScore);
  if (score > play.dinoBest) {
    play.dinoBest = score;
    localStorage.setItem(DINO_BEST_KEY, String(play.dinoBest));
    logDino(`新纪录 ${play.dinoBest}`);
  } else if (score > 0) {
    logDino(`本局 ${score} · 最高 ${play.dinoBest}`);
  }
  $("idle-dino-best").textContent = String(play.dinoBest);
}

export function spawnDinoObstacle() {
  const bird = play.dinoScore > 280 && Math.random() < 0.16;
  if (bird) {
    const low = Math.random() < 0.7;
    play.dinoObstacles.push({ x: DINO_W + 20, w: 26, h: 10, y: low ? DINO_GROUND - 22 : DINO_GROUND - 46, bird: true });
    return;
  }
  const h = Math.random() < 0.75 ? 20 : 32;
  play.dinoObstacles.push({ x: DINO_W + 20, w: 12, h, y: DINO_GROUND - h, bird: false });
}

export function dinoHits(obstacle: DinoObstacle) {
  const box = dinoBox();
  return box.x < obstacle.x + obstacle.w - 6 && box.x + box.w > obstacle.x + 6 && box.y < obstacle.y + obstacle.h - 6 && box.y + box.h > obstacle.y + 6;
}

export function drawDinoGround(ctx: CanvasRenderingContext2D) {
  const scroll = Math.floor(play.dinoScore * 14);
  ctx.strokeStyle = "#2a303a";
  ctx.beginPath();
  ctx.moveTo(0, DINO_GROUND + 1);
  ctx.lineTo(DINO_W, DINO_GROUND + 1);
  ctx.stroke();
  ctx.fillStyle = "#1c2129";
  for (let i = 0; i < 18; i += 1) {
    const x = ((i * 28 - (scroll % 28)) + 28) % (DINO_W + 28) - 8;
    ctx.fillRect(x, DINO_GROUND + 5, 10, 1);
  }
}

export function drawDinoTree(ctx: CanvasRenderingContext2D, obstacle: DinoObstacle) {
  const x = obstacle.x;
  const y = obstacle.y;
  const w = obstacle.w;
  const h = obstacle.h;
  const trunkW = 4;
  const trunkX = x + Math.floor((w - trunkW) / 2);
  ctx.fillStyle = "#6d7582";
  ctx.fillRect(trunkX, y + 8, trunkW, h - 8);
  ctx.fillStyle = "#86a892";
  const crownH = Math.min(12, Math.max(7, h - 12));
  ctx.fillRect(x, y, w, crownH);
  ctx.fillRect(x + 1, y + 3, w - 2, crownH - 2);
  ctx.fillStyle = "#a4c2ad";
  ctx.fillRect(x + 2, y + 2, Math.max(2, w - 8), 3);
}

export function drawDinoBird(ctx: CanvasRenderingContext2D, obstacle: DinoObstacle) {
  const x = obstacle.x;
  const y = obstacle.y;
  const flap = Math.floor(play.dinoLeg + obstacle.x / 12) % 2 === 0;
  ctx.fillStyle = "#8aa4c2";
  ctx.fillRect(x + 6, y + 3, 14, 5);
  ctx.fillRect(x + 16, y + 4, 6, 2);
  ctx.fillStyle = "#a9bdd4";
  if (flap) {
    ctx.fillRect(x, y, 10, 3);
    ctx.fillRect(x + 14, y, 10, 3);
  } else {
    ctx.fillRect(x + 1, y + 6, 9, 3);
    ctx.fillRect(x + 15, y + 6, 9, 3);
  }
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(x + 17, y + 4, 1, 1);
}

export function drawDinoRunner(ctx: CanvasRenderingContext2D) {
  const box = dinoBox();
  const ducking = play.dinoDuck && play.dinoY < 2;
  const step = Math.floor(play.dinoLeg) % 2 === 0;
  ctx.fillStyle = "#e7ebf2";
  if (ducking) {
    ctx.fillRect(box.x + 2, box.y + 4, 22, 7);
    ctx.fillRect(box.x + 20, box.y + 2, 12, 6);
    ctx.fillRect(box.x + 31, box.y + 4, 5, 2);
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(box.x + 26, box.y + 4, 2, 2);
    ctx.fillStyle = "#8b93a1";
    ctx.fillRect(box.x + (step ? 8 : 16), box.y + 11, 6, 2);
    return;
  }
  ctx.fillRect(box.x - 7, box.y + 12, 8, 3);
  ctx.fillRect(box.x, box.y + 10, 14, 10);
  ctx.fillRect(box.x + 10, box.y + 4, 5, 8);
  ctx.fillRect(box.x + 12, box.y, 8, 7);
  ctx.fillRect(box.x + 18, box.y + 2, 2, 3);
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(box.x + 16, box.y + 2, 2, 2);
  ctx.fillStyle = "#e7ebf2";
  ctx.fillRect(box.x + (step ? 2 : 8), box.y + 20, 3, 10);
  ctx.fillRect(box.x + (step ? 9 : 3), box.y + 20, 3, 10);
}

export function drawDino() {
  const canvas = $<HTMLCanvasElement>("idle-dino");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== DINO_W * dpr) {
    canvas.width = DINO_W * dpr;
    canvas.height = DINO_H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, DINO_W, DINO_H);
  drawDinoGround(ctx);
  for (const obstacle of play.dinoObstacles) {
    if (obstacle.bird) drawDinoBird(ctx, obstacle);
    else drawDinoTree(ctx, obstacle);
  }
  drawDinoRunner(ctx);
  const shown = Math.floor(play.dinoScore);
  $("idle-game-score").textContent = play.dinoOver ? `${shown} · 最高 ${play.dinoBest}` : String(shown);
  $("idle-game-hint").textContent = play.dinoSteerNote
    ? play.dinoSteerNote
    : play.dinoRunning && !play.dinoOver
      ? dinoUsesLaya()
        ? play.snakeAiBusy
          ? "Laya 决策中"
          : "Laya 控制 · 靠近障碍再决策"
        : "空格 / ↑ 跳 · ↓ 蹲"
      : `最高 ${play.dinoBest} · 空格开始`;
}

export function dinoDist(obstacle: DinoObstacle) {
  return obstacle.x - (dinoBox().x + dinoBox().w);
}

export function poseAt(y: number, duck: boolean) {
  if (duck && y < 2) return { x: 24, y: DINO_GROUND - 16, w: 38, h: 14 };
  return { x: 28, y: DINO_GROUND - 34 - y, w: 20, h: 32 };
}

export function band(obstacle: DinoObstacle) {
  const bottom = Math.round(DINO_GROUND - (obstacle.y + obstacle.h));
  const top = Math.round(DINO_GROUND - obstacle.y);
  return { bottom, top };
}

export function obstacleName(obstacle: DinoObstacle) {
  if (!obstacle.bird) return "柱子";
  return obstacle.y >= DINO_GROUND - 30 ? "低处上挡" : "高处上挡";
}

export function foresee(action: DinoAction) {
  let y = play.dinoY;
  let vy = play.dinoVy;
  let duck = action === "duck" ? y < 2 : action === "run" && y < 2 ? false : play.dinoDuck && action !== "jump";
  if (action === "jump" && y < 2) {
    vy = -7.4;
    duck = false;
  }
  const obstacles = play.dinoObstacles.map((item) => ({ ...item }));
  for (let frame = 0; frame < 100; frame += 1) {
    vy += duck && y < 2 ? 0.62 : 0.34;
    y = Math.max(0, y - vy);
    if (y === 0) vy = 0;
    const box = poseAt(y, duck);
    for (const obstacle of obstacles) {
      obstacle.x -= play.dinoSpeed;
      if (box.x < obstacle.x + obstacle.w - 6 && box.x + box.w > obstacle.x + 6 && box.y < obstacle.y + obstacle.h - 6 && box.y + box.h > obstacle.y + 6) {
        return { ok: false, hit: `${obstacleName(obstacle)}，约 ${frame} 帧后` };
      }
    }
    if (obstacles.every((item) => item.x + item.w < box.x)) return { ok: true, hit: "" };
  }
  return { ok: true, hit: "" };
}

export function dinoScene() {
  const jumpPeak = Math.round((7.4 * 7.4) / (2 * 0.34));
  const ahead = play.dinoObstacles
    .filter((item) => dinoDist(item) > -8)
    .sort((a, b) => a.x - b.x)
    .slice(0, 3);
  const lines = ahead.map((item, index) => {
    const span = band(item);
    return `${index + 1}. ${obstacleName(item)}，距离 ${Math.round(dinoDist(item))}，占据离地 ${span.bottom}-${span.top}，宽 ${item.w}`;
  });
  return [
    `跳跃：在地面起跳，初速度 7.4，最高约离地 ${jumpPeak}。当前离地 ${Math.round(play.dinoY)}，竖直速度 ${play.dinoVy.toFixed(1)}（负为上升）。${play.dinoY < 2 ? "现在可以跳或蹲。" : "已在空中，不能再跳，也不能蹲。"}`,
    ahead.length ? `前方障碍，从近到远：\n${lines.join("\n")}` : "前方没有障碍。",
    "柱子从地面长上来，要用跳越过。上挡在空中，低处上挡要蹲，高处上挡不要跳进去。",
  ].join("\n");
}

export function dinoActions(): DinoAction[] {
  return play.dinoY >= 2 ? ["run"] : ["run", "jump", "duck"];
}

export function nearestThreat() {
  return play.dinoObstacles
    .filter((item) => dinoDist(item) > -24)
    .sort((a, b) => a.x - b.x)[0];
}

export function dinoNeedsDecision() {
  const next = nearestThreat();
  if (!next) return false;
  return dinoDist(next) <= 260 || play.dinoY >= 2 || play.dinoDuck;
}

export function dinoChoices() {
  const actions = dinoActions();
  const label: Record<DinoAction, string> = { run: "继续跑", jump: "现在起跳", duck: "现在蹲下" };
  return actions.map((id) => {
    const outcome = foresee(id);
    return {
      id,
      text: `${label[id]}。按当前速度和跳跃轨迹推演：${outcome.ok ? "能过前方柱子和上挡" : `会撞上${outcome.hit}`}`,
    };
  });
}

export function applyDinoAction(id: DinoAction) {
  if (id === "jump") {
    if (play.dinoY >= 2) return;
    play.dinoDuck = false;
    play.dinoVy = -7.4;
    return;
  }
  if (play.dinoY < 2) play.dinoDuck = id === "duck";
}

export function releaseDinoDuck() {
  if (!play.dinoDuck || !dinoUsesLaya()) return;
  const box = dinoBox();
  const blocking = play.dinoObstacles.some((item) => item.bird && item.y >= DINO_GROUND - 30 && item.x + item.w > box.x - 8);
  if (!blocking) play.dinoDuck = false;
}

export function liveChoiceFits(id: DinoAction) {
  return foresee(id).ok;
}

export function continueDinoAsk(epoch: number, delay = 30) {
  play.dinoAsking = false;
  if (epoch !== play.dinoEpoch || !play.dinoRunning || play.dinoOver || !dinoUsesLaya()) return;
  if (!dinoNeedsDecision()) return;
  play.dinoAsking = true;
  window.setTimeout(() => void dinoTurn(epoch), delay);
}

export async function dinoTurn(epoch: number) {
  if (epoch !== play.dinoEpoch || !play.dinoRunning || play.dinoOver || !dinoUsesLaya() || !dinoNeedsDecision()) {
    play.dinoAsking = false;
    return;
  }
  if (play.snakeAiBusy) {
    window.setTimeout(() => void dinoTurn(epoch), 200);
    return;
  }
  const options = dinoChoices();
  const viable = options.filter((item) => foresee(item.id).ok);
  if (viable.length <= 1) {
    const only = viable[0];
    if (only && only.id !== "run") {
      applyDinoAction(only.id);
      logDino(`只有 ${only.id} 能过，直接执行`);
    }
    play.dinoSteerNote = "";
    continueDinoAsk(epoch, 140);
    return;
  }
  play.snakeAiBusy = true;
  play.dinoSteerNote = "Laya 决策中";
  const started = Date.now();
  logDino(`问 · ${options.map((item) => `${item.id}${foresee(item.id).ok ? "可过" : "会撞"}`).join(" ")}`);
  try {
    const decision = await invoke<JevDecision>("jev_choose", {
      provider: "laya",
      apiKey: localStorage.getItem(keyStorage("laya"))?.trim() || null,
      baseUrl: providerBase("laya"),
      state: [
        "恐龙正在实时跑动，不会停下来等你。综合跳跃、柱子和上挡再选。",
        `分数 ${Math.floor(play.dinoScore)}。水平速度 ${play.dinoSpeed.toFixed(1)}。`,
        dinoScene(),
      ].join("\n"),
      options: options.map((item) => ({ id: item.id, text: item.text })),
      instructions: DINO_ASK,
      includeStop: false,
    });
    if (epoch !== play.dinoEpoch || play.dinoOver || idleGame() !== "dino") return;
    const picked = options.find((item) => item.id === decision.choice) ?? options.find((item) => liveChoiceFits(item.id)) ?? options[0];
    if (!liveChoiceFits(picked.id)) {
      logDino(`${picked.id} 返回时已不适用，不执行`);
    } else {
      logDino(`${decision.endpoint ?? play.layaBase} · ${picked.id} · 置信 ${Math.round(decision.confidence * 100)}% · ${Date.now() - started}ms`);
      applyDinoAction(picked.id);
    }
    play.dinoSteerNote = "";
  } catch (error) {
    if (epoch !== play.dinoEpoch) return;
    play.dinoSteerNote = "Laya 决策失败，正在重试";
    logDino(`失败 ${error}`);
    window.setTimeout(() => void dinoTurn(epoch), 600);
    return;
  } finally {
    play.snakeAiBusy = false;
  }
  continueDinoAsk(epoch);
}

export function queueDinoTurn() {
  if (!play.dinoRunning || play.dinoOver || !dinoUsesLaya() || play.snakeAiBusy || play.dinoAsking || !dinoNeedsDecision()) return;
  play.dinoAsking = true;
  const epoch = play.dinoEpoch;
  window.setTimeout(() => void dinoTurn(epoch), 30);
}

export function stepDino(now: number) {
  if (!play.dinoRunning || play.dinoOver || idleGame() !== "dino") return;
  play.dinoRaf = null;
  releaseDinoDuck();
  const dt = Math.min(32, play.dinoLast ? now - play.dinoLast : 16) / 16;
  play.dinoLast = now;
  play.dinoSpeed = Math.min(4.6, 2.4 + play.dinoScore * 0.0016);
  play.dinoVy += (play.dinoDuck ? 0.62 : 0.34) * dt;
  play.dinoY = Math.max(0, play.dinoY - play.dinoVy * dt);
  if (play.dinoY === 0) play.dinoVy = 0;
  play.dinoScore += play.dinoSpeed * dt * 0.08;
  play.dinoLeg += dt;
  play.dinoGap -= play.dinoSpeed * dt;
  if (play.dinoGap <= 0) {
    spawnDinoObstacle();
    play.dinoGap = 240 + Math.random() * 140;
  }
  for (const obstacle of play.dinoObstacles) obstacle.x -= play.dinoSpeed * dt;
  play.dinoObstacles = play.dinoObstacles.filter((obstacle) => obstacle.x + obstacle.w > -8);
  if (dinoUsesLaya()) queueDinoTurn();
  if (play.dinoObstacles.some(dinoHits)) {
    play.dinoOver = true;
    play.dinoRunning = false;
    rememberDinoScore();
    drawDino();
    syncStartButton();
    return;
  }
  drawDino();
  play.dinoRaf = requestAnimationFrame(stepDino);
}

export function beginDino() {
  if (dinoUsesLaya() && !play.backends.laya) return;
  resetDino();
  play.dinoEpoch += 1;
  play.dinoRunning = true;
  play.dinoLast = 0;
  play.dinoSteerNote = "";
  play.dinoAsking = false;
  drawDino();
  syncStartButton();
  play.dinoRaf = requestAnimationFrame(stepDino);
  if (dinoUsesLaya()) queueDinoTurn();
}

export function dinoJump() {
  if (!play.dinoRunning || play.dinoOver || play.dinoY > 0 || (play.dinoDuck && play.dinoY < 2)) return;
  play.dinoVy = -7.4;
}

export function onDinoKey(event: KeyboardEvent) {
  if (event.key === " " || event.key === "ArrowUp" || event.key === "w") {
    event.preventDefault();
    if (!play.dinoRunning || play.dinoOver) {
      beginDino();
      return;
    }
    if (!dinoUsesLaya()) dinoJump();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "s") {
    event.preventDefault();
    if (play.dinoRunning && !play.dinoOver && !dinoUsesLaya()) play.dinoDuck = true;
  }
}
