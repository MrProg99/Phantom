"use strict";

const view = document.getElementById("view");
const ctx = view.getContext("2d");
const minimap = document.getElementById("minimap");
const mapCtx = minimap.getContext("2d");

const stepsEl = document.getElementById("steps");
const timeEl = document.getElementById("time");
const stateEl = document.getElementById("state");
const restartButton = document.getElementById("restart");
const playAgainButton = document.getElementById("play-again");
const winBanner = document.getElementById("win");
const resultMessage = winBanner.querySelector("span");

const FOV = Math.PI / 3;
const TILE_OPEN = " ";
const TILE_WALL = "#";
const TILE_ENTRY = "E";
const TILE_EXIT = "X";
const MONSTER_REPATH_TIME = 0.42;
const MONSTER_WAKE_TIME = 3.2;
const MONSTER_CATCH_DISTANCE = 0.46;

const keys = new Set();
const touchKeys = new Set();
let maze = [];
let entry = { x: 1, y: 1 };
let exit = { x: 15, y: 15 };
let player = { x: 1.5, y: 1.5, angle: 0 };
let monster = null;
let viewport = { width: 1, height: 1, dpr: 1 };
let minimapSize = { width: 130, height: 130 };
let zBuffer = [];
let torches = [];
let steps = 0;
let won = false;
let caught = false;
let startTime = performance.now();
let lastFrame = performance.now();
let audioContext = null;
let audioReady = false;
let heartbeatPreviewed = false;
let heartbeatTimer = 0;

function createMaze(width = 19, height = 19) {
  const grid = Array.from({ length: height }, () => Array(width).fill(TILE_WALL));
  const stack = [{ x: 1, y: 1 }];
  grid[1][1] = TILE_OPEN;

  while (stack.length) {
    const current = stack[stack.length - 1];
    const neighbors = [
      { x: current.x + 2, y: current.y, wallX: current.x + 1, wallY: current.y },
      { x: current.x - 2, y: current.y, wallX: current.x - 1, wallY: current.y },
      { x: current.x, y: current.y + 2, wallX: current.x, wallY: current.y + 1 },
      { x: current.x, y: current.y - 2, wallX: current.x, wallY: current.y - 1 }
    ].filter((next) => (
      next.x > 0 &&
      next.x < width - 1 &&
      next.y > 0 &&
      next.y < height - 1 &&
      grid[next.y][next.x] === TILE_WALL
    ));

    if (!neighbors.length) {
      stack.pop();
      continue;
    }

    const next = neighbors[Math.floor(Math.random() * neighbors.length)];
    grid[next.wallY][next.wallX] = TILE_OPEN;
    grid[next.y][next.x] = TILE_OPEN;
    stack.push({ x: next.x, y: next.y });
  }

  // A few extra openings make the maze feel less like a single corridor.
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      if (grid[y][x] !== TILE_WALL || Math.random() > 0.09) continue;

      const horizontal = grid[y][x - 1] !== TILE_WALL && grid[y][x + 1] !== TILE_WALL;
      const vertical = grid[y - 1][x] !== TILE_WALL && grid[y + 1][x] !== TILE_WALL;
      if (horizontal || vertical) grid[y][x] = TILE_OPEN;
    }
  }

  grid[1][1] = TILE_ENTRY;
  grid[height - 2][width - 2] = TILE_EXIT;
  return grid;
}

function resetGame() {
  maze = createMaze();
  entry = { x: 1, y: 1 };
  exit = { x: maze[0].length - 2, y: maze.length - 2 };
  player = { x: entry.x + 0.5, y: entry.y + 0.5, angle: startAngle() };
  torches = createTorches();
  monster = createMonster();
  keys.clear();
  touchKeys.clear();
  steps = 0;
  won = false;
  caught = false;
  heartbeatTimer = 0;
  startTime = performance.now();
  stepsEl.textContent = "0";
  stateEl.textContent = "Entree";
  resultMessage.textContent = "Sortie atteinte";
  winBanner.classList.remove("danger-banner");
  winBanner.hidden = true;
}

function startAngle() {
  const choices = [
    { x: entry.x + 1, y: entry.y, angle: 0 },
    { x: entry.x, y: entry.y + 1, angle: Math.PI / 2 },
    { x: entry.x - 1, y: entry.y, angle: Math.PI },
    { x: entry.x, y: entry.y - 1, angle: Math.PI * 1.5 }
  ];
  const open = choices.find((choice) => maze[choice.y]?.[choice.x] !== TILE_WALL);
  return open ? open.angle : 0;
}

