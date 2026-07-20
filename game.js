"use strict";

const view = document.getElementById("view");
const ctx = view.getContext("2d");
const minimap = document.getElementById("minimap");
const mapCtx = minimap.getContext("2d");
const ceilingBuffer = document.createElement("canvas");
const ceilingBufferCtx = ceilingBuffer.getContext("2d");

const stepsEl = document.getElementById("steps");
const timeEl = document.getElementById("time");
const levelStatusEl = document.getElementById("level-state");
const keyStatusEl = document.getElementById("key-state");
const compassPanelEl = document.getElementById("compass-panel");
const directionStatusEl = document.getElementById("direction-state");
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
const TILE_TELEPORTER = "T";
const MONSTER_REPATH_TIME = 0.42;
const MONSTER_WAKE_TIME = 3.2;
const MONSTER_CATCH_DISTANCE = 0.46;
const MONSTER_CELL_CATCH_DISTANCE = 0.82;
const MONSTER_CATCH_VIEW_DISTANCE = 0.44;
const TELEPORT_COOLDOWN = 0.72;
const MAP_REVEAL_DURATION = 5;
const MAP_ORB_PICKUP_DISTANCE = 0.5;
const MAP_ORB_COUNT = 2;
const KEY_PICKUP_DISTANCE = 0.52;
const COMPASS_PICKUP_DISTANCE = 0.52;
const PLAYER_COLLISION_RADIUS = 0.19;
const MIN_WALL_RENDER_DISTANCE = 0.58;
const WALL_FRAME_COUNT = 7;
const WALL_FRAME_IMAGE_SRC = "images/cadre1.jpg";
const FINAL_LEVEL = 2;
const PLAYER_STATE_BROADCAST_INTERVAL = 1000 / 15;

const keys = new Set();
const touchKeys = new Set();
let maze = [];
let entry = { x: 1, y: 1 };
let exit = { x: 15, y: 15 };
let player = { x: 1.5, y: 1.5, angle: 0 };
let currentLevel = 1;
let monster = null;
let viewport = { width: 1, height: 1, dpr: 1 };
let minimapSize = { width: 130, height: 130 };
let zBuffer = [];
let torches = [];
let wallFrames = [];
let teleporters = [];
let mapOrbs = [];
let mazeKey = null;
let mazeCompass = null;
let hasKey = false;
let hasCompass = false;
let mapRevealTimer = 0;
let steps = 0;
let won = false;
let caught = false;
let startTime = performance.now();
let lastFrame = performance.now();
let audioContext = null;
let audioReady = false;
let heartbeatPreviewed = false;
let heartbeatTimer = 0;
let teleportCooldown = 0;
let activeWorldSeed = createGameSeed();
let worldRandomState = 1;
let multiplayerRoomCode = "";
let multiplayerLocalPlayerId = "";
let multiplayerHostId = "";
let multiplayerRole = "solo";
let remotePlayer = null;
let remotePlayerTarget = null;
let lastPlayerStateBroadcast = 0;
let lastPlayerStateKey = "";
let wallFrameImageReady = false;
const wallFrameImage = new Image();
wallFrameImage.onload = () => {
  wallFrameImageReady = true;
};
wallFrameImage.src = WALL_FRAME_IMAGE_SRC;

function createGameSeed() {
  if (window.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    window.crypto.getRandomValues(values);
    return values[0] || 1;
  }
  return Math.floor(Math.random() * 4294967295) || 1;
}

function resetWorldRandom(level) {
  worldRandomState = (activeWorldSeed ^ Math.imul(level, 0x9e3779b9)) >>> 0;
  if (!worldRandomState) worldRandomState = 0x6d2b79f5;
}

function worldRandom() {
  worldRandomState = (worldRandomState + 0x6d2b79f5) >>> 0;
  let value = worldRandomState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

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

    const next = neighbors[Math.floor(worldRandom() * neighbors.length)];
    grid[next.wallY][next.wallX] = TILE_OPEN;
    grid[next.y][next.x] = TILE_OPEN;
    stack.push({ x: next.x, y: next.y });
  }

  // A few extra openings make the maze feel less like a single corridor.
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      if (grid[y][x] !== TILE_WALL || worldRandom() > 0.09) continue;

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
  if (!multiplayerRoomCode) activeWorldSeed = createGameSeed();
  startLevel(1);
}

function startLevel(level) {
  currentLevel = level;
  resetWorldRandom(level);
  const size = level >= 2 ? 21 : 19;
  maze = createMaze(size, size);
  entry = { x: 1, y: 1 };
  exit = { x: maze[0].length - 2, y: maze.length - 2 };
  player = { x: entry.x + 0.5, y: entry.y + 0.5, angle: startAngle() };
  teleporters = createTeleporters();
  torches = createTorches();
  wallFrames = createWallFrames();
  monster = createMonster();
  mazeKey = createMazeKey();
  mazeCompass = createMazeCompass();
  hasKey = false;
  hasCompass = false;
  mapRevealTimer = 0;
  mapOrbs = createMapOrbs();
  applyMultiplayerSpawnOffset();
  keys.clear();
  touchKeys.clear();
  steps = 0;
  won = false;
  caught = false;
  heartbeatTimer = 0;
  teleportCooldown = 0;
  startTime = performance.now();
  stepsEl.textContent = "0";
  if (levelStatusEl) levelStatusEl.textContent = String(currentLevel);
  if (keyStatusEl) keyStatusEl.textContent = "Non";
  if (directionStatusEl) directionStatusEl.textContent = "--";
  if (compassPanelEl) compassPanelEl.hidden = true;
  stateEl.textContent = currentLevel >= 2 ? "Niveau 2" : "Entree";
  resultMessage.textContent = currentLevel >= FINAL_LEVEL ? "Sortie finale atteinte" : "Sortie atteinte";
  winBanner.classList.remove("danger-banner");
  winBanner.hidden = true;
}

function applyMultiplayerSpawnOffset() {
  if (!multiplayerRoomCode || multiplayerRole === "solo") return;

  const side = multiplayerRole === "host" ? -1 : 1;
  const offset = 0.14 * side;
  const shiftedX = player.x - Math.sin(player.angle) * offset;
  const shiftedY = player.y + Math.cos(player.angle) * offset;
  if (canStandAt(shiftedX, shiftedY)) {
    player.x = shiftedX;
    player.y = shiftedY;
  }
}

function applyMultiplayerRoomState(roomState) {
  const seed = Number(roomState?.seed) >>> 0;
  const code = roomState?.code || "";
  const localPlayerId = roomState?.localPlayerId || "";
  if (!code || !localPlayerId || !seed) return;

  const nextRole = roomState.hostId === localPlayerId ? "host" : "guest";
  const sessionChanged = (
    multiplayerRoomCode !== code ||
    multiplayerLocalPlayerId !== localPlayerId ||
    activeWorldSeed !== seed
  );

  multiplayerRoomCode = code;
  multiplayerLocalPlayerId = localPlayerId;
  multiplayerHostId = roomState.hostId || "";
  multiplayerRole = nextRole;

  if (sessionChanged) {
    activeWorldSeed = seed;
    remotePlayer = null;
    remotePlayerTarget = null;
    lastPlayerStateBroadcast = 0;
    lastPlayerStateKey = "";
    startLevel(1);
  }

  const remoteData = Object.values(roomState.players || {}).find((playerData) => (
    playerData?.uid && playerData.uid !== localPlayerId
  ));
  const state = remoteData?.state;
  const validState = (
    Number.isFinite(state?.x) &&
    Number.isFinite(state?.y) &&
    Number.isFinite(state?.angle) &&
    Number.isInteger(state?.level)
  );

  if (!validState || state.level !== currentLevel) {
    remotePlayer = null;
    remotePlayerTarget = null;
    return;
  }

  remotePlayerTarget = {
    uid: remoteData.uid,
    name: remoteData.name || "Partenaire",
    x: state.x,
    y: state.y,
    angle: normalizeAngle(state.angle),
    level: state.level,
    caught: Boolean(state.caught)
  };

  if (!remotePlayer) remotePlayer = { ...remotePlayerTarget };
}

function leaveMultiplayerSession() {
  if (!multiplayerRoomCode) return;

  multiplayerRoomCode = "";
  multiplayerLocalPlayerId = "";
  multiplayerHostId = "";
  multiplayerRole = "solo";
  remotePlayer = null;
  remotePlayerTarget = null;
  lastPlayerStateBroadcast = 0;
  lastPlayerStateKey = "";
  activeWorldSeed = createGameSeed();
  startLevel(1);
}

function updateRemotePlayer(dt) {
  if (!remotePlayer || !remotePlayerTarget) return;

  const gap = Math.hypot(
    remotePlayerTarget.x - remotePlayer.x,
    remotePlayerTarget.y - remotePlayer.y
  );
  if (gap > 1.8) {
    remotePlayer.x = remotePlayerTarget.x;
    remotePlayer.y = remotePlayerTarget.y;
  } else {
    const blend = 1 - Math.exp(-dt * 12);
    remotePlayer.x += (remotePlayerTarget.x - remotePlayer.x) * blend;
    remotePlayer.y += (remotePlayerTarget.y - remotePlayer.y) * blend;
  }

  const angleDelta = normalizeAngle(remotePlayerTarget.angle - remotePlayer.angle + Math.PI) - Math.PI;
  remotePlayer.angle = normalizeAngle(remotePlayer.angle + angleDelta * (1 - Math.exp(-dt * 14)));
  remotePlayer.name = remotePlayerTarget.name;
  remotePlayer.caught = remotePlayerTarget.caught;
}

