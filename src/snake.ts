import { invoke } from "@tauri-apps/api/core";
import { $, escapeHtml } from "./dom";
import { JEV_KEY_STORAGE, LAYA_BASE_STORAGE, keyStorage, providerBase } from "./keys";
import { play, type Cell } from "./idle-state";
import { dinoUsesLaya, idleGame, snakeDriver, syncDriverOptions } from "./idle-game";
import { drawDino } from "./dino";
import type { JevDecision } from "./types";

const SNAKE_GRID = 15;
const SNAKE_CELL = 16;
const SNAKE_SPEED = 180;

function placeSnakeFood() {
  const used = new Set(play.snakeBody.map((cell) => `${cell.x},${cell.y}`));
  const open: Cell[] = [];
  for (let y = 0; y < SNAKE_GRID; y += 1) {
    for (let x = 0; x < SNAKE_GRID; x += 1) {
      if (!used.has(`${x},${y}`)) open.push({ x, y });
    }
  }
  play.snakeFood = open[Math.floor(Math.random() * open.length)] ?? { x: 0, y: 0 };
}

export function resetSnake() {
  play.snakeBody = [
    { x: 4, y: 7 },
    { x: 3, y: 7 },
    { x: 2, y: 7 },
  ];
  play.snakeDir = { x: 1, y: 0 };
  play.snakeNext = play.snakeDir;
  play.snakeScore = 0;
  play.snakeOver = false;
  placeSnakeFood();
  drawSnake();
}

function logSnake(detail: string, err = false) {
  const box = $("idle-game-log-list");
  const item = document.createElement("div");
  item.className = `idle-log-item${err ? " err" : ""}`;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.innerHTML = `<span class="time">${time}</span>${escapeHtml(detail)}`;
  box.prepend(item);
  while (box.childElementCount > 80) box.removeChild(box.lastElementChild as Node);
}

function drawSnake() {
  const canvas = $<HTMLCanvasElement>("idle-game");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const size = SNAKE_GRID * SNAKE_CELL;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#15181e";
  ctx.lineWidth = 1;
  for (let i = 1; i < SNAKE_GRID; i += 1) {
    const at = i * SNAKE_CELL + 0.5;
    ctx.beginPath();
    ctx.moveTo(at, 0);
    ctx.lineTo(at, size);
    ctx.moveTo(0, at);
    ctx.lineTo(size, at);
    ctx.stroke();
  }
  drawSnakeFood(ctx);
  for (let index = play.snakeBody.length - 1; index >= 0; index -= 1) drawSnakePart(ctx, index);
  $("idle-game-score").textContent = play.snakeOver ? `${play.snakeScore} · 点开始重来` : String(play.snakeScore);
  const driver = $<HTMLSelectElement>("idle-driver").value;
  const driving = driver === "jev" || driver === "laya";
  $("idle-game-hint").textContent = play.snakeSteerNote
    ? play.snakeSteerNote
    : driving
      ? `${driver === "laya" ? "Laya" : "Jev"} 控制 · 收到决策才移动`
      : "方向键移动 · 选会话后停止";
}

export function waitingToStart() {
  if (idleGame() === "dino") return !play.dinoRunning || play.dinoOver;
  return !play.snakeRunning || play.snakeOver;
}

export function syncStartButton() {
  const button = $<HTMLButtonElement>("idle-start");
  button.classList.toggle("hidden", !waitingToStart());
  if (idleGame() === "dino") {
    button.disabled = dinoUsesLaya() && !play.backends.laya;
    return;
  }
  const driver = snakeDriver();
  button.disabled = (driver === "jev" && !play.backends.jev) || (driver === "laya" && !play.backends.laya);
}

const SNAKE_ASK_FRUIT =
  "先吃到果子，再选更近的。不要选会困住的，除非每个选项都会困住。距离相同就选走后可达格更多的，再保持当前朝向。";
const SNAKE_ASK_LIVE =
  "这些方向都不会立刻死，但都不更近。选不会困住且距离最小的。都会困住时，选走后可达格更多的。";