function createTorches() {
  const candidates = [];
  const faces = [
    { id: 1, dx: 0, dy: -1, offsetX: 0.5, offsetY: 0.08, nx: 0, ny: 1 },
    { id: 2, dx: 0, dy: 1, offsetX: 0.5, offsetY: 0.92, nx: 0, ny: -1 },
    { id: 3, dx: -1, dy: 0, offsetX: 0.08, offsetY: 0.5, nx: 1, ny: 0 },
    { id: 4, dx: 1, dy: 0, offsetX: 0.92, offsetY: 0.5, nx: -1, ny: 0 }
  ];

  for (let y = 1; y < maze.length - 1; y++) {
    for (let x = 1; x < maze[0].length - 1; x++) {
      const tile = maze[y][x];
      const nearEntry = Math.abs(x - entry.x) + Math.abs(y - entry.y) < 3;
      const nearExit = Math.abs(x - exit.x) + Math.abs(y - exit.y) < 3;
      if (tile === TILE_WALL || tile === TILE_ENTRY || tile === TILE_EXIT || nearEntry || nearExit) continue;

      for (const face of faces) {
        if (maze[y + face.dy]?.[x + face.dx] !== TILE_WALL) continue;
        candidates.push({
          x: x + face.offsetX,
          y: y + face.offsetY,
          cellX: x,
          cellY: y,
          nx: face.nx,
          ny: face.ny,
          seed: textureNoise(x, y, face.id, maze.length),
          score: textureNoise(x + 17, y - 11, face.id, maze[0].length)
        });
      }
    }
  }

  const targetCount = Math.min(16, Math.max(8, Math.floor((maze.length * maze[0].length) / 24)));
  const selected = [];
  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    if (selected.length >= targetCount) break;
    const hasSpace = selected.every((torch) => Math.hypot(torch.x - candidate.x, torch.y - candidate.y) > 2.6);
    if (hasSpace) selected.push(candidate);
  }

  return selected;
}

function createMonster() {
  const candidates = [];

  for (let y = 1; y < maze.length - 1; y++) {
    for (let x = 1; x < maze[0].length - 1; x++) {
      if (!isWalkableCell(x, y)) continue;

      const nearEntry = Math.abs(x - entry.x) + Math.abs(y - entry.y) < 8;
      const nearExit = Math.abs(x - exit.x) + Math.abs(y - exit.y) < 4;
      if (nearEntry || nearExit) continue;

      const pathFromEntry = findPath({ x: entry.x, y: entry.y }, { x, y });
      if (!pathFromEntry.length) continue;

      candidates.push({
        x,
        y,
        distance: pathFromEntry.length,
        score: textureNoise(x, y, maze.length, maze[0].length)
      });
    }
  }

  candidates.sort((a, b) => (b.distance - a.distance) || (b.score - a.score));
  const spawn = candidates[0] || fallbackMonsterSpawn();

  return {
    x: spawn.x + 0.5,
    y: spawn.y + 0.5,
    path: [],
    goal: null,
    repath: 0,
    wake: MONSTER_WAKE_TIME
  };
}

function fallbackMonsterSpawn() {
  for (let y = maze.length - 2; y > 0; y--) {
    for (let x = maze[0].length - 2; x > 0; x--) {
      if (isWalkableCell(x, y) && Math.abs(x - entry.x) + Math.abs(y - entry.y) > 4) {
        return { x, y };
      }
    }
  }

  return { x: entry.x, y: entry.y };
}

function resize() {
  viewport.dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewport.width = window.innerWidth;
  viewport.height = window.innerHeight;
  view.width = Math.floor(viewport.width * viewport.dpr);
  view.height = Math.floor(viewport.height * viewport.dpr);
  view.style.width = `${viewport.width}px`;
  view.style.height = `${viewport.height}px`;
  ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);

  const rect = minimap.getBoundingClientRect();
  minimapSize.width = Math.max(1, Math.floor(rect.width));
  minimapSize.height = Math.max(1, Math.floor(rect.height));
  minimap.width = Math.floor(minimapSize.width * viewport.dpr);
  minimap.height = Math.floor(minimapSize.height * viewport.dpr);
  mapCtx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
}

function isWall(x, y) {
  const mapX = Math.floor(x);
  const mapY = Math.floor(y);
  if (mapY < 0 || mapY >= maze.length || mapX < 0 || mapX >= maze[0].length) return true;
  return maze[mapY][mapX] === TILE_WALL;
}

function tileAt(x, y) {
  const mapX = Math.floor(x);
  const mapY = Math.floor(y);
  if (mapY < 0 || mapY >= maze.length || mapX < 0 || mapX >= maze[0].length) return TILE_WALL;
  return maze[mapY][mapX];
}

function isWalkableCell(x, y) {
  return (
    y >= 0 &&
    y < maze.length &&
    x >= 0 &&
    x < maze[0].length &&
    maze[y][x] !== TILE_WALL
  );
}

function findPath(start, goal) {
  const startKey = cellKey(start.x, start.y);
  const goalKey = cellKey(goal.x, goal.y);
  const queue = [{ x: start.x, y: start.y }];
  const parents = new Map([[startKey, null]]);
  const directions = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 }
  ];

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (cellKey(current.x, current.y) === goalKey) break;

    for (const direction of directions) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      const nextKey = cellKey(next.x, next.y);
      if (!isWalkableCell(next.x, next.y) || parents.has(nextKey)) continue;

      parents.set(nextKey, cellKey(current.x, current.y));
      queue.push(next);
    }
  }

  if (!parents.has(goalKey)) return [];

  const path = [];
  let currentKey = goalKey;
  while (currentKey && currentKey !== startKey) {
    const [x, y] = currentKey.split(",").map(Number);
    path.push({ x, y });
    currentKey = parents.get(currentKey);
  }

  return path.reverse();
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function canStandAt(x, y) {
  const radius = 0.19;
  return (
    !isWall(x - radius, y - radius) &&
    !isWall(x + radius, y - radius) &&
    !isWall(x - radius, y + radius) &&
    !isWall(x + radius, y + radius)
  );
}