function broadcastLocalPlayerState(now) {
  if (!multiplayerRoomCode) return;

  const x = Math.round(player.x * 10000) / 10000;
  const y = Math.round(player.y * 10000) / 10000;
  const angle = Math.round(player.angle * 10000) / 10000;
  const stateKey = `${x}|${y}|${angle}|${currentLevel}|${caught}|${won}`;
  const unchanged = stateKey === lastPlayerStateKey;
  const elapsed = now - lastPlayerStateBroadcast;
  if (elapsed < PLAYER_STATE_BROADCAST_INTERVAL || (unchanged && elapsed < 1000)) return;

  lastPlayerStateBroadcast = now;
  lastPlayerStateKey = stateKey;
  window.dispatchEvent(new CustomEvent("laby:local-player-state", {
    detail: {
      roomCode: multiplayerRoomCode,
      x,
      y,
      angle,
      level: currentLevel,
      caught,
      won
    }
  }));
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

function createTeleporters() {
  const candidates = [];
  const usedWalls = new Set();
  const faces = [
    { id: 1, dx: 0, dy: -1, nx: 0, ny: 1 },
    { id: 2, dx: 0, dy: 1, nx: 0, ny: -1 },
    { id: 3, dx: -1, dy: 0, nx: 1, ny: 0 },
    { id: 4, dx: 1, dy: 0, nx: -1, ny: 0 }
  ];

  for (let y = 1; y < maze.length - 1; y++) {
    for (let x = 1; x < maze[0].length - 1; x++) {
      if (!isWalkableCell(x, y)) continue;
      if (x === entry.x && y === entry.y) continue;
      if (x === exit.x && y === exit.y) continue;
      if (Math.abs(x - entry.x) + Math.abs(y - entry.y) < 5) continue;
      if (Math.abs(x - exit.x) + Math.abs(y - exit.y) < 4) continue;

      for (const face of faces) {
        const wallX = x + face.dx;
        const wallY = y + face.dy;
        if (wallX <= 0 || wallY <= 0 || wallX >= maze[0].length - 1 || wallY >= maze.length - 1) continue;
        if (maze[wallY]?.[wallX] !== TILE_WALL) continue;

        const wallKey = cellKey(wallX, wallY);
        if (usedWalls.has(wallKey)) continue;
        usedWalls.add(wallKey);

        const pathFromEntry = findPath({ x: entry.x, y: entry.y }, { x, y });
        if (pathFromEntry.length < 5) continue;

        candidates.push({
          wallX,
          wallY,
          cellX: x,
          cellY: y,
          nx: face.nx,
          ny: face.ny,
          score: textureNoise(wallX + 19, wallY - 31, face.id, maze.length),
          pathLength: pathFromEntry.length
        });
      }
    }
  }

  candidates.sort((a, b) => (b.score - a.score) || (b.pathLength - a.pathLength));
  if (candidates.length < 2) return [];

  const first = candidates[0];
  const minimumGap = maze.length * 0.55;
  const second = candidates.find((candidate) => (
    candidate !== first &&
    Math.hypot(candidate.cellX - first.cellX, candidate.cellY - first.cellY) >= minimumGap
  )) || candidates[1];

  const selected = [first, second].map((teleporter, index) => ({
    ...teleporter,
    id: index,
    targetId: index === 0 ? 1 : 0
  }));

  for (const teleporter of selected) {
    maze[teleporter.wallY][teleporter.wallX] = TILE_TELEPORTER;
  }

  return selected;
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
      if (isBlockingTile(tile) || tile === TILE_ENTRY || tile === TILE_EXIT || nearEntry || nearExit) continue;

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

  const targetCount = currentLevel >= 2
    ? Math.min(22, Math.max(12, Math.floor((maze.length * maze[0].length) / 20)))
    : Math.min(16, Math.max(8, Math.floor((maze.length * maze[0].length) / 24)));
  const selected = [];
  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    if (selected.length >= targetCount) break;
    const hasSpace = selected.every((torch) => Math.hypot(torch.x - candidate.x, torch.y - candidate.y) > 2.6);
    if (hasSpace) selected.push(candidate);
  }

  return selected;
}

function createWallFrames() {
  const candidates = [];
  const faces = [
    { id: 1, dx: 0, dy: -1, offsetX: 0.5, offsetY: 0.075, nx: 0, ny: 1 },
    { id: 2, dx: 0, dy: 1, offsetX: 0.5, offsetY: 0.925, nx: 0, ny: -1 },
    { id: 3, dx: -1, dy: 0, offsetX: 0.075, offsetY: 0.5, nx: 1, ny: 0 },
    { id: 4, dx: 1, dy: 0, offsetX: 0.925, offsetY: 0.5, nx: -1, ny: 0 }
  ];

  for (let y = 1; y < maze.length - 1; y++) {
    for (let x = 1; x < maze[0].length - 1; x++) {
      const tile = maze[y][x];
      const nearEntry = Math.abs(x - entry.x) + Math.abs(y - entry.y) < 4;
      const nearExit = Math.abs(x - exit.x) + Math.abs(y - exit.y) < 4;
      if (isBlockingTile(tile) || tile === TILE_ENTRY || tile === TILE_EXIT || nearEntry || nearExit) continue;

      for (const face of faces) {
        if (maze[y + face.dy]?.[x + face.dx] !== TILE_WALL) continue;

        const frameX = x + face.offsetX;
        const frameY = y + face.offsetY;
        const tooCloseToTorch = torches.some((torch) => Math.hypot(torch.x - frameX, torch.y - frameY) < 1.15);
        if (tooCloseToTorch) continue;

        candidates.push({
          x: frameX,
          y: frameY,
          cellX: x,
          cellY: y,
          nx: face.nx,
          ny: face.ny,
          seed: textureNoise(x - 9, y + 23, face.id, maze.length),
          score: textureNoise(x + 43, y - 31, face.id, maze[0].length)
        });
      }
    }
  }

  const targetCount = Math.min(WALL_FRAME_COUNT, Math.max(3, Math.floor((maze.length * maze[0].length) / 54)));
  const selected = [];
  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    if (selected.length >= targetCount) break;
    const hasSpace = selected.every((frame) => Math.hypot(frame.x - candidate.x, frame.y - candidate.y) > 3.2);
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

function createMazeKey() {
  const candidates = [];
  const fallback = [];

  for (let y = 1; y < maze.length - 1; y++) {
    for (let x = 1; x < maze[0].length - 1; x++) {
      if (!isWalkableCell(x, y)) continue;
      if (x === entry.x && y === entry.y) continue;
      if (x === exit.x && y === exit.y) continue;
      if (x === Math.floor(player.x) && y === Math.floor(player.y)) continue;

      const pathFromEntry = findPath({ x: entry.x, y: entry.y }, { x, y });
      if (!pathFromEntry.length) continue;

      const cx = x + 0.5;
      const cy = y + 0.5;
      const distanceFromMonster = monster ? Math.hypot(cx - monster.x, cy - monster.y) : Infinity;
      const distanceFromExit = Math.hypot(x - exit.x, y - exit.y);
      const spawn = {
        x,
        y,
        pathLength: pathFromEntry.length,
        score: textureNoise(x + 31, y - 19, maze.length, maze[0].length)
      };
      fallback.push(spawn);

      if (pathFromEntry.length < 7) continue;
      if (distanceFromExit < 3) continue;
      if (distanceFromMonster < 2.5) continue;
      candidates.push(spawn);
    }
  }

  const pool = candidates.length ? candidates : fallback;
  pool.sort((a, b) => (b.pathLength - a.pathLength) || (b.score - a.score));
  const topChoices = pool.slice(0, Math.max(1, Math.min(6, pool.length)));
  const spawn = topChoices[Math.floor(worldRandom() * topChoices.length)] || { x: entry.x + 1, y: entry.y };
  return {
    x: spawn.x + 0.5,
    y: spawn.y + 0.5,
    seed: worldRandom() * Math.PI * 2
  };
}

function createMazeCompass() {
  const candidates = [];
  const fallback = [];

  for (let y = 1; y < maze.length - 1; y++) {
    for (let x = 1; x < maze[0].length - 1; x++) {
      if (!isWalkableCell(x, y)) continue;
      if (x === entry.x && y === entry.y) continue;
      if (x === exit.x && y === exit.y) continue;
      if (x === Math.floor(player.x) && y === Math.floor(player.y)) continue;
      if (mazeKey && x === Math.floor(mazeKey.x) && y === Math.floor(mazeKey.y)) continue;

      const pathFromEntry = findPath({ x: entry.x, y: entry.y }, { x, y });
      if (!pathFromEntry.length) continue;

      const cx = x + 0.5;
      const cy = y + 0.5;
      const distanceFromKey = mazeKey ? Math.hypot(cx - mazeKey.x, cy - mazeKey.y) : Infinity;
      const distanceFromMonster = monster ? Math.hypot(cx - monster.x, cy - monster.y) : Infinity;
      const spawn = {
        x,
        y,
        pathLength: pathFromEntry.length,
        score: textureNoise(x - 23, y + 41, maze[0].length, maze.length)
      };
      fallback.push(spawn);

      if (pathFromEntry.length < 5) continue;
      if (distanceFromKey < 3) continue;
      if (distanceFromMonster < 2.5) continue;
      candidates.push(spawn);
    }
  }

  const pool = candidates.length ? candidates : fallback;
  pool.sort((a, b) => (b.score - a.score) || (b.pathLength - a.pathLength));
  const topChoices = pool.slice(0, Math.max(1, Math.min(8, pool.length)));
  const spawn = topChoices[Math.floor(worldRandom() * topChoices.length)] || { x: entry.x + 1, y: entry.y };
  return {
    x: spawn.x + 0.5,
    y: spawn.y + 0.5,
    seed: worldRandom() * Math.PI * 2
  };
}

function createMapOrbs() {
  const orbs = [];
  for (let i = 0; i < MAP_ORB_COUNT; i++) {
    orbs.push(spawnMapOrb(orbs));
  }
  return orbs;
}

function spawnMapOrb(existingOrbs = [], previous = null) {
  const candidates = [];
  const fallback = [];
  const blockedOrbs = previous ? existingOrbs.concat(previous) : existingOrbs;

  for (let y = 1; y < maze.length - 1; y++) {
    for (let x = 1; x < maze[0].length - 1; x++) {
      if (!isWalkableCell(x, y)) continue;
      if (x === entry.x && y === entry.y) continue;
      if (x === exit.x && y === exit.y) continue;
      if (x === Math.floor(player.x) && y === Math.floor(player.y)) continue;
      if (mazeKey && x === Math.floor(mazeKey.x) && y === Math.floor(mazeKey.y)) continue;
      if (mazeCompass && x === Math.floor(mazeCompass.x) && y === Math.floor(mazeCompass.y)) continue;
      if (blockedOrbs.some((orb) => x === Math.floor(orb.x) && y === Math.floor(orb.y))) continue;

      const cx = x + 0.5;
      const cy = y + 0.5;
      const distanceFromPlayer = Math.hypot(cx - player.x, cy - player.y);
      const distanceFromMonster = monster ? Math.hypot(cx - monster.x, cy - monster.y) : Infinity;
      const distanceFromPrevious = previous ? Math.hypot(cx - previous.x, cy - previous.y) : Infinity;
      const distanceFromExisting = existingOrbs.reduce((nearest, orb) => (
        Math.min(nearest, Math.hypot(cx - orb.x, cy - orb.y))
      ), Infinity);
      const spawn = { x, y };
      fallback.push(spawn);

      if (distanceFromPlayer < 3.5) continue;
      if (distanceFromMonster < 2.5) continue;
      if (distanceFromExisting < 3) continue;
      if (distanceFromPrevious < 4) continue;
      candidates.push(spawn);
    }
  }

  const pool = candidates.length ? candidates : fallback;
  const spawn = pool[Math.floor(worldRandom() * pool.length)] || { x: entry.x + 1, y: entry.y };
  return {
    x: spawn.x + 0.5,
    y: spawn.y + 0.5,
    seed: worldRandom() * Math.PI * 2
  };
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
  return isBlockingTile(maze[mapY][mapX]);
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
    !isBlockingTile(maze[y][x])
  );
}

