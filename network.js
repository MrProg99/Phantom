import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  browserSessionPersistence,
  getAuth,
  setPersistence,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  get,
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  remove,
  runTransaction,
  set
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAuElAppa0s6yhxffFvs0zkp_RQWcJ--Xw",
  authDomain: "serveur-laby.firebaseapp.com",
  databaseURL: "https://serveur-laby-default-rtdb.firebaseio.com",
  projectId: "serveur-laby",
  storageBucket: "serveur-laby.firebasestorage.app",
  messagingSenderId: "74302043834",
  appId: "1:74302043834:web:3445b918d6e68298d97483",
  measurementId: "G-BV72N08DYJ"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

const networkOpenButton = document.getElementById("network-open");
const networkCloseButton = document.getElementById("network-close");
const networkDialog = document.getElementById("network-dialog");
const networkStateEl = document.getElementById("network-state");
const networkMessageEl = document.getElementById("network-message");
const networkLobbyEl = document.getElementById("network-lobby");
const networkRoomEl = document.getElementById("network-room");
const createRoomButton = document.getElementById("create-room");
const joinRoomForm = document.getElementById("join-room-form");
const roomCodeInput = document.getElementById("room-code-input");
const roomCodeEl = document.getElementById("room-code");
const roomPlayerCountEl = document.getElementById("room-player-count");
const copyRoomCodeButton = document.getElementById("copy-room-code");
const leaveRoomButton = document.getElementById("leave-room");

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let currentRoomCode = "";
let currentPlayerRef = null;
let disconnectRegistration = null;
let hostMetaDisconnectRegistration = null;
let stopRoomListener = null;
let localPlayerIsHost = false;
let busy = false;

function setMessage(message, isError = false) {
  networkMessageEl.textContent = message;
  networkMessageEl.classList.toggle("is-error", isError);
}

function setBusy(nextBusy) {
  busy = nextBusy;
  createRoomButton.disabled = nextBusy;
  joinRoomForm.querySelector("button").disabled = nextBusy;
  roomCodeInput.disabled = nextBusy;
}

function openDialog() {
  networkDialog.hidden = false;
  if (!currentRoomCode) roomCodeInput.focus();
}

function closeDialog() {
  networkDialog.hidden = true;
  networkOpenButton.focus();
}