const SNAKE_DIRS = [
  { id: "up" as const, name: "上", dir: { x: 0, y: -1 } },
  { id: "down" as const, name: "下", dir: { x: 0, y: 1 } },
  { id: "left" as const, name: "左", dir: { x: -1, y: 0 } },
  { id: "right" as const, name: "右", dir: { x: 1, y: 0 } },
];

function cellKey(cell: Cell) {
  return `${cell.x},${cell.y}`;
}

function snakeChar(x: number, y: number) {
  if (x < 0 || y < 0 || x >= SNAKE_GRID || y >= SNAKE_GRID) return "#";
  if (x === play.snakeBody[0]?.x && y === play.snakeBody[0]?.y) return "H";
  const tail = play.snakeBody[play.snakeBody.length - 1];
  if (tail && x === tail.x && y === tail.y) return "T";
  if (play.snakeBody.some((cell) => cell.x === x && cell.y === y)) return "o";
  if (x === play.snakeFood.x && y === play.snakeFood.y) return "*";
  return ".";
}

function drawSnakeFood(ctx: CanvasRenderingContext2D) {
  const x = play.snakeFood.x * SNAKE_CELL;
  const y = play.snakeFood.y * SNAKE_CELL;
  ctx.fillStyle = "#c98b86";
  ctx.fillRect(x + 6, y + 6, 4, 4);
  ctx.fillRect(x + 7, y + 3, 2, 10);
  ctx.fillRect(x + 3, y + 7, 10, 2);
}

function drawSnakePart(ctx: CanvasRenderingContext2D, index: number) {
  const cell = play.snakeBody[index];
  const x = cell.x * SNAKE_CELL;
  const y = cell.y * SNAKE_CELL;
  const head = index === 0;
  const tail = index === play.snakeBody.length - 1;
  ctx.fillStyle = head ? "#e7ebf2" : tail ? "#5f8f86" : "#7eaea6";
  const inset = head ? 2 : 3;
  ctx.fillRect(x + inset, y + inset, SNAKE_CELL - inset * 2, SNAKE_CELL - inset * 2);
  if (index > 0) {
    const prev = play.snakeBody[index - 1];
    ctx.fillRect(((cell.x + prev.x) * SNAKE_CELL) / 2 + 6, ((cell.y + prev.y) * SNAKE_CELL) / 2 + 6, 4, 4);
  }
  if (!head) return;
  ctx.fillStyle = "#0a0c10";
  const px = play.snakeDir.y;
  const py = -play.snakeDir.x;
  ctx.fillRect(x + 7 + play.snakeDir.x * 3 + px * 2, y + 7 + play.snakeDir.y * 3 + py * 2, 2, 2);
  ctx.fillRect(x + 7 + play.snakeDir.x * 3 - px * 2, y + 7 + play.snakeDir.y * 3 - py * 2, 2, 2);
}

function dirName(dir: Cell) {
  if (dir.x === 1) return "右";
  if (dir.x === -1) return "左";
  if (dir.y === 1) return "下";
  return "上";
}

function foodSide(dx: number, dy: number) {
  const horizontal = dx === 0 ? "" : dx > 0 ? `右 ${dx}` : `左 ${-dx}`;
  const vertical = dy === 0 ? "" : dy > 0 ? `下 ${dy}` : `上 ${-dy}`;
  return [horizontal, vertical].filter(Boolean).join("、") || "已重合";
}

function boardMap() {
  const rows: string[] = [];
  for (let y = 0; y < SNAKE_GRID; y += 1) {
    let line = "";
    for (let x = 0; x < SNAKE_GRID; x += 1) line += snakeChar(x, y);
    rows.push(line);
  }
  return rows.join("\n");
}

function localMap() {
  const head = play.snakeBody[0];
  const rows: string[] = [];
  for (let dy = -2; dy <= 2; dy += 1) {
    const cells: string[] = [];
    for (let dx = -2; dx <= 2; dx += 1) cells.push(snakeChar(head.x + dx, head.y + dy));
    rows.push(`y${head.y + dy}: ${cells.join(" ")}`);
  }
  return rows.join("\n");
}