function isBlockingTile(tile) {
  return tile === TILE_WALL || tile === TILE_TELEPORTER;
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
  const radius = PLAYER_COLLISION_RADIUS;
  return (
    !isWall(x - radius, y - radius) &&
    !isWall(x + radius, y - radius) &&
    !isWall(x - radius, y + radius) &&
    !isWall(x + radius, y + radius)
  );
}

function teleporterCellAt(x, y) {
  const radius = PLAYER_COLLISION_RADIUS;
  const points = [
    { x: x - radius, y: y - radius },
    { x: x + radius, y: y - radius },
    { x: x - radius, y: y + radius },
    { x: x + radius, y: y + radius }
  ];

  for (const point of points) {
    if (tileAt(point.x, point.y) !== TILE_TELEPORTER) continue;
    return { x: Math.floor(point.x), y: Math.floor(point.y) };
  }

  return null;
}

function teleporterByWallCell(x, y) {
  return teleporters.find((teleporter) => teleporter.wallX === x && teleporter.wallY === y);
}

function tryUseTeleporter(x, y) {
  if (teleportCooldown > 0 || teleporters.length < 2 || won || caught) return false;

  const wallCell = teleporterCellAt(x, y);
  if (!wallCell) return false;

  const source = teleporterByWallCell(wallCell.x, wallCell.y);
  if (!source) return false;

  const target = teleporters[source.targetId];
  if (!target) return false;

  const targetX = target.cellX + 0.5 + target.nx * 0.08;
  const targetY = target.cellY + 0.5 + target.ny * 0.08;
  if (!canStandAt(targetX, targetY)) return false;

  player.x = targetX;
  player.y = targetY;
  player.angle = normalizeAngle(Math.atan2(target.ny, target.nx));
  teleportCooldown = TELEPORT_COOLDOWN;
  steps += 1;
  stepsEl.textContent = String(steps);
  stateEl.textContent = "Teleport";
  updateCompassDisplay();
  return true;
}

function movePlayer(dx, dy) {
  const oldTile = `${Math.floor(player.x)},${Math.floor(player.y)}`;

  if (canStandAt(player.x + dx, player.y)) {
    player.x += dx;
  } else if (dx !== 0 && tryUseTeleporter(player.x + dx, player.y)) {
    return;
  }

  if (canStandAt(player.x, player.y + dy)) {
    player.y += dy;
  } else if (dy !== 0 && tryUseTeleporter(player.x, player.y + dy)) {
    return;
  }

  const newTile = `${Math.floor(player.x)},${Math.floor(player.y)}`;
  if (newTile !== oldTile) {
    steps += 1;
    stepsEl.textContent = String(steps);
  }
}

function updateMapOrb(dt) {
  mapRevealTimer = Math.max(0, mapRevealTimer - dt);
  if (!mapOrbs.length || won || caught) return;

  for (let i = 0; i < mapOrbs.length; i++) {
    const orb = mapOrbs[i];
    const distance = Math.hypot(player.x - orb.x, player.y - orb.y);
    if (distance > MAP_ORB_PICKUP_DISTANCE) continue;

    mapRevealTimer = MAP_REVEAL_DURATION;
    const otherOrbs = mapOrbs.filter((_, index) => index !== i);
    mapOrbs[i] = spawnMapOrb(otherOrbs, orb);
    break;
  }
}

function updateMazeKey() {
  if (!mazeKey || hasKey || won || caught) return;

  const distance = Math.hypot(player.x - mazeKey.x, player.y - mazeKey.y);
  if (distance > KEY_PICKUP_DISTANCE) return;

  hasKey = true;
  mazeKey = null;
  if (keyStatusEl) keyStatusEl.textContent = "Oui";
  stateEl.textContent = "Cle";
}

function updateMazeCompass() {
  if (!mazeCompass || hasCompass || won || caught) return;

  const distance = Math.hypot(player.x - mazeCompass.x, player.y - mazeCompass.y);
  if (distance > COMPASS_PICKUP_DISTANCE) return;

  hasCompass = true;
  mazeCompass = null;
  if (compassPanelEl) compassPanelEl.hidden = false;
  updateCompassDisplay();
  stateEl.textContent = "Boussole";
}

function updateCompassDisplay() {
  if (!hasCompass || !directionStatusEl) return;
  directionStatusEl.textContent = cardinalDirection(player.angle);
}

function cardinalDirection(angle) {
  const normalized = normalizeAngle(angle);
  if (normalized < Math.PI * 0.25 || normalized >= Math.PI * 1.75) return "Est";
  if (normalized < Math.PI * 0.75) return "Sud";
  if (normalized < Math.PI * 1.25) return "Ouest";
  return "Nord";
}

function update(dt) {
  updateRemotePlayer(dt);
  const active = (code) => keys.has(code) || touchKeys.has(code);
  const strafeMode = keys.has("AltLeft") || keys.has("AltRight");
  const turnSpeed = 2.45;
  const moveSpeed = won ? 1.35 : 2.7;
  teleportCooldown = Math.max(0, teleportCooldown - dt);

  if (caught) {
    stateEl.textContent = "Attrape";
    updateHeartbeat(dt);
    return;
  }

  if (!strafeMode && active("ArrowLeft")) player.angle -= turnSpeed * dt;
  if (!strafeMode && active("ArrowRight")) player.angle += turnSpeed * dt;

  let forward = 0;
  if (active("ArrowUp")) forward += 1;
  if (active("ArrowDown")) forward -= 1;

  let strafe = 0;
  if (strafeMode && active("ArrowLeft")) strafe -= 1;
  if (strafeMode && active("ArrowRight")) strafe += 1;

  if (!won && (forward !== 0 || strafe !== 0)) {
    const length = Math.hypot(forward, strafe) || 1;
    const step = moveSpeed * dt / length;
    const forwardX = Math.cos(player.angle);
    const forwardY = Math.sin(player.angle);
    const rightX = -forwardY;
    const rightY = forwardX;

    movePlayer(
      (forwardX * forward + rightX * strafe) * step,
      (forwardY * forward + rightY * strafe) * step
    );
  }

  player.angle = normalizeAngle(player.angle);
  updateMonster(dt);
  updateHeartbeat(dt);
  updateMapOrb(dt);
  updateMazeKey();
  updateMazeCompass();
  updateCompassDisplay();

  const currentTile = tileAt(player.x, player.y);
  if (!won && currentTile === TILE_EXIT && hasKey) {
    completeLevel();
  } else if (!won) {
    const distance = monsterThreatDistance();
    if (teleportCooldown > TELEPORT_COOLDOWN - 0.25) stateEl.textContent = "Teleport";
    else if (distance < 3.2) stateEl.textContent = "Danger";
    else if (currentTile === TILE_EXIT && !hasKey) stateEl.textContent = "Cle requise";
    else if (hasKey) stateEl.textContent = "Cle";
    else stateEl.textContent = currentTile === TILE_ENTRY ? "Entree" : "Dedans";
  }
}