function movePlayer(dx, dy) {
  const oldTile = `${Math.floor(player.x)},${Math.floor(player.y)}`;

  if (canStandAt(player.x + dx, player.y)) player.x += dx;
  if (canStandAt(player.x, player.y + dy)) player.y += dy;

  const newTile = `${Math.floor(player.x)},${Math.floor(player.y)}`;
  if (newTile !== oldTile) {
    steps += 1;
    stepsEl.textContent = String(steps);
  }
}

function update(dt) {
  const active = (code) => keys.has(code) || touchKeys.has(code);
  const turnSpeed = 2.45;
  const moveSpeed = won ? 1.35 : 2.7;

  if (caught) {
    stateEl.textContent = "Attrape";
    updateHeartbeat(dt);
    return;
  }

  if (active("ArrowLeft")) player.angle -= turnSpeed * dt;
  if (active("ArrowRight")) player.angle += turnSpeed * dt;

  let direction = 0;
  if (active("ArrowUp")) direction += 1;
  if (active("ArrowDown")) direction -= 1;

  if (!won && direction !== 0) {
    const step = moveSpeed * dt * direction;
    movePlayer(Math.cos(player.angle) * step, Math.sin(player.angle) * step);
  }

  player.angle = normalizeAngle(player.angle);
  updateMonster(dt);
  updateHeartbeat(dt);

  if (!won && tileAt(player.x, player.y) === TILE_EXIT) {
    won = true;
    resultMessage.textContent = "Sortie atteinte";
    winBanner.classList.remove("danger-banner");
    stateEl.textContent = "Sortie";
    winBanner.hidden = false;
  } else if (!won) {
    const distance = monsterThreatDistance();
    if (distance < 3.2) stateEl.textContent = "Danger";
    else stateEl.textContent = tileAt(player.x, player.y) === TILE_ENTRY ? "Entree" : "Dedans";
  }
}

function updateMonster(dt) {
  if (!monster || won || caught) return;

  monster.wake = Math.max(0, monster.wake - dt);
  monster.repath -= dt;

  const monsterCell = { x: Math.floor(monster.x), y: Math.floor(monster.y) };
  const playerCell = { x: Math.floor(player.x), y: Math.floor(player.y) };
  const needsPath = (
    monster.repath <= 0 ||
    !monster.goal ||
    monster.goal.x !== playerCell.x ||
    monster.goal.y !== playerCell.y
  );

  if (needsPath) {
    monster.path = findPath(monsterCell, playerCell);
    monster.goal = playerCell;
    monster.repath = MONSTER_REPATH_TIME;
  }

  if (monster.wake > 0) return;

  let remaining = monsterSpeed(monsterDistance()) * dt;
  while (remaining > 0 && monster.path.length) {
    const next = monster.path[0];
    const targetX = next.x + 0.5;
    const targetY = next.y + 0.5;
    const dx = targetX - monster.x;
    const dy = targetY - monster.y;
    const gap = Math.hypot(dx, dy);

    if (gap < 0.035) {
      monster.path.shift();
      continue;
    }

    const step = Math.min(remaining, gap);
    monster.x += dx / gap * step;
    monster.y += dy / gap * step;
    remaining -= step;

    if (step >= gap - 0.001) monster.path.shift();
  }

  if (monsterDistance() <= MONSTER_CATCH_DISTANCE) catchPlayer();
}

function monsterSpeed(distance) {
  const urgency = clamp(1 - (distance - 1.2) / 7, 0, 1);
  return 0.9 + urgency * 0.5;
}

function monsterDistance() {
  if (!monster) return Infinity;
  return Math.hypot(player.x - monster.x, player.y - monster.y);
}

function monsterThreatDistance() {
  if (!monster) return Infinity;
  if (!monster.path.length) return monsterDistance();

  const next = monster.path[0];
  const firstStep = Math.hypot(monster.x - (next.x + 0.5), monster.y - (next.y + 0.5));
  return firstStep + Math.max(0, monster.path.length - 1);
}

function catchPlayer() {
  caught = true;
  keys.clear();
  touchKeys.clear();
  heartbeatTimer = 0;
  resultMessage.textContent = "Attrape";
  winBanner.classList.add("danger-banner");
  stateEl.textContent = "Attrape";
  winBanner.hidden = false;
}