function clearAhead(dir: Cell) {
  const blocked = new Set(play.snakeBody.map(cellKey));
  let count = 0;
  let x = play.snakeBody[0].x + dir.x;
  let y = play.snakeBody[0].y + dir.y;
  while (x >= 0 && y >= 0 && x < SNAKE_GRID && y < SNAKE_GRID && !blocked.has(`${x},${y}`)) {
    count += 1;
    x += dir.x;
    y += dir.y;
  }
  return count;
}

function spaceAfter(dir: Cell) {
  const head = play.snakeBody[0];
  const next = { x: head.x + dir.x, y: head.y + dir.y };
  const eats = next.x === play.snakeFood.x && next.y === play.snakeFood.y;
  const body = eats ? [next, ...play.snakeBody] : [next, ...play.snakeBody.slice(0, -1)];
  const blocked = new Set(body.slice(1).map(cellKey));
  const queue = [next];
  const seen = new Set([cellKey(next)]);
  let space = 0;
  while (queue.length > 0) {
    const cell = queue.shift();
    if (!cell) break;
    space += 1;
    for (const step of SNAKE_DIRS) {
      const nx = cell.x + step.dir.x;
      const ny = cell.y + step.dir.y;
      const key = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= SNAKE_GRID || ny >= SNAKE_GRID || seen.has(key) || blocked.has(key)) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return { space, length: body.length, traps: space < body.length };
}

function snakeState(chasing: boolean, avoidedTrap: boolean) {
  const head = play.snakeBody[0];
  const dx = play.snakeFood.x - head.x;
  const dy = play.snakeFood.y - head.y;
  return [
    "贪吃蛇。先吃到果子，同时不要死，也不要走进死路。",
    `棋盘 ${SNAKE_GRID}x${SNAKE_GRID}。x 向右增大，y 向下增大。上方是 y=0。`,
    "H 蛇头，o 蛇身，T 尾巴，* 果子，. 空格，# 棋盘外。头碰到墙、蛇身或尾巴都失败。尾巴这一步不会让开。",
    boardMap(),
    "头周围 5x5：",
    localMap(),
    `头 (${head.x},${head.y}) 朝${dirName(play.snakeDir)}。果子 (${play.snakeFood.x},${play.snakeFood.y})，在${foodSide(dx, dy)}，距离 ${Math.abs(dx) + Math.abs(dy)}。身长 ${play.snakeBody.length}。`,
    `四向到障碍的空格：${SNAKE_DIRS.map((item) => `${item.name}${clearAhead(item.dir)}`).join(" ")}。`,
    "走后可达格少于走后身长，就是困住。",
    avoidedTrap
      ? "有方向会困住，那些没有放进选项。"
      : chasing
        ? "选项都不会立刻死，并且在吃到或靠近果子。"
        : "靠近果子的方向会立刻死。选项都不会立刻死。",
  ].join("\n");
}

type SnakeMove = {
  id: "up" | "down" | "left" | "right";
  dir: Cell;
  dist: number;
  eats: boolean;
  closer: boolean;
  open: number;
  space: number;
  length: number;
  traps: boolean;
};

function candidateMoves(): SnakeMove[] {
  const head = play.snakeBody[0];
  const now = Math.abs(play.snakeFood.x - head.x) + Math.abs(play.snakeFood.y - head.y);
  return SNAKE_DIRS.filter((move) => move.dir.x !== -play.snakeDir.x || move.dir.y !== -play.snakeDir.y)
    .map((move) => {
      const x = head.x + move.dir.x;
      const y = head.y + move.dir.y;
      const wall = x < 0 || y < 0 || x >= SNAKE_GRID || y >= SNAKE_GRID;
      const body = play.snakeBody.some((cell) => cell.x === x && cell.y === y);
      const room = spaceAfter(move.dir);
      const dist = Math.abs(play.snakeFood.x - x) + Math.abs(play.snakeFood.y - y);
      return {
        id: move.id,
        dir: move.dir,
        dist,
        eats: x === play.snakeFood.x && y === play.snakeFood.y,
        closer: dist < now,
        open: clearAhead(move.dir),
        space: room.space,
        length: room.length,
        traps: room.traps,
        blocked: wall || body,
      };
    })
    .filter((move) => !move.blocked)
    .map(({ id, dir, dist, eats, closer, open, space, length, traps }) => ({
      id,
      dir,
      dist,
      eats,
      closer,
      open,
      space,
      length,
      traps,
    }));
}

function movesForDecision() {
  const safe = candidateMoves();
  const open = safe.filter((move) => !move.traps);
  const pool = open.length > 0 ? open : safe;
  const eaters = pool.filter((move) => move.eats);
  const closer = pool.filter((move) => move.closer);
  const moves = eaters.length > 0 ? eaters : closer.length > 0 ? closer : pool;
  return {
    chasing: eaters.length > 0 || closer.length > 0,
    avoidedTrap: open.length > 0 && open.length < safe.length,
    moves,
  };
}

function describeMove(move: SnakeMove) {
  const head = play.snakeBody[0];
  const x = head.x + move.dir.x;
  const y = head.y + move.dir.y;
  const fruit = move.eats ? "这一步吃到果子" : move.closer ? `不吃，距离 ${move.dist}，更近` : `不吃，距离 ${move.dist}，不更近`;
  const room = move.traps
    ? `走后可达 ${move.space}，少于身长 ${move.length}，会困住`
    : `走后可达 ${move.space}，身长 ${move.length}，不会困住`;
  const turn = move.dir.x === play.snakeDir.x && move.dir.y === play.snakeDir.y ? "朝向不变" : "要转向";
  return `${dirName(move.dir)}到 (${x},${y})。不是墙，不是蛇身。${fruit}。前方空 ${move.open} 格。${room}。${turn}。`;
}

export function applyStep(dir: Cell) {
  if (play.snakeOver || play.snakeBody.length === 0) return;
  play.snakeDir = dir;
  play.snakeNext = dir;
  const head = { x: play.snakeBody[0].x + dir.x, y: play.snakeBody[0].y + dir.y };
  const hitWall = head.x < 0 || head.y < 0 || head.x >= SNAKE_GRID || head.y >= SNAKE_GRID;
  const hitSelf = play.snakeBody.some((cell) => cell.x === head.x && cell.y === head.y);
  if (hitWall || hitSelf) {
    play.snakeOver = true;
    play.snakeRunning = false;
    play.snakeSteerNote = hitSelf ? "碰到蛇身，失败" : "撞墙，失败";
    drawSnake();
    syncStartButton();
    return;
  }
  play.snakeBody.unshift(head);
  if (head.x === play.snakeFood.x && head.y === play.snakeFood.y) {
    play.snakeScore += 1;
    placeSnakeFood();
  } else {
    play.snakeBody.pop();
  }
  drawSnake();
}

async function aiTurn(epoch: number) {
  const driver = snakeDriver();
  if (!play.snakeRunning || driver === "manual" || play.snakeOver || epoch !== play.snakeEpoch) return;
  if (play.snakeAiBusy) {
    window.setTimeout(() => void aiTurn(epoch), 200);
    return;
  }
  const plan = movesForDecision();
  const moves = plan.moves;
  if (moves.length === 0) {
    play.snakeOver = true;
    play.snakeRunning = false;
    play.snakeSteerNote = "无路可走";
    drawSnake();
    syncStartButton();
    return;
  }
  if (moves.length === 1) {
    const only = moves[0];
    logSnake(`只有 ${only.id} 可走，直接走 · 距离 ${only.dist} · 可达 ${only.space}`);
    applyStep(only.dir);
    if (!play.snakeOver && epoch === play.snakeEpoch && snakeDriver() !== "manual") queueAiTurn();
    return;
  }
  play.snakeAiBusy = true;
  play.snakeSteerNote = `等待 ${driver === "laya" ? "Laya" : "Jev"}，蛇停住`;
  drawSnake();
  const started = Date.now();
  logSnake(
    `${plan.avoidedTrap ? "绕开死路" : plan.chasing ? "吃果子" : "先保命再吃"} · ${moves.map((move) => `${move.id}:${move.dist}/${move.space}`).join(" ")}`,
  );
  try {
    const decision = await invoke<JevDecision>("jev_choose", {
      provider: driver,
      apiKey: localStorage.getItem(keyStorage(driver))?.trim() || null,
      baseUrl: providerBase(driver),
      state: snakeState(plan.chasing, plan.avoidedTrap),
      options: moves.map((move) => ({ id: move.id, text: describeMove(move) })),
      instructions: plan.chasing ? SNAKE_ASK_FRUIT : SNAKE_ASK_LIVE,
      includeStop: false,
    });
    if (epoch !== play.snakeEpoch || play.snakeOver || $("preview-empty").classList.contains("hidden")) return;
    const picked = moves.find((move) => move.id === decision.choice);
    play.snakeSteerNote = "";
    logSnake(
      `${decision.endpoint ?? (driver === "laya" ? play.layaBase : "Jev")} · ${decision.choice} · 距离 ${picked?.dist ?? "?"} · 置信 ${Math.round(decision.confidence * 100)}% · ${Date.now() - started}ms`,
    );
    applyStep((picked ?? moves.slice().sort((a, b) => a.dist - b.dist)[0]).dir);
  } catch (error) {
    if (epoch !== play.snakeEpoch) return;
    play.snakeSteerNote = `${driver === "laya" ? "Laya" : "Jev"} 决策失败，正在重试`;
    logSnake(`失败 ${error}`, true);
    drawSnake();
    if (snakeDriver() !== "manual") window.setTimeout(() => void aiTurn(epoch), 600);
    return;
  } finally {
    play.snakeAiBusy = false;
  }
  if (!play.snakeOver && epoch === play.snakeEpoch && snakeDriver() !== "manual") queueAiTurn();
}

export function queueAiTurn() {
  if (play.snakeAiBusy || !play.snakeRunning || snakeDriver() === "manual") return;
  const epoch = play.snakeEpoch;
  window.setTimeout(() => void aiTurn(epoch), 30);
}

export async function refreshGameBackends() {
  const localJev = Boolean(localStorage.getItem(JEV_KEY_STORAGE)?.trim());
  const layaBase = providerBase("laya") || "";
  try {
    const status = await invoke<{ jev: boolean; laya: boolean; layaBase?: string | null }>(
      "decision_status",
      { layaBase: layaBase || null },
    );
    play.backends = { jev: localJev || status.jev, laya: status.laya };
    if (status.layaBase) {
      play.layaBase = status.layaBase;
      const saved = localStorage.getItem(LAYA_BASE_STORAGE) ?? "";
      if (!saved || saved.includes(":8000")) {
        localStorage.setItem(LAYA_BASE_STORAGE, status.layaBase);
      }
    }
  } catch {
    play.backends = { jev: localJev, laya: false };
  }
  syncDriverOptions();
  if (idleGame() === "snake") drawSnake();
  else drawDino();
  if (!$("preview-empty").classList.contains("hidden") && idleGame() === "snake" && snakeDriver() !== "manual" && play.snakeTimer != null) {
    startControlLoop();
  }
}

function stepSnake() {
  applyStep(play.snakeNext);
}

export function startControlLoop() {
  play.snakeEpoch += 1;
  if (play.snakeTimer != null) {
    window.clearInterval(play.snakeTimer);
    play.snakeTimer = null;
  }
  if (!play.snakeRunning) {
    play.snakeSteerNote = "点开始";
    drawSnake();
    return;
  }
  if (snakeDriver() === "manual") {
    play.snakeSteerNote = "";
    play.snakeTimer = window.setInterval(stepSnake, SNAKE_SPEED);
    drawSnake();
    return;
  }
  play.snakeSteerNote = `等待 ${snakeDriver() === "laya" ? "Laya" : "Jev"}，蛇停住`;
  drawSnake();
  queueAiTurn();
}