function completeLevel() {
  if (currentLevel < FINAL_LEVEL) {
    startLevel(currentLevel + 1);
    return;
  }

  won = true;
  resultMessage.textContent = "Sortie finale atteinte";
  winBanner.classList.remove("danger-banner");
  stateEl.textContent = "Sortie";
  winBanner.hidden = false;
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
  if (!monster.path.length && monsterCell.x === playerCell.x && monsterCell.y === playerCell.y) {
    remaining = moveMonsterToward(player.x, player.y, remaining);
  }

  while (remaining > 0 && monster.path.length) {
    const next = monster.path[0];
    const targetX = next.x + 0.5;
    const targetY = next.y + 0.5;
    const before = remaining;
    remaining = moveMonsterToward(targetX, targetY, remaining);

    if (before === remaining) {
      monster.path.shift();
      continue;
    }

    if (Math.hypot(targetX - monster.x, targetY - monster.y) < 0.035) monster.path.shift();
  }

  const sameCell = (
    Math.floor(monster.x) === Math.floor(player.x) &&
    Math.floor(monster.y) === Math.floor(player.y)
  );
  const distance = monsterDistance();
  if (distance <= MONSTER_CATCH_DISTANCE || (sameCell && distance <= MONSTER_CELL_CATCH_DISTANCE)) {
    catchPlayer();
  }
}

function moveMonsterToward(targetX, targetY, remaining) {
  const dx = targetX - monster.x;
  const dy = targetY - monster.y;
  const gap = Math.hypot(dx, dy);
  if (gap < 0.001) return remaining;

  const step = Math.min(remaining, gap);
  monster.x += dx / gap * step;
  monster.y += dy / gap * step;
  return remaining - step;
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

function faceMonsterOnCatch() {
  if (!monster) return;

  const dx = monster.x - player.x;
  const dy = monster.y - player.y;
  const distance = Math.hypot(dx, dy);
  const angle = distance > 0.001 ? Math.atan2(dy, dx) : player.angle;
  player.angle = normalizeAngle(angle);

  if (distance < MONSTER_CATCH_VIEW_DISTANCE) {
    monster.x = player.x + Math.cos(player.angle) * MONSTER_CATCH_VIEW_DISTANCE;
    monster.y = player.y + Math.sin(player.angle) * MONSTER_CATCH_VIEW_DISTANCE;
  }

  updateCompassDisplay();
}

function catchPlayer() {
  faceMonsterOnCatch();
  playCaptureSound();
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

function playCaptureSound() {
  if (!audioContext || !audioReady) return;
  if (audioContext.state === "suspended") return;

  const now = audioContext.currentTime;
  playCaptureThump(now);
  playCaptureSnarl(now + 0.018);
  playCaptureNoise(now + 0.012);
}

function playCaptureThump(start) {
  const oscillator = audioContext.createOscillator();
  const filter = audioContext.createBiquadFilter();
  const gain = audioContext.createGain();

  oscillator.type = "sawtooth";
  oscillator.frequency.setValueAtTime(118, start);
  oscillator.frequency.exponentialRampToValueAtTime(34, start + 0.32);

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(420, start);
  filter.frequency.exponentialRampToValueAtTime(95, start + 0.3);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.78, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.36);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.38);
}

function playCaptureSnarl(start) {
  const oscillator = audioContext.createOscillator();
  const filter = audioContext.createBiquadFilter();
  const gain = audioContext.createGain();

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(690, start);
  oscillator.frequency.exponentialRampToValueAtTime(112, start + 0.2);

  filter.type = "bandpass";
  filter.frequency.setValueAtTime(360, start);
  filter.Q.setValueAtTime(5.5, start);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.24);
}

function playCaptureNoise(start) {
  const duration = 0.18;
  const sampleRate = audioContext.sampleRate;
  const buffer = audioContext.createBuffer(1, Math.floor(sampleRate * duration), sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i++) {
    const fade = 1 - i / data.length;
    data[i] = (Math.random() * 2 - 1) * fade * fade;
  }

  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const gain = audioContext.createGain();

  source.buffer = buffer;
  filter.type = "highpass";
  filter.frequency.setValueAtTime(560, start);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.22, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  source.start(start);
  source.stop(start + duration);
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

    if (isBlockingTile(maze[mapY][mapX])) {
      const distance = side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY;
      const hit = side === 0
        ? player.y + distance * rayDirY
        : player.x + distance * rayDirX;

      return {
        distance: Math.max(distance, 0.0001),
        mapX,
        mapY,
        side,
        wallX: hit - Math.floor(hit),
        tile: maze[mapY][mapX]
      };
    }
  }

  return { distance: 32, mapX: 0, mapY: 0, side: 0, wallX: 0.5, tile: TILE_WALL };
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
    const rawDistance = hit.distance;
    const distance = Math.max(rawDistance, MIN_WALL_RENDER_DISTANCE);
    const hitWorldX = player.x + rawDistance * rayDirX;
    const hitWorldY = player.y + rawDistance * rayDirY;
    const localLight = worldLightAt(hitWorldX, hitWorldY);
    const lineHeight = Math.min(h * 2, h / distance);
    const drawStart = Math.max(0, Math.floor((h - lineHeight) / 2));
    const drawEnd = Math.min(h, Math.floor((h + lineHeight) / 2));

    ctx.fillStyle = wallColor(hit, distance, localLight);
    ctx.fillRect(x, drawStart, columnWidth + 1, drawEnd - drawStart);

    drawWallTexture(x, drawStart, drawEnd, columnWidth, hit, distance, localLight, now);
    drawColumnDarkness(x, drawStart, drawEnd, columnWidth, localLight);

    for (let fill = x; fill < x + columnWidth + 1 && fill < w; fill++) {
      zBuffer[fill] = rawDistance;
    }
  }

  drawWallFrames(w, h, dirX, dirY, planeX, planeY);
  drawTorches(w, h, dirX, dirY, planeX, planeY, now);
  drawMapOrb(w, h, dirX, dirY, planeX, planeY, now);
  drawMazeKey(w, h, dirX, dirY, planeX, planeY, now);
  drawMazeCompass(w, h, dirX, dirY, planeX, planeY, now);
  drawRemotePlayer(w, h, dirX, dirY, planeX, planeY, now);
  drawMonster(w, h, dirX, dirY, planeX, planeY, now);
  drawSprites(w, h, dirX, dirY, planeX, planeY);
  drawVignette(w, h);
  drawMinimap();
}

function drawWorldBackground(w, h) {
  ctx.fillStyle = isDarkLevel() ? "#071017" : "#47667a";
  ctx.fillRect(0, 0, w, h / 2);

  ctx.fillStyle = isDarkLevel() ? "#15100c" : "#5d4d3b";
  ctx.fillRect(0, h / 2, w, h / 2);
}

function drawCeilingTexture(w, h) {
  const horizon = Math.floor(h / 2);
  if (horizon <= 0) return;

  const sample = Math.max(4, Math.floor(w / 420));
  const texW = Math.max(1, Math.ceil(w / sample));
  const texH = Math.max(1, Math.ceil(horizon / sample));
  if (ceilingBuffer.width !== texW || ceilingBuffer.height !== texH) {
    ceilingBuffer.width = texW;
    ceilingBuffer.height = texH;
  }

  const dark = isDarkLevel();
  const ceilingLight = dark ? clamp(0.34 + worldLightAt(player.x, player.y) * 0.58, 0.34, 0.92) : 1;
  const image = ceilingBufferCtx.createImageData(texW, texH);
  const data = image.data;
  const dirX = Math.cos(player.angle);
  const dirY = Math.sin(player.angle);
  const planeLength = Math.tan(FOV / 2);
  const planeX = -dirY * planeLength;
  const planeY = dirX * planeLength;
  const rayLeftX = dirX - planeX;
  const rayLeftY = dirY - planeY;
  const rayRightX = dirX + planeX;
  const rayRightY = dirY + planeY;

  for (let sy = 0; sy < texH; sy++) {
    const screenY = Math.min(horizon - 1, sy * sample + sample * 0.5);
    const p = Math.max(1, horizon - screenY);
    const distance = Math.min(32, h * 0.5 / p);
    const fade = clamp((distance - 12) / 20, 0, 1);
    const stepX = distance * (rayRightX - rayLeftX) / texW;
    const stepY = distance * (rayRightY - rayLeftY) / texW;
    let worldX = player.x + distance * rayLeftX + stepX * 0.5;
    let worldY = player.y + distance * rayLeftY + stepY * 0.5;

    for (let sx = 0; sx < texW; sx++) {
      const color = ceilingTextureColor(worldX, worldY, distance, fade, dark, ceilingLight);
      const offset = (sy * texW + sx) * 4;
      data[offset] = color.r;
      data[offset + 1] = color.g;
      data[offset + 2] = color.b;
      data[offset + 3] = 255;
      worldX += stepX;
      worldY += stepY;
    }
  }

  ceilingBufferCtx.putImageData(image, 0, 0);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(ceilingBuffer, 0, 0, texW, texH, 0, 0, w, horizon);
  ctx.restore();
}