function ensureAudio() {
  const AudioClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioClass) return;

  if (!audioContext) audioContext = new AudioClass();
  const markReady = () => {
    audioReady = true;
    if (!heartbeatPreviewed) {
      heartbeatPreviewed = true;
      playHeartbeat(0.32);
      heartbeatTimer = 0.9;
    }
  };

  if (audioContext.state === "suspended") {
    audioContext.resume().then(markReady).catch(() => {});
  } else {
    markReady();
  }
}

function updateHeartbeat(dt) {
  if (!audioContext || !audioReady || !monster || won || caught) return;
  if (audioContext.state === "suspended") return;

  const distance = monsterThreatDistance();
  const closeness = clamp(1 - (distance - 2) / 15, 0, 1);
  if (closeness <= 0.03) {
    heartbeatTimer = Math.min(heartbeatTimer, 0.35);
    return;
  }

  heartbeatTimer -= dt;
  if (heartbeatTimer > 0) return;

  playHeartbeat(closeness);
  heartbeatTimer = 1.35 - closeness * 1.02;
}

function playHeartbeat(closeness) {
  const now = audioContext.currentTime;
  const spacing = 0.18 - closeness * 0.055;
  playHeartPulse(now, closeness, false);
  playHeartPulse(now + spacing, closeness, true);
}

function playHeartPulse(start, closeness, secondBeat) {
  const oscillator = audioContext.createOscillator();
  const filter = audioContext.createBiquadFilter();
  const gain = audioContext.createGain();
  const baseFrequency = secondBeat ? 116 : 146;
  const peakFrequency = baseFrequency + closeness * 46;
  const volume = (secondBeat ? 0.19 : 0.27) * (0.5 + closeness * 0.95);

  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(peakFrequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(baseFrequency * 0.62, start + 0.15);
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(520 + closeness * 320, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.26);
}

function normalizeAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

function castRay(rayDirX, rayDirY) {
  let mapX = Math.floor(player.x);
  let mapY = Math.floor(player.y);
  const deltaDistX = rayDirX === 0 ? 1e30 : Math.abs(1 / rayDirX);
  const deltaDistY = rayDirY === 0 ? 1e30 : Math.abs(1 / rayDirY);
  let stepX = 0;
  let stepY = 0;
  let sideDistX = 0;
  let sideDistY = 0;
  let side = 0;

  if (rayDirX < 0) {
    stepX = -1;
    sideDistX = (player.x - mapX) * deltaDistX;
  } else {
    stepX = 1;
    sideDistX = (mapX + 1 - player.x) * deltaDistX;
  }

  if (rayDirY < 0) {
    stepY = -1;
    sideDistY = (player.y - mapY) * deltaDistY;
  } else {
    stepY = 1;
    sideDistY = (mapY + 1 - player.y) * deltaDistY;
  }

  for (let i = 0; i < 96; i++) {
    if (sideDistX < sideDistY) {
      sideDistX += deltaDistX;
      mapX += stepX;
      side = 0;
    } else {
      sideDistY += deltaDistY;
      mapY += stepY;
      side = 1;
    }

    if (mapY < 0 || mapY >= maze.length || mapX < 0 || mapX >= maze[0].length) {
      break;
    }

    if (maze[mapY][mapX] === TILE_WALL) {
      const distance = side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY;
      const hit = side === 0
        ? player.y + distance * rayDirY
        : player.x + distance * rayDirX;

      return {
        distance: Math.max(distance, 0.0001),
        mapX,
        mapY,
        side,
        wallX: hit - Math.floor(hit)
      };
    }
  }

  return { distance: 32, mapX: 0, mapY: 0, side: 0, wallX: 0.5 };
}

function render(now) {
  const w = viewport.width;
  const h = viewport.height;
  drawWorldBackground(w, h);

  const dirX = Math.cos(player.angle);
  const dirY = Math.sin(player.angle);
  const planeLength = Math.tan(FOV / 2);
  const planeX = -dirY * planeLength;
  const planeY = dirX * planeLength;
  const columnWidth = Math.max(1, Math.floor(w / 380));
  zBuffer = new Array(w);

  for (let x = 0; x < w; x += columnWidth) {
    const cameraX = 2 * x / w - 1;
    const rayDirX = dirX + planeX * cameraX;
    const rayDirY = dirY + planeY * cameraX;
    const hit = castRay(rayDirX, rayDirY);
    const distance = hit.distance;
    const lineHeight = Math.min(h * 2, h / distance);
    const drawStart = Math.max(0, Math.floor((h - lineHeight) / 2));
    const drawEnd = Math.min(h, Math.floor((h + lineHeight) / 2));

    ctx.fillStyle = wallColor(hit, distance);
    ctx.fillRect(x, drawStart, columnWidth + 1, drawEnd - drawStart);

    drawWallTexture(x, drawStart, drawEnd, columnWidth, hit, distance);

    for (let fill = x; fill < x + columnWidth + 1 && fill < w; fill++) {
      zBuffer[fill] = distance;
    }
  }

  drawTorches(w, h, dirX, dirY, planeX, planeY, now);
  drawMonster(w, h, dirX, dirY, planeX, planeY, now);
  drawSprites(w, h, dirX, dirY, planeX, planeY);
  drawVignette(w, h);
  drawMinimap();
}

function drawWorldBackground(w, h) {
  const ceiling = ctx.createLinearGradient(0, 0, 0, h * 0.52);
  ceiling.addColorStop(0, "#1f3c52");
  ceiling.addColorStop(1, "#708494");
  ctx.fillStyle = ceiling;
  ctx.fillRect(0, 0, w, h / 2);

  const floor = ctx.createLinearGradient(0, h / 2, 0, h);
  floor.addColorStop(0, "#796247");
  floor.addColorStop(1, "#2d251e");
  ctx.fillStyle = floor;
  ctx.fillRect(0, h / 2, w, h / 2);

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 245, 220, 0.13)";
  for (let i = -10; i <= 10; i++) {
    const x = w / 2 + i * w * 0.085;
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(20, 15, 12, 0.24)";
  for (let y = h / 2 + 18; y < h; y += Math.max(9, (y - h / 2) * 0.18)) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(230, 246, 255, 0.08)";
  for (let y = 18; y < h / 2; y += 30) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y + 18);
    ctx.stroke();
  }
  ctx.restore();
}