function generateRoomCode() {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function normalizeRoomCode(value) {
  return value
    .toUpperCase()
    .split("")
    .filter((character) => ROOM_CODE_CHARS.includes(character))
    .join("")
    .slice(0, ROOM_CODE_LENGTH);
}

async function getSignedInUser() {
  await setPersistence(auth, browserSessionPersistence);
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}

function updateRoomUi(code, playerCount) {
  currentRoomCode = code;
  roomCodeEl.textContent = code;
  roomPlayerCountEl.textContent = `${playerCount} joueur${playerCount > 1 ? "s" : ""} sur 2`;
  networkStateEl.textContent = playerCount > 1 ? `Salon ${code}` : `Attente ${code}`;
  networkOpenButton.classList.add("is-online");
  networkLobbyEl.hidden = true;
  networkRoomEl.hidden = false;
  setMessage(playerCount > 1 ? "Les deux joueurs sont connectes" : "En attente du deuxieme joueur");
}

function resetRoomUi(message = "Mode solo") {
  currentRoomCode = "";
  currentPlayerRef = null;
  disconnectRegistration = null;
  hostMetaDisconnectRegistration = null;
  localPlayerIsHost = false;
  networkStateEl.textContent = "Solo";
  networkOpenButton.classList.remove("is-online");
  networkLobbyEl.hidden = false;
  networkRoomEl.hidden = true;
  roomCodeInput.value = "";
  setMessage(message);
}

function publishRoomState(room) {
  const playerSlots = room?.players || {};
  const players = Object.values(playerSlots).reduce((result, playerData) => {
    if (playerData?.uid) result[playerData.uid] = playerData;
    return result;
  }, {});

  window.dispatchEvent(new CustomEvent("laby:room-state", {
    detail: {
      code: currentRoomCode,
      hostId: room?.meta?.hostId || "",
      localPlayerId: auth.currentUser?.uid || "",
      players
    }
  }));
}

function watchRoom(code, userId) {
  if (stopRoomListener) stopRoomListener();

  stopRoomListener = onValue(ref(database, `rooms/${code}`), (snapshot) => {
    const room = snapshot.val();
    const playerSlots = Object.values(room?.players || {});
    const localPlayerExists = playerSlots.some((playerData) => playerData?.uid === userId);

    if (!room?.meta || !localPlayerExists) {
      if (currentRoomCode === code) {
        stopRoomListener?.();
        stopRoomListener = null;
        cleanupClosedRoom();
      }
      return;
    }

    const playerCount = playerSlots.length;
    updateRoomUi(code, playerCount);
    publishRoomState(room);
  }, () => {
    resetRoomUi("Connexion au salon perdue");
  });
}

async function cleanupClosedRoom() {
  const playerRef = currentPlayerRef;
  const playerDisconnect = disconnectRegistration;
  const metaDisconnect = hostMetaDisconnectRegistration;

  try {
    await playerDisconnect?.cancel();
    await metaDisconnect?.cancel();
    if (playerRef) await remove(playerRef);
  } catch {
    // The room may already be unavailable; local cleanup still has to continue.
  }

  resetRoomUi("Le salon a ete ferme");
}

async function enterRoom(code, isHost) {
  const user = await getSignedInUser();
  const metaRef = ref(database, `rooms/${code}/meta`);
  const slot = isHost ? "host" : "guest";
  const playerRef = ref(database, `rooms/${code}/players/${slot}`);
  const playerData = {
    uid: user.uid,
    name: isHost ? "Joueur 1" : "Joueur 2",
    joinedAt: Date.now()
  };

  if (isHost) {
    await set(playerRef, playerData);
  } else {
    const transaction = await runTransaction(playerRef, (currentPlayer) => {
      if (currentPlayer && currentPlayer.uid !== user.uid) return undefined;
      return playerData;
    }, { applyLocally: false });

    if (!transaction.committed) throw new Error("Ce salon est deja complet");
  }

  currentPlayerRef = playerRef;
  localPlayerIsHost = isHost;
  disconnectRegistration = onDisconnect(playerRef);
  await disconnectRegistration.remove();

  if (isHost) {
    hostMetaDisconnectRegistration = onDisconnect(metaRef);
    await hostMetaDisconnectRegistration.remove();
  }

  watchRoom(code, user.uid);
}

async function createRoom() {
  setBusy(true);
  setMessage("Creation du salon...");

  try {
    const user = await getSignedInUser();
    let roomCode = "";

    for (let attempt = 0; attempt < 8 && !roomCode; attempt += 1) {
      const candidate = generateRoomCode();
      const metaRef = ref(database, `rooms/${candidate}/meta`);
      const transaction = await runTransaction(metaRef, (currentMeta) => {
        if (currentMeta) return undefined;
        return {
          hostId: user.uid,
          createdAt: Date.now(),
          version: 1
        };
      }, { applyLocally: false });

      if (transaction.committed) roomCode = candidate;
    }

    if (!roomCode) throw new Error("Impossible de creer un code de salon");
    await enterRoom(roomCode, true);
  } catch (error) {
    setMessage(firebaseErrorMessage(error), true);
  } finally {
    setBusy(false);
  }
}

async function joinRoom(code) {
  setBusy(true);
  setMessage("Connexion au salon...");

  try {
    const normalizedCode = normalizeRoomCode(code);
    if (normalizedCode.length !== ROOM_CODE_LENGTH) {
      throw new Error("Le code doit contenir 6 caracteres");
    }

    await getSignedInUser();
    const metaSnapshot = await get(ref(database, `rooms/${normalizedCode}/meta`));
    if (!metaSnapshot.exists()) throw new Error("Salon introuvable");
    await enterRoom(normalizedCode, false);
  } catch (error) {
    setMessage(firebaseErrorMessage(error), true);
  } finally {
    setBusy(false);
  }
}

async function leaveRoom() {
  if (!currentRoomCode || !currentPlayerRef) {
    resetRoomUi();
    return;
  }

  leaveRoomButton.disabled = true;
  const roomCode = currentRoomCode;
  const playerRef = currentPlayerRef;
  const isHost = localPlayerIsHost;
  try {
    await disconnectRegistration?.cancel();
    await hostMetaDisconnectRegistration?.cancel();
    await remove(playerRef);
    if (isHost) await remove(ref(database, `rooms/${roomCode}/meta`));
  } catch {
    setMessage("Impossible de quitter proprement le salon", true);
  } finally {
    stopRoomListener?.();
    stopRoomListener = null;
    leaveRoomButton.disabled = false;
    resetRoomUi();
  }
}

function firebaseErrorMessage(error) {
  const code = error?.code || "";
  if (code.includes("permission-denied")) return "Acces refuse: verifie les regles Firebase";
  if (code.includes("operation-not-allowed")) return "Active l'authentification anonyme dans Firebase";
  if (code.includes("network-request-failed")) return "Firebase est inaccessible pour le moment";
  return error?.message || "La connexion Firebase a echoue";
}

networkOpenButton.addEventListener("click", openDialog);
networkCloseButton.addEventListener("click", closeDialog);
createRoomButton.addEventListener("click", createRoom);
leaveRoomButton.addEventListener("click", leaveRoom);

joinRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!busy) joinRoom(roomCodeInput.value);
});

roomCodeInput.addEventListener("input", () => {
  const normalized = normalizeRoomCode(roomCodeInput.value);
  if (roomCodeInput.value !== normalized) roomCodeInput.value = normalized;
});

copyRoomCodeButton.addEventListener("click", async () => {
  if (!currentRoomCode) return;
  try {
    await navigator.clipboard.writeText(currentRoomCode);
    setMessage("Code copie");
  } catch {
    setMessage(`Code: ${currentRoomCode}`);
  }
});

networkDialog.addEventListener("click", (event) => {
  if (event.target === networkDialog) closeDialog();
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && !networkDialog.hidden) closeDialog();
});

window.addEventListener("beforeunload", () => {
  if (currentPlayerRef) remove(currentPlayerRef);
});