function ceilingTextureColor(worldX, worldY, distance, fade, dark, ceilingLight) {
  const cellX = Math.floor(worldX);
  const cellY = Math.floor(worldY);
  const localX = positiveMod(worldX, 1);
  const localY = positiveMod(worldY, 1);
  const rows = 3;
  const columns = 3;
  const row = Math.floor(localY * rows);
  const stagger = row % 2 === 0 ? 0 : 0.5;
  const brickX = localX * columns + stagger;
  const column = Math.floor(brickX);
  const seamX = positiveMod(brickX, 1);
  const seamY = positiveMod(localY * rows, 1);
  const seam = seamX < 0.04 || seamX > 0.96 || seamY < 0.04 || seamY > 0.96;
  const blockNoise = textureNoise(cellX, cellY, row, column);
  const grain = textureNoise(Math.floor(worldX * 13), Math.floor(worldY * 13), currentLevel, 83);
  const crackSeed = textureNoise(cellX - 17, cellY + 23, row, column);
  const crack = crackSeed > 0.84 && Math.abs(positiveMod(localX + localY * 0.72 + crackSeed, 1) - 0.5) < 0.035;
  const distanceLight = clamp(1 - distance * 0.033, 0.28, 1);
  const levelLight = dark ? ceilingLight : 1;
  let shade = distanceLight * levelLight * (0.9 + blockNoise * 0.16 + grain * 0.075);
  if (seam) shade *= dark ? 0.52 : 0.66;
  if (crack) shade *= dark ? 0.38 : 0.54;

  const base = dark ? [48, 61, 62] : [88, 108, 116];
  const far = dark ? [4, 8, 10] : [90, 114, 125];
  return {
    r: Math.floor(base[0] * shade * (1 - fade) + far[0] * fade),
    g: Math.floor(base[1] * shade * (1 - fade) + far[1] * fade),
    b: Math.floor(base[2] * shade * (1 - fade) + far[2] * fade)
  };
}

function wallColor(hit, distance, localLight = 1) {
  if (hit.tile === TILE_TELEPORTER) return teleporterWallColor(hit, distance, localLight);
  return brickWallColor(hit, distance, localLight);
}

function brickWallColor(hit, distance, localLight = 1) {
  const edge = hit.wallX < 0.08 || hit.wallX > 0.92 ? 0.82 : 1;
  const side = hit.side === 1 ? 0.76 : 1;
  const distanceLight = Math.max(0.34, 1 - distance * 0.062);
  const levelLight = isDarkLevel() ? 0.14 + localLight * 0.92 : 1;
  const light = distanceLight * edge * side * levelLight;
  const r = Math.floor(166 * light);
  const g = Math.floor(136 * light);
  const b = Math.floor(97 * light);
  return `rgb(${r}, ${g}, ${b})`;
}

function teleporterWallColor(hit, distance, localLight = 1) {
  const portalHalfWidth = 0.28;
  if (Math.abs(hit.wallX - 0.5) > portalHalfWidth) {
    return brickWallColor(hit, distance, localLight);
  }

  const side = hit.side === 1 ? 0.82 : 1;
  const distanceLight = Math.max(0.42, 1 - distance * 0.052);
  const levelLight = isDarkLevel() ? 0.28 + localLight * 0.78 : 1;
  const light = distanceLight * side * levelLight;
  const r = Math.floor(48 * light);
  const g = Math.floor(126 * light);
  const b = Math.floor(168 * light);
  return `rgb(${r}, ${g}, ${b})`;
}

function drawWallTexture(x, start, end, width, hit, distance, localLight = 1, now = 0) {
  const height = end - start;
  if (height <= 0) return;

  if (hit.tile === TILE_TELEPORTER) {
    drawTeleporterWallTexture(x, start, end, width, hit, distance, localLight, now);
    return;
  }

  const lightVisibility = isDarkLevel() ? 0.28 + localLight * 0.92 : 1;
  const visibility = Math.max(0.12, 1 - distance * 0.075) * lightVisibility;
  const rows = 7;
  const columns = 4;
  const mortar = Math.max(1, Math.min(2.2, height * 0.01));
  const mortarAlpha = Math.max(0.1, 0.36 - distance * 0.023) * lightVisibility;

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

  const edgeAlpha = Math.max(0.08, 0.28 - distance * 0.018) * lightVisibility;
  if (hit.wallX < 0.045 || hit.wallX > 0.955) {
    ctx.fillStyle = `rgba(255, 239, 190, ${edgeAlpha})`;
    ctx.fillRect(x, start, width + 1, height);
  }

  ctx.restore();
}