function wallColor(hit, distance) {
  const edge = hit.wallX < 0.08 || hit.wallX > 0.92 ? 0.82 : 1;
  const side = hit.side === 1 ? 0.76 : 1;
  const light = Math.max(0.34, 1 - distance * 0.062) * edge * side;
  const r = Math.floor(166 * light);
  const g = Math.floor(136 * light);
  const b = Math.floor(97 * light);
  return `rgb(${r}, ${g}, ${b})`;
}

function drawWallTexture(x, start, end, width, hit, distance) {
  const height = end - start;
  if (height <= 0) return;

  const visibility = Math.max(0.12, 1 - distance * 0.075);
  const rows = 7;
  const columns = 4;
  const mortar = Math.max(1, Math.min(2.2, height * 0.01));
  const mortarAlpha = Math.max(0.1, 0.36 - distance * 0.023);

  ctx.save();
  for (let row = 0; row < rows; row++) {
    const rowStart = start + height * row / rows;
    const rowEnd = start + height * (row + 1) / rows;
    const rowHeight = rowEnd - rowStart;
    const offset = row % 2 === 0 ? 0 : 0.5;
    const brickIndex = Math.floor(hit.wallX * columns + offset);
    const brickNoise = textureNoise(hit.mapX, hit.mapY, row, brickIndex);
    const faceAlpha = (0.035 + brickNoise * 0.09) * visibility;

    ctx.fillStyle = brickNoise > 0.52
      ? `rgba(255, 220, 157, ${faceAlpha})`
      : `rgba(39, 27, 17, ${faceAlpha * 1.15})`;
    ctx.fillRect(x, rowStart + mortar, width + 1, Math.max(0, rowHeight - mortar * 2));

    const seam = positiveMod(hit.wallX * columns + offset, 1);
    if (seam < 0.045 || seam > 0.955) {
      ctx.fillStyle = `rgba(23, 16, 10, ${mortarAlpha})`;
      ctx.fillRect(x, rowStart, width + 1, rowHeight);
    }

    const chip = textureNoise(hit.mapX + 13, hit.mapY - 7, row, brickIndex);
    if (chip > 0.9) {
      const chipY = rowStart + rowHeight * (0.18 + textureNoise(row, brickIndex, hit.mapX, hit.mapY) * 0.58);
      ctx.fillStyle = `rgba(255, 239, 198, ${0.08 * visibility})`;
      ctx.fillRect(x, chipY, width + 1, Math.max(1, mortar));
    }
  }

  ctx.fillStyle = `rgba(24, 16, 10, ${mortarAlpha})`;
  for (let row = 1; row < rows; row++) {
    const y = start + height * row / rows;
    ctx.fillRect(x, y - mortar * 0.5, width + 1, mortar);
  }

  const edgeAlpha = Math.max(0.08, 0.28 - distance * 0.018);
  if (hit.wallX < 0.045 || hit.wallX > 0.955) {
    ctx.fillStyle = `rgba(255, 239, 190, ${edgeAlpha})`;
    ctx.fillRect(x, start, width + 1, height);
  }

  ctx.restore();
}