function drawTeleporterWallTexture(x, start, end, width, hit, distance, localLight = 1, now = 0) {
  const height = end - start;
  const visibility = Math.max(0.16, 1 - distance * 0.06) * (isDarkLevel() ? 0.38 + localLight * 0.9 : 1);
  const u = hit.wallX - 0.5;
  const portalHalfWidth = 0.28;
  const edgeFade = clamp((portalHalfWidth - Math.abs(u)) / 0.055, 0, 1);

  if (edgeFade <= 0) {
    drawWallTexture(x, start, end, width, { ...hit, tile: TILE_WALL }, distance, localLight, now);
    return;
  }

  const step = Math.max(2, Math.floor(height / 150));
  const centerY = (start + end) / 2;
  const halfHeight = Math.max(1, height / 2);
  const portalU = u / portalHalfWidth * 0.58;
  const portalVisibility = visibility * edgeFade;
  const phase = now * 0.00145 + textureNoise(hit.mapX, hit.mapY, 5, 9) * 0.18;
  const pulse = 0.92 + Math.sin(now * 0.004 + hit.mapX * 1.7 + hit.mapY) * 0.08;

  ctx.save();
  ctx.fillStyle = `rgba(5, 20, 34, ${0.34 * portalVisibility})`;
  ctx.fillRect(x, start, width + 1, height);

  for (let y = start; y < end; y += step) {
    const v = (y + step * 0.5 - centerY) / halfHeight;
    const radial = Math.sqrt(portalU * portalU * 1.35 + v * v);
    if (radial > 0.74) continue;

    const ring = Math.abs(Math.sin((radial * 9.6 + phase) * Math.PI));
    const centerPull = Math.max(0, 1 - radial / 0.74);
    const band = ring > 0.78 ? 1 : 0;
    const softGlow = Math.pow(centerPull, 2.2);
    const alpha = (band * 0.42 + softGlow * 0.24) * portalVisibility * pulse;
    if (alpha <= 0.012) continue;

    ctx.fillStyle = band
      ? `rgba(137, 245, 255, ${alpha})`
      : `rgba(178, 92, 255, ${alpha})`;
    ctx.fillRect(x, y, width + 1, step + 1);
  }

  const centerBand = Math.max(0, 1 - Math.abs(u) * 12);
  if (centerBand > 0) {
    ctx.fillStyle = `rgba(229, 255, 255, ${0.42 * centerBand * portalVisibility})`;
    ctx.fillRect(x, start + height * 0.38, width + 1, height * 0.24);
  }

  const edgeAlpha = Math.max(0.08, 0.32 - distance * 0.018) * visibility;
  if (Math.abs(Math.abs(u) - portalHalfWidth) < 0.018) {
    ctx.fillStyle = `rgba(205, 255, 245, ${edgeAlpha})`;
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

function isDarkLevel() {
  return currentLevel >= 2;
}

function worldLightAt(x, y) {
  if (!isDarkLevel()) return 1;

  let light = 0.08;
  for (const torch of torches) {
    const distance = Math.hypot(x - torch.x, y - torch.y);
    const reach = 3.45;
    if (distance >= reach) continue;

    const strength = 1 - distance / reach;
    light += strength * strength * 1.25;
  }

  return clamp(light, 0.08, 1);
}

function drawColumnDarkness(x, start, end, width, light) {
  if (!isDarkLevel()) return;

  const alpha = clamp(0.76 - light * 0.72, 0.04, 0.76);
  ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
  ctx.fillRect(x, start, width + 1, end - start);
}

function drawWallFrames(w, h, dirX, dirY, planeX, planeY) {
  if (!wallFrames.length) return;

  const visibleFrames = wallFrames
    .map((frame) => {
      const dx = frame.x - player.x;
      const dy = frame.y - player.y;
      return { frame, dx, dy, distanceSq: dx * dx + dy * dy };
    })
    .sort((a, b) => b.distanceSq - a.distanceSq);

  for (const item of visibleFrames) {
    const frame = item.frame;
    const distance = Math.sqrt(item.distanceSq);
    const normalView = ((player.x - frame.x) * frame.nx + (player.y - frame.y) * frame.ny) / Math.max(0.001, distance);
    if (normalView < -0.08) continue;

    const projection = projectPoint(item.dx, item.dy, dirX, dirY, planeX, planeY, w);
    if (!projection || projection.depth <= 0.08) continue;

    const screenX = projection.screenX;
    const bufferIndex = Math.floor(clamp(screenX, 0, w - 1));
    if (screenX < -120 || screenX > w + 120) continue;
    if (projection.depth >= (zBuffer[bufferIndex] || Infinity) + 0.1) continue;

    const wallHeight = h / projection.depth;
    const imageRatio = wallFrameImageReady && wallFrameImage.naturalHeight
      ? clamp(wallFrameImage.naturalWidth / wallFrameImage.naturalHeight, 0.55, 1.35)
      : 0.78;
    const frameHeight = clamp(wallHeight * 0.34, 22, h * 0.38);
    const angleScale = clamp(0.18 + normalView * 0.82, 0.18, 1);
    const frameWidth = frameHeight * imageRatio * angleScale;
    const centerY = h / 2 - wallHeight * 0.17;
    const left = screenX - frameWidth / 2;
    const top = centerY - frameHeight / 2;
    const levelLight = isDarkLevel() ? clamp(0.22 + worldLightAt(frame.x, frame.y) * 0.95, 0.22, 1) : 1;
    const facing = clamp(0.42 + normalView * 0.58, 0.42, 1);
    const alpha = clamp(1.12 - projection.depth * 0.045, 0.5, 1) * facing * levelLight;
    const sideShade = clamp(0.46 + normalView * 0.54, 0.46, 1) * levelLight;

    drawWallFrame(left, top, frameWidth, frameHeight, alpha, sideShade);
  }
}

function drawWallFrame(x, y, width, height, alpha, sideShade = 1) {
  const border = Math.max(2, Math.min(10, Math.min(width, height) * 0.1));
  const innerX = x + border;
  const innerY = y + border;
  const innerW = Math.max(1, width - border * 2);
  const innerH = Math.max(1, height - border * 2);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(8, 5, 3, 0.34)";
  ctx.fillRect(x + border * 0.55, y + border * 0.72, width, height);

  const frameGradient = ctx.createLinearGradient(x, y, x + width, y + height);
  frameGradient.addColorStop(0, "#2d1809");
  frameGradient.addColorStop(0.38, "#9a6129");
  frameGradient.addColorStop(0.64, "#d19646");
  frameGradient.addColorStop(1, "#3a210c");
  ctx.fillStyle = frameGradient;
  ctx.fillRect(x, y, width, height);

  ctx.fillStyle = "#1b1008";
  ctx.fillRect(innerX - border * 0.22, innerY - border * 0.22, innerW + border * 0.44, innerH + border * 0.44);

  ctx.save();
  ctx.beginPath();
  ctx.rect(innerX, innerY, innerW, innerH);
  ctx.clip();

  if (wallFrameImageReady) {
    drawCoverImage(wallFrameImage, innerX, innerY, innerW, innerH);
  } else {
    ctx.fillStyle = "#20150f";
    ctx.fillRect(innerX, innerY, innerW, innerH);
    ctx.strokeStyle = "rgba(255, 231, 174, 0.2)";
    ctx.lineWidth = Math.max(1, border * 0.28);
    ctx.beginPath();
    ctx.moveTo(innerX, innerY + innerH);
    ctx.lineTo(innerX + innerW, innerY);
    ctx.stroke();
  }

  const shine = ctx.createLinearGradient(innerX, innerY, innerX + innerW, innerY + innerH);
  shine.addColorStop(0, "rgba(255, 255, 255, 0.16)");
  shine.addColorStop(0.34, "rgba(255, 255, 255, 0)");
  shine.addColorStop(1, "rgba(0, 0, 0, 0.2)");
  ctx.fillStyle = shine;
  ctx.fillRect(innerX, innerY, innerW, innerH);

  if (sideShade < 0.98) {
    ctx.fillStyle = `rgba(0, 0, 0, ${(1 - sideShade) * 0.48})`;
    ctx.fillRect(innerX, innerY, innerW, innerH);
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 226, 151, 0.42)";
  ctx.lineWidth = Math.max(1, border * 0.22);
  ctx.strokeRect(x + border * 0.32, y + border * 0.32, width - border * 0.64, height - border * 0.64);

  ctx.strokeStyle = "rgba(12, 7, 3, 0.72)";
  ctx.lineWidth = Math.max(1, border * 0.34);
  ctx.strokeRect(innerX, innerY, innerW, innerH);

  if (sideShade < 0.98) {
    ctx.fillStyle = `rgba(0, 0, 0, ${(1 - sideShade) * 0.18})`;
    ctx.fillRect(x, y, width, height);
  }
  ctx.restore();
}

function drawCoverImage(image, x, y, width, height) {
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;

  if (sourceRatio > targetRatio) {
    sw = image.naturalHeight * targetRatio;
    sx = (image.naturalWidth - sw) / 2;
  } else {
    sh = image.naturalWidth / targetRatio;
    sy = (image.naturalHeight - sh) / 2;
  }

  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
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
    const facing = Math.max(0.34, normalView);
    const haloAlpha = clamp(1.1 - projection.depth * 0.07, 0.24, 1) * facing;
    const bodyAlpha = 1;
    const flameAlpha = 1;
    const pulse = 0.92 + Math.sin(now * 0.008 + torch.seed * 17) * 0.08 + Math.sin(now * 0.021 + torch.seed * 31) * 0.045;

    drawTorchHalo(screenX, flameY, torchHeight, pulse, haloAlpha);
    drawTorchBody(screenX, bracketY, torchWidth, torchHeight, bodyAlpha);
    drawTorchFlame(screenX, flameY, torchHeight * 0.16, pulse, flameAlpha);
  }
}

function drawMapOrb(w, h, dirX, dirY, planeX, planeY, now) {
  if (!mapOrbs.length || won) return;

  const visibleOrbs = mapOrbs
    .map((orb) => {
      const dx = orb.x - player.x;
      const dy = orb.y - player.y;
      return { orb, dx, dy, distanceSq: dx * dx + dy * dy };
    })
    .sort((a, b) => b.distanceSq - a.distanceSq);

  for (const item of visibleOrbs) {
    const projection = projectPoint(item.dx, item.dy, dirX, dirY, planeX, planeY, w);
    if (!projection || projection.depth <= 0.08) continue;

    const screenX = projection.screenX;
    const wallHeight = h / projection.depth;
    const radius = clamp(wallHeight * 0.1, 7, h * 0.075);
    if (screenX < -radius * 3 || screenX > w + radius * 3) continue;

    const bufferIndex = Math.floor(clamp(screenX, 0, w - 1));
    if (projection.depth >= (zBuffer[bufferIndex] || Infinity) + 0.06) continue;

    const centerY = Math.min(h - radius * 1.35, h / 2 + wallHeight * 0.5 - radius * 1.15);
    const pulse = 0.94 + Math.sin(now * 0.006 + item.orb.seed) * 0.08;
    const alpha = clamp(1.22 - projection.depth * 0.055, 0.34, 1);

    ctx.save();
    ctx.globalAlpha = alpha;

    ctx.fillStyle = "rgba(20, 6, 7, 0.42)";
    ctx.beginPath();
    ctx.ellipse(screenX, centerY + radius * 0.96, radius * 1.05, radius * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = "lighter";
    const glowRadius = radius * (3.1 + pulse * 0.35);
    const glow = ctx.createRadialGradient(screenX, centerY, 0, screenX, centerY, glowRadius);
    glow.addColorStop(0, "rgba(255, 90, 76, 0.5)");
    glow.addColorStop(0.34, "rgba(214, 28, 42, 0.22)");
    glow.addColorStop(1, "rgba(214, 28, 42, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(screenX - glowRadius, centerY - glowRadius, glowRadius * 2, glowRadius * 2);

    ctx.globalCompositeOperation = "source-over";
    const orb = ctx.createRadialGradient(
      screenX - radius * 0.32,
      centerY - radius * 0.4,
      radius * 0.12,
      screenX,
      centerY,
      radius * pulse
    );
    orb.addColorStop(0, "#ffe0c9");
    orb.addColorStop(0.22, "#ff5f4b");
    orb.addColorStop(0.72, "#b80f24");
    orb.addColorStop(1, "#5d0715");
    ctx.fillStyle = orb;
    ctx.beginPath();
    ctx.arc(screenX, centerY, radius * pulse, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255, 243, 219, 0.7)";
    ctx.beginPath();
    ctx.arc(screenX - radius * 0.34, centerY - radius * 0.42, Math.max(1.3, radius * 0.17), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

function drawMazeKey(w, h, dirX, dirY, planeX, planeY, now) {
  if (!mazeKey || hasKey || won) return;

  const dx = mazeKey.x - player.x;
  const dy = mazeKey.y - player.y;
  const projection = projectPoint(dx, dy, dirX, dirY, planeX, planeY, w);
  if (!projection || projection.depth <= 0.08) return;

  const screenX = projection.screenX;
  const wallHeight = h / projection.depth;
  const size = clamp(wallHeight * 0.16, 13, h * 0.12);
  if (screenX < -size * 3 || screenX > w + size * 3) return;

  const bufferIndex = Math.floor(clamp(screenX, 0, w - 1));
  if (projection.depth >= (zBuffer[bufferIndex] || Infinity) + 0.06) return;

  const centerY = Math.min(h - size * 0.9, h / 2 + wallHeight * 0.45 - size * 0.65);
  const bob = Math.sin(now * 0.004 + mazeKey.seed) * size * 0.06;
  const alpha = clamp(1.16 - projection.depth * 0.055, 0.36, 1);
  const ringRadius = size * 0.22;
  const shaftLength = size * 0.58;

  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.globalCompositeOperation = "lighter";
  const glowRadius = size * 1.45;
  const glow = ctx.createRadialGradient(screenX, centerY + bob, 0, screenX, centerY + bob, glowRadius);
  glow.addColorStop(0, "rgba(255, 229, 126, 0.35)");
  glow.addColorStop(0.42, "rgba(242, 170, 43, 0.16)");
  glow.addColorStop(1, "rgba(242, 170, 43, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(screenX - glowRadius, centerY + bob - glowRadius, glowRadius * 2, glowRadius * 2);

  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(255, 195, 64, 0.74)";
  ctx.shadowBlur = size * 0.26;
  ctx.strokeStyle = "#f5c24a";
  ctx.lineWidth = Math.max(3, size * 0.12);

  ctx.beginPath();
  ctx.arc(screenX - shaftLength * 0.4, centerY + bob, ringRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(screenX - shaftLength * 0.17, centerY + bob);
  ctx.lineTo(screenX + shaftLength * 0.52, centerY + bob);
  ctx.lineTo(screenX + shaftLength * 0.52, centerY + bob + size * 0.18);
  ctx.moveTo(screenX + shaftLength * 0.26, centerY + bob);
  ctx.lineTo(screenX + shaftLength * 0.26, centerY + bob + size * 0.15);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 247, 191, 0.8)";
  ctx.lineWidth = Math.max(1.4, size * 0.035);
  ctx.beginPath();
  ctx.arc(screenX - shaftLength * 0.4, centerY + bob - ringRadius * 0.1, ringRadius * 0.55, Math.PI * 1.16, Math.PI * 1.88);
  ctx.moveTo(screenX - shaftLength * 0.1, centerY + bob - size * 0.06);
  ctx.lineTo(screenX + shaftLength * 0.42, centerY + bob - size * 0.06);
  ctx.stroke();

  ctx.fillStyle = "rgba(20, 12, 4, 0.28)";
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.ellipse(screenX, centerY + size * 0.7, size * 0.55, size * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawMazeCompass(w, h, dirX, dirY, planeX, planeY, now) {
  if (!mazeCompass || hasCompass || won) return;

  const dx = mazeCompass.x - player.x;
  const dy = mazeCompass.y - player.y;
  const projection = projectPoint(dx, dy, dirX, dirY, planeX, planeY, w);
  if (!projection || projection.depth <= 0.08) return;

  const screenX = projection.screenX;
  const wallHeight = h / projection.depth;
  const radius = clamp(wallHeight * 0.095, 10, h * 0.085);
  if (screenX < -radius * 3 || screenX > w + radius * 3) return;

  const bufferIndex = Math.floor(clamp(screenX, 0, w - 1));
  if (projection.depth >= (zBuffer[bufferIndex] || Infinity) + 0.06) return;

  const centerY = Math.min(h - radius * 1.15, h / 2 + wallHeight * 0.48 - radius * 0.72);
  const bob = Math.sin(now * 0.0045 + mazeCompass.seed) * radius * 0.08;
  const alpha = clamp(1.18 - projection.depth * 0.055, 0.36, 1);
  const y = centerY + bob;

  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.globalCompositeOperation = "lighter";
  const glowRadius = radius * 2.15;
  const glow = ctx.createRadialGradient(screenX, y, 0, screenX, y, glowRadius);
  glow.addColorStop(0, "rgba(126, 224, 195, 0.34)");
  glow.addColorStop(0.42, "rgba(245, 194, 74, 0.15)");
  glow.addColorStop(1, "rgba(126, 224, 195, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(screenX - glowRadius, y - glowRadius, glowRadius * 2, glowRadius * 2);

  ctx.globalCompositeOperation = "source-over";
  ctx.shadowColor = "rgba(255, 211, 95, 0.72)";
  ctx.shadowBlur = radius * 0.35;

  const body = ctx.createRadialGradient(screenX - radius * 0.3, y - radius * 0.35, radius * 0.1, screenX, y, radius);
  body.addColorStop(0, "#fff3b6");
  body.addColorStop(0.38, "#d99b35");
  body.addColorStop(1, "#5b3711");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(screenX, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#2a1a0b";
  ctx.lineWidth = Math.max(2, radius * 0.16);
  ctx.beginPath();
  ctx.arc(screenX, y, radius * 0.82, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#101820";
  ctx.beginPath();
  ctx.arc(screenX, y, radius * 0.58, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = radius * 0.18;
  ctx.fillStyle = "#e74d43";
  ctx.beginPath();
  ctx.moveTo(screenX, y - radius * 0.48);
  ctx.lineTo(screenX + radius * 0.12, y + radius * 0.08);
  ctx.lineTo(screenX, y + radius * 0.16);
  ctx.lineTo(screenX - radius * 0.12, y + radius * 0.08);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#7be0c3";
  ctx.beginPath();
  ctx.moveTo(screenX, y + radius * 0.48);
  ctx.lineTo(screenX + radius * 0.1, y - radius * 0.06);
  ctx.lineTo(screenX, y - radius * 0.14);
  ctx.lineTo(screenX - radius * 0.1, y - radius * 0.06);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#fff1ba";
  ctx.beginPath();
  ctx.arc(screenX, y, Math.max(1.5, radius * 0.12), 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(20, 12, 4, 0.3)";
  ctx.beginPath();
  ctx.ellipse(screenX, centerY + radius * 1.05, radius * 0.82, radius * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
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
  const darkBoost = isDarkLevel() ? 1.58 : 1;
  const alphaBoost = isDarkLevel() ? 1.45 : 1;
  const radius = height * (0.62 + pulse * 0.08) * darkBoost;
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
  glow.addColorStop(0, `rgba(255, 219, 128, ${0.22 * alpha * alphaBoost})`);
  glow.addColorStop(0.22, `rgba(255, 135, 54, ${0.13 * alpha * alphaBoost})`);
  glow.addColorStop(1, "rgba(255, 95, 31, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}

function drawTorchBody(x, y, width, height, alpha) {
  const stem = Math.max(3, width * 0.17);
  const plateW = Math.max(10, width * 0.88);
  const plateH = Math.max(6, height * 0.08);
  const tipY = y - height * 0.28;
  const baseY = y + height * 0.18;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";

  ctx.fillStyle = "rgba(12, 8, 5, 0.28)";
  ctx.beginPath();
  ctx.ellipse(x + width * 0.08, y + height * 0.04, plateW * 0.58, plateH * 1.38, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = stem * 1.55;
  ctx.strokeStyle = "#120b07";
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x, tipY);
  ctx.stroke();

  ctx.lineWidth = stem;
  ctx.strokeStyle = "#5a3520";
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x, tipY);
  ctx.stroke();

  ctx.lineWidth = Math.max(1.4, stem * 0.34);
  ctx.strokeStyle = "rgba(180, 118, 64, 0.78)";
  ctx.beginPath();
  ctx.moveTo(x - stem * 0.22, baseY - height * 0.02);
  ctx.lineTo(x - stem * 0.22, tipY + height * 0.04);
  ctx.stroke();

  ctx.lineWidth = Math.max(3, stem * 0.95);
  ctx.strokeStyle = "#120b07";
  ctx.beginPath();
  ctx.moveTo(x - width * 0.32, y - height * 0.02);
  ctx.lineTo(x + width * 0.32, y - height * 0.02);
  ctx.stroke();

  ctx.lineWidth = Math.max(2, stem * 0.58);
  ctx.strokeStyle = "#7b4d2b";
  ctx.beginPath();
  ctx.moveTo(x - width * 0.3, y - height * 0.025);
  ctx.lineTo(x + width * 0.3, y - height * 0.025);
  ctx.stroke();

  ctx.fillStyle = "#120b07";
  ctx.beginPath();
  ctx.ellipse(x, y + height * 0.02, plateW * 0.55, plateH * 1.18, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#3b2516";
  ctx.beginPath();
  ctx.ellipse(x, y + height * 0.01, plateW * 0.42, plateH * 0.76, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 210, 125, 0.34)";
  ctx.beginPath();
  ctx.ellipse(x - plateW * 0.13, y - plateH * 0.24, plateW * 0.23, plateH * 0.33, 0, 0, Math.PI * 2);
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
  if (!caught && projection.depth >= (zBuffer[Math.max(0, Math.min(w - 1, screenX))] || Infinity) + 0.08) return;

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

function drawRemotePlayer(w, h, dirX, dirY, planeX, planeY, now) {
  if (!remotePlayer || remotePlayer.level !== currentLevel) return;

  const dx = remotePlayer.x - player.x;
  const dy = remotePlayer.y - player.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.22) return;

  const projection = projectPoint(dx, dy, dirX, dirY, planeX, planeY, w);
  if (!projection || projection.depth <= 0.08) return;

  const screenX = projection.screenX;
  if (screenX < -120 || screenX > w + 120) return;
  const bufferIndex = Math.max(0, Math.min(w - 1, screenX));
  if (projection.depth >= (zBuffer[bufferIndex] || Infinity) + 0.06) return;

  const spriteHeight = Math.max(28, Math.min(h * 0.76, h / projection.depth * 0.58));
  const spriteWidth = spriteHeight * 0.34;
  const bob = Math.sin(now * 0.008 + remotePlayer.x * 2.1 + remotePlayer.y) * spriteHeight * 0.008;
  const top = h / 2 - spriteHeight * 0.5 + bob;
  const bottom = h / 2 + spriteHeight * 0.5 + bob;
  const light = worldLightAt(remotePlayer.x, remotePlayer.y);
  const alpha = remotePlayer.caught
    ? 0.46
    : clamp((isDarkLevel() ? 0.48 : 0.7) + light * 0.62, 0.42, 1);

  ctx.save();
  ctx.globalAlpha = alpha * 0.36;
  ctx.globalCompositeOperation = "lighter";
  const aura = ctx.createRadialGradient(
    screenX,
    top + spriteHeight * 0.36,
    0,
    screenX,
    top + spriteHeight * 0.36,
    spriteHeight * 0.42
  );
  aura.addColorStop(0, remotePlayer.caught ? "rgba(255, 74, 74, 0.28)" : "rgba(112, 224, 215, 0.25)");
  aura.addColorStop(1, "rgba(83, 201, 204, 0)");
  ctx.fillStyle = aura;
  ctx.fillRect(
    screenX - spriteHeight * 0.5,
    top - spriteHeight * 0.1,
    spriteHeight,
    spriteHeight * 0.9
  );
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.fillStyle = "rgba(3, 5, 7, 0.42)";
  ctx.beginPath();
  ctx.ellipse(screenX, bottom + spriteHeight * 0.025, spriteWidth * 0.7, spriteHeight * 0.055, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#17252a";
  ctx.lineWidth = Math.max(3, spriteWidth * 0.2);
  ctx.beginPath();
  ctx.moveTo(screenX - spriteWidth * 0.18, top + spriteHeight * 0.64);
  ctx.lineTo(screenX - spriteWidth * 0.24, bottom);
  ctx.moveTo(screenX + spriteWidth * 0.18, top + spriteHeight * 0.64);
  ctx.lineTo(screenX + spriteWidth * 0.24, bottom);
  ctx.stroke();

  ctx.fillStyle = remotePlayer.caught ? "#66363d" : "#315d61";
  ctx.strokeStyle = remotePlayer.caught ? "#9c555d" : "#72c9c5";
  ctx.lineWidth = Math.max(1, spriteWidth * 0.045);
  ctx.beginPath();
  ctx.moveTo(screenX - spriteWidth * 0.42, top + spriteHeight * 0.3);
  ctx.quadraticCurveTo(screenX, top + spriteHeight * 0.2, screenX + spriteWidth * 0.42, top + spriteHeight * 0.3);
  ctx.lineTo(screenX + spriteWidth * 0.3, top + spriteHeight * 0.7);
  ctx.quadraticCurveTo(screenX, top + spriteHeight * 0.78, screenX - spriteWidth * 0.3, top + spriteHeight * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#d4b08c";
  ctx.beginPath();
  ctx.arc(screenX, top + spriteHeight * 0.16, spriteWidth * 0.25, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#182126";
  ctx.beginPath();
  ctx.arc(screenX, top + spriteHeight * 0.12, spriteWidth * 0.27, Math.PI, Math.PI * 2);
  ctx.fill();

  const lampX = screenX + spriteWidth * 0.31;
  const lampY = top + spriteHeight * 0.31;
  ctx.shadowColor = remotePlayer.caught ? "#ff5c63" : "#8ff7df";
  ctx.shadowBlur = Math.max(5, spriteWidth * 0.25);
  ctx.fillStyle = remotePlayer.caught ? "#ff6d72" : "#c8fff0";
  ctx.beginPath();
  ctx.arc(lampX, lampY, Math.max(1.5, spriteWidth * 0.075), 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  if (spriteHeight > 46) {
    ctx.font = `700 ${Math.max(10, Math.min(15, spriteHeight * 0.075))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = remotePlayer.caught ? "#ff9ba0" : "#c8fff0";
    ctx.fillText(remotePlayer.name, screenX, Math.max(18, top - spriteHeight * 0.045));
  }

  ctx.restore();
}

function drawSprites(w, h, dirX, dirY, planeX, planeY) {
  const sprites = [
    { x: entry.x + 0.5, y: entry.y + 0.5, label: "ENTREE", color: "#73b8ff", core: "#d8edff" },
    {
      x: exit.x + 0.5,
      y: exit.y + 0.5,
      label: hasKey ? "SORTIE" : "VERROU",
      color: hasKey ? "#77e5ae" : "#d9a94b",
      core: hasKey ? "#efffde" : "#fff0a8"
    }
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
  gradient.addColorStop(1, isDarkLevel() ? "rgba(0, 0, 0, 0.58)" : "rgba(0, 0, 0, 0.36)");
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
  mapCtx.fillStyle = "#06090d";
  mapCtx.fillRect(0, 0, w, h);

  if (mapRevealTimer <= 0) {
    const veil = mapCtx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.62);
    veil.addColorStop(0, "rgba(37, 49, 58, 0.2)");
    veil.addColorStop(1, "rgba(0, 0, 0, 0.35)");
    mapCtx.fillStyle = veil;
    mapCtx.fillRect(0, 0, w, h);

    mapCtx.strokeStyle = "rgba(255, 242, 187, 0.08)";
    mapCtx.lineWidth = 1;
    mapCtx.beginPath();
    mapCtx.arc(w / 2, h / 2, Math.min(w, h) * 0.27, 0, Math.PI * 2);
    mapCtx.stroke();
    return;
  }

  mapCtx.save();
  mapCtx.globalAlpha = clamp(mapRevealTimer / 0.45, 0, 1);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const tile = maze[y][x];
      if (tile === TILE_TELEPORTER) mapCtx.fillStyle = "#2fc7d7";
      else if (tile === TILE_WALL) mapCtx.fillStyle = "#a7835d";
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

  for (const orb of mapOrbs) {
    mapCtx.fillStyle = "#ff3a3f";
    mapCtx.strokeStyle = "rgba(255, 225, 196, 0.78)";
    mapCtx.lineWidth = Math.max(1, cell * 0.1);
    mapCtx.beginPath();
    mapCtx.arc(ox + orb.x * cell, oy + orb.y * cell, Math.max(2.3, cell * 0.36), 0, Math.PI * 2);
    mapCtx.fill();
    mapCtx.stroke();
  }

  if (mazeKey && !hasKey) {
    mapCtx.fillStyle = "#f5c24a";
    mapCtx.strokeStyle = "rgba(255, 247, 191, 0.86)";
    mapCtx.lineWidth = Math.max(1, cell * 0.11);
    mapCtx.beginPath();
    mapCtx.arc(ox + mazeKey.x * cell, oy + mazeKey.y * cell, Math.max(2.6, cell * 0.4), 0, Math.PI * 2);
    mapCtx.fill();
    mapCtx.stroke();
  }

  if (mazeCompass && !hasCompass) {
    mapCtx.fillStyle = "#7be0c3";
    mapCtx.strokeStyle = "rgba(255, 247, 191, 0.86)";
    mapCtx.lineWidth = Math.max(1, cell * 0.1);
    mapCtx.beginPath();
    mapCtx.arc(ox + mazeCompass.x * cell, oy + mazeCompass.y * cell, Math.max(2.4, cell * 0.38), 0, Math.PI * 2);
    mapCtx.fill();
    mapCtx.stroke();
  }

  if (monster && !won) {
    mapCtx.fillStyle = "#d82e3d";
    mapCtx.beginPath();
    mapCtx.arc(ox + monster.x * cell, oy + monster.y * cell, Math.max(2.2, cell * 0.34), 0, Math.PI * 2);
    mapCtx.fill();
  }

  if (remotePlayer && remotePlayer.level === currentLevel) {
    mapCtx.save();
    mapCtx.translate(ox + remotePlayer.x * cell, oy + remotePlayer.y * cell);
    mapCtx.rotate(remotePlayer.angle);
    mapCtx.fillStyle = remotePlayer.caught ? "#ff7378" : "#72e1d8";
    mapCtx.beginPath();
    mapCtx.moveTo(cell * 0.48, 0);
    mapCtx.lineTo(-cell * 0.3, -cell * 0.25);
    mapCtx.lineTo(-cell * 0.18, 0);
    mapCtx.lineTo(-cell * 0.3, cell * 0.25);
    mapCtx.closePath();
    mapCtx.fill();
    mapCtx.restore();
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
  mapCtx.restore();

  if (mapRevealTimer < 0.75) {
    mapCtx.fillStyle = `rgba(6, 9, 13, ${1 - mapRevealTimer / 0.75})`;
    mapCtx.fillRect(0, 0, w, h);
  }
}

function updateClock(now) {
  const elapsed = Math.max(0, Math.floor((now - startTime) / 1000));
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  timeEl.textContent = `${minutes}:${seconds}`;
}

function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  update(dt);
  broadcastLocalPlayerState(now);
  updateClock(now);
  render(now);
  requestAnimationFrame(loop);
}

function setTouchKey(code, active) {
  if (active) touchKeys.add(code);
  else touchKeys.delete(code);
}

function isGameKey(code) {
  return code.startsWith("Arrow") || code === "AltLeft" || code === "AltRight";
}

window.addEventListener("resize", resize);
window.addEventListener("pointerdown", ensureAudio, { once: true });
window.addEventListener("click", ensureAudio, { once: true });

window.addEventListener("keydown", (event) => {
  ensureAudio();
  if (!isGameKey(event.code)) return;
  event.preventDefault();
  keys.add(event.code);
});

window.addEventListener("keyup", (event) => {
  if (!isGameKey(event.code)) return;
  event.preventDefault();
  keys.delete(event.code);
});

window.addEventListener("blur", () => {
  keys.clear();
  touchKeys.clear();
});

window.addEventListener("laby:room-state", (event) => {
  applyMultiplayerRoomState(event.detail);
});

window.addEventListener("laby:room-left", () => {
  leaveMultiplayerSession();
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