function textureNoise(a, b, c, d) {
  let n = (a * 374761393 + b * 668265263 + c * 2246822519 + d * 3266489917) >>> 0;
  n = Math.imul(n ^ (n >>> 15), 2246822519) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 3266489917) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function positiveMod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function drawTorches(w, h, dirX, dirY, planeX, planeY, now) {
  const visibleTorches = torches
    .map((torch) => {
      const dx = torch.x - player.x;
      const dy = torch.y - player.y;
      return { torch, distanceSq: dx * dx + dy * dy };
    })
    .sort((a, b) => b.distanceSq - a.distanceSq);

  for (const item of visibleTorches) {
    const torch = item.torch;
    const dx = torch.x - player.x;
    const dy = torch.y - player.y;
    const distance = Math.sqrt(item.distanceSq);
    const normalView = ((player.x - torch.x) * torch.nx + (player.y - torch.y) * torch.ny) / Math.max(0.001, distance);
    if (normalView < -0.08) continue;

    const projection = projectPoint(dx, dy, dirX, dirY, planeX, planeY, w);
    if (!projection || projection.depth <= 0.08) continue;

    const screenX = projection.screenX;
    if (screenX < -80 || screenX > w + 80) continue;
    if (projection.depth >= (zBuffer[Math.max(0, Math.min(w - 1, screenX))] || Infinity) + 0.12) continue;

    const torchHeight = Math.max(18, Math.min(h * 0.58, h / projection.depth * 0.32));
    const torchWidth = torchHeight * 0.34;
    const top = h / 2 - torchHeight * 0.76;
    const flameY = top + torchHeight * 0.2;
    const bracketY = top + torchHeight * 0.52;
    const alpha = Math.max(0.22, Math.min(1, 1.2 - projection.depth * 0.075)) * Math.max(0.18, normalView);
    const pulse = 0.92 + Math.sin(now * 0.008 + torch.seed * 17) * 0.08 + Math.sin(now * 0.021 + torch.seed * 31) * 0.045;

    drawTorchHalo(screenX, flameY, torchHeight, pulse, alpha);
    drawTorchBody(screenX, bracketY, torchWidth, torchHeight, alpha);
    drawTorchFlame(screenX, flameY, torchHeight * 0.16, pulse, alpha);
  }
}

function projectPoint(dx, dy, dirX, dirY, planeX, planeY, screenW) {
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  const transformX = invDet * (dirY * dx - dirX * dy);
  const transformY = invDet * (-planeY * dx + planeX * dy);
  if (transformY <= 0) return null;
  return {
    screenX: Math.floor((screenW / 2) * (1 + transformX / transformY)),
    depth: transformY
  };
}

function drawTorchHalo(x, y, height, pulse, alpha) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const radius = height * (0.62 + pulse * 0.08);
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
  glow.addColorStop(0, `rgba(255, 219, 128, ${0.22 * alpha})`);
  glow.addColorStop(0.22, `rgba(255, 135, 54, ${0.13 * alpha})`);
  glow.addColorStop(1, "rgba(255, 95, 31, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}

function drawTorchBody(x, y, width, height, alpha) {
  const stem = Math.max(2, width * 0.13);
  const plateW = Math.max(8, width * 0.78);
  const plateH = Math.max(6, height * 0.08);
  const tipY = y - height * 0.28;
  const baseY = y + height * 0.18;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineWidth = stem;
  ctx.strokeStyle = "#21150d";
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x, tipY);
  ctx.stroke();

  ctx.lineWidth = Math.max(2, stem * 0.72);
  ctx.strokeStyle = "#6b4629";
  ctx.beginPath();
  ctx.moveTo(x - width * 0.28, y - height * 0.02);
  ctx.lineTo(x + width * 0.28, y - height * 0.02);
  ctx.stroke();

  ctx.fillStyle = "#1a100a";
  ctx.beginPath();
  ctx.ellipse(x, y + height * 0.02, plateW * 0.5, plateH, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 210, 125, 0.18)";
  ctx.beginPath();
  ctx.ellipse(x - plateW * 0.12, y - plateH * 0.2, plateW * 0.24, plateH * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTorchFlame(x, y, size, pulse, alpha) {
  const outer = size * pulse;
  const inner = outer * 0.58;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "#ff9c35";
  ctx.shadowBlur = outer * 0.9;
  drawFlameShape(x, y, outer, "#ff7a24");

  ctx.shadowBlur = outer * 0.35;
  drawFlameShape(x, y + outer * 0.08, inner, "#ffe08a");
  ctx.restore();
}

function drawFlameShape(x, y, size, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.quadraticCurveTo(x + size * 0.62, y - size * 0.18, x + size * 0.28, y + size * 0.5);
  ctx.quadraticCurveTo(x, y + size * 0.78, x - size * 0.28, y + size * 0.5);
  ctx.quadraticCurveTo(x - size * 0.62, y - size * 0.18, x, y - size);
  ctx.fill();
}

function drawMonster(w, h, dirX, dirY, planeX, planeY, now) {
  if (!monster || won) return;

  const dx = monster.x - player.x;
  const dy = monster.y - player.y;
  const projection = projectPoint(dx, dy, dirX, dirY, planeX, planeY, w);
  if (!projection || projection.depth <= 0.08) return;

  const screenX = projection.screenX;
  if (screenX < -120 || screenX > w + 120) return;
  if (projection.depth >= (zBuffer[Math.max(0, Math.min(w - 1, screenX))] || Infinity) + 0.08) return;

  const spriteHeight = Math.max(30, Math.min(h * 0.84, h / projection.depth * 0.62));
  const spriteWidth = spriteHeight * 0.42;
  const top = h / 2 - spriteHeight * 0.54;
  const bottom = h / 2 + spriteHeight * 0.46;
  const alpha = clamp(1.25 - projection.depth * 0.065, 0.18, 1);
  const pulse = 0.92 + Math.sin(now * 0.007) * 0.08;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "lighter";
  const aura = ctx.createRadialGradient(screenX, top + spriteHeight * 0.34, 0, screenX, top + spriteHeight * 0.34, spriteHeight * 0.62);
  aura.addColorStop(0, "rgba(172, 20, 34, 0.22)");
  aura.addColorStop(0.34, "rgba(98, 5, 20, 0.12)");
  aura.addColorStop(1, "rgba(98, 5, 20, 0)");
  ctx.fillStyle = aura;
  ctx.fillRect(screenX - spriteHeight, top - spriteHeight * 0.2, spriteHeight * 2, spriteHeight * 1.4);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
  ctx.shadowBlur = spriteHeight * 0.08;

  ctx.fillStyle = "#09080a";
  ctx.beginPath();
  ctx.ellipse(screenX, top + spriteHeight * 0.52, spriteWidth * 0.55, spriteHeight * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(screenX, top + spriteHeight * 0.04);
  ctx.quadraticCurveTo(screenX + spriteWidth * 0.58, top + spriteHeight * 0.18, screenX + spriteWidth * 0.43, bottom);
  ctx.quadraticCurveTo(screenX, bottom + spriteHeight * 0.05, screenX - spriteWidth * 0.43, bottom);
  ctx.quadraticCurveTo(screenX - spriteWidth * 0.58, top + spriteHeight * 0.18, screenX, top + spriteHeight * 0.04);
  ctx.fill();

  ctx.fillStyle = "#111113";
  ctx.beginPath();
  ctx.ellipse(screenX, top + spriteHeight * 0.22, spriteWidth * 0.36, spriteHeight * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();

  const eyeY = top + spriteHeight * 0.22;
  const eyeGap = spriteWidth * 0.18;
  const eyeW = Math.max(2.2, spriteWidth * 0.07 * pulse);
  ctx.shadowColor = "#ff3030";
  ctx.shadowBlur = spriteHeight * 0.045;
  ctx.fillStyle = "#ff4343";
  ctx.beginPath();
  ctx.ellipse(screenX - eyeGap, eyeY, eyeW, eyeW * 0.52, 0, 0, Math.PI * 2);
  ctx.ellipse(screenX + eyeGap, eyeY, eyeW, eyeW * 0.52, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = `rgba(255, 70, 70, ${0.18 + pulse * 0.1})`;
  ctx.lineWidth = Math.max(1, spriteWidth * 0.025);
  ctx.beginPath();
  ctx.moveTo(screenX - spriteWidth * 0.26, top + spriteHeight * 0.43);
  ctx.quadraticCurveTo(screenX, top + spriteHeight * 0.5, screenX + spriteWidth * 0.26, top + spriteHeight * 0.43);
  ctx.stroke();
  ctx.restore();
}

function drawSprites(w, h, dirX, dirY, planeX, planeY) {
  const sprites = [
    { x: entry.x + 0.5, y: entry.y + 0.5, label: "ENTREE", color: "#73b8ff", core: "#d8edff" },
    { x: exit.x + 0.5, y: exit.y + 0.5, label: "SORTIE", color: "#77e5ae", core: "#efffde" }
  ].sort((a, b) => {
    const da = (player.x - a.x) ** 2 + (player.y - a.y) ** 2;
    const db = (player.x - b.x) ** 2 + (player.y - b.y) ** 2;
    return db - da;
  });

  for (const sprite of sprites) {
    const dx = sprite.x - player.x;
    const dy = sprite.y - player.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.38) continue;

    const invDet = 1 / (planeX * dirY - dirX * planeY);
    const transformX = invDet * (dirY * dx - dirX * dy);
    const transformY = invDet * (-planeY * dx + planeX * dy);
    if (transformY <= 0.05) continue;

    const screenX = Math.floor((w / 2) * (1 + transformX / transformY));
    const spriteHeight = Math.abs(Math.floor(h / transformY * 0.78));
    const spriteWidth = Math.floor(spriteHeight * 0.52);
    const drawStartY = Math.max(0, Math.floor(h / 2 - spriteHeight / 2));
    const drawEndY = Math.min(h, Math.floor(h / 2 + spriteHeight / 2));
    const drawStartX = Math.max(0, Math.floor(screenX - spriteWidth / 2));
    const drawEndX = Math.min(w, Math.floor(screenX + spriteWidth / 2));

    for (let stripe = drawStartX; stripe < drawEndX; stripe++) {
      if (transformY >= (zBuffer[stripe] || Infinity)) continue;
      const u = (stripe - (screenX - spriteWidth / 2)) / spriteWidth;
      const edgeFade = Math.min(u, 1 - u) * 2;
      const alpha = Math.max(0, Math.min(1, edgeFade));
      if (alpha <= 0) continue;

      const gradient = ctx.createLinearGradient(stripe, drawStartY, stripe, drawEndY);
      gradient.addColorStop(0, withAlpha(sprite.color, 0));
      gradient.addColorStop(0.16, withAlpha(sprite.color, 0.42 * alpha));
      gradient.addColorStop(0.5, withAlpha(sprite.core, 0.92 * alpha));
      gradient.addColorStop(0.84, withAlpha(sprite.color, 0.42 * alpha));
      gradient.addColorStop(1, withAlpha(sprite.color, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(stripe, drawStartY, 1, drawEndY - drawStartY);
    }

    if (screenX > -spriteWidth && screenX < w + spriteWidth && transformY < (zBuffer[screenX] || Infinity)) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, 1.4 - transformY * 0.08));
      ctx.font = `700 ${Math.max(10, Math.min(18, spriteHeight * 0.08))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = sprite.core;
      ctx.shadowColor = sprite.color;
      ctx.shadowBlur = 12;
      ctx.fillText(sprite.label, screenX, Math.max(30, drawStartY - 12));
      ctx.restore();
    }
  }
}

function withAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawVignette(w, h) {
  const gradient = ctx.createRadialGradient(w / 2, h / 2, h * 0.22, w / 2, h / 2, h * 0.78);
  gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0.36)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

function drawMinimap() {
  const w = minimapSize.width;
  const h = minimapSize.height;
  const cols = maze[0].length;
  const rows = maze.length;
  const cell = Math.floor(Math.min(w / cols, h / rows));
  const mapW = cell * cols;
  const mapH = cell * rows;
  const ox = Math.floor((w - mapW) / 2);
  const oy = Math.floor((h - mapH) / 2);

  mapCtx.clearRect(0, 0, w, h);
  mapCtx.fillStyle = "#101820";
  mapCtx.fillRect(0, 0, w, h);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const tile = maze[y][x];
      if (tile === TILE_WALL) mapCtx.fillStyle = "#a7835d";
      else if (tile === TILE_ENTRY) mapCtx.fillStyle = "#578cc8";
      else if (tile === TILE_EXIT) mapCtx.fillStyle = "#62d593";
      else mapCtx.fillStyle = "#25313a";
      mapCtx.fillRect(ox + x * cell, oy + y * cell, cell - 1, cell - 1);
    }
  }

  mapCtx.fillStyle = "#ffb45f";
  for (const torch of torches) {
    mapCtx.beginPath();
    mapCtx.arc(ox + torch.x * cell, oy + torch.y * cell, Math.max(1.4, cell * 0.22), 0, Math.PI * 2);
    mapCtx.fill();
  }

  if (monster && !won) {
    mapCtx.fillStyle = "#d82e3d";
    mapCtx.beginPath();
    mapCtx.arc(ox + monster.x * cell, oy + monster.y * cell, Math.max(2.2, cell * 0.34), 0, Math.PI * 2);
    mapCtx.fill();
  }

  const px = ox + player.x * cell;
  const py = oy + player.y * cell;
  mapCtx.save();
  mapCtx.translate(px, py);
  mapCtx.rotate(player.angle);
  mapCtx.fillStyle = "#fff2bb";
  mapCtx.beginPath();
  mapCtx.moveTo(cell * 0.55, 0);
  mapCtx.lineTo(-cell * 0.35, -cell * 0.28);
  mapCtx.lineTo(-cell * 0.2, 0);
  mapCtx.lineTo(-cell * 0.35, cell * 0.28);
  mapCtx.closePath();
  mapCtx.fill();
  mapCtx.restore();
}

function updateClock(now) {
  const elapsed = Math.floor((now - startTime) / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  timeEl.textContent = `${minutes}:${seconds}`;
}

function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  update(dt);
  updateClock(now);
  render(now);
  requestAnimationFrame(loop);
}

function setTouchKey(code, active) {
  if (active) touchKeys.add(code);
  else touchKeys.delete(code);
}

window.addEventListener("resize", resize);
window.addEventListener("pointerdown", ensureAudio, { once: true });
window.addEventListener("click", ensureAudio, { once: true });

window.addEventListener("keydown", (event) => {
  ensureAudio();
  if (!event.code.startsWith("Arrow")) return;
  event.preventDefault();
  keys.add(event.code);
});

window.addEventListener("keyup", (event) => {
  if (!event.code.startsWith("Arrow")) return;
  event.preventDefault();
  keys.delete(event.code);
});

document.querySelectorAll("[data-key]").forEach((button) => {
  const code = button.dataset.key;
  button.addEventListener("pointerdown", (event) => {
    ensureAudio();
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    setTouchKey(code, true);
  });
  button.addEventListener("pointerup", () => setTouchKey(code, false));
  button.addEventListener("pointercancel", () => setTouchKey(code, false));
  button.addEventListener("lostpointercapture", () => setTouchKey(code, false));
});

restartButton.addEventListener("click", () => {
  ensureAudio();
  resetGame();
});
playAgainButton.addEventListener("click", () => {
  ensureAudio();
  resetGame();
});

resetGame();
resize();
requestAnimationFrame((now) => {
  lastFrame = now;
  requestAnimationFrame(loop);
});
