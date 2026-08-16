// ============ CONFIG ============
// Point this at your backend. Update after you deploy (e.g. https://your-app.onrender.com)
const API_BASE = "http://localhost:8000";

// ============ STATE ============
let token = localStorage.getItem("owlest_token") || null;
let currentUser = null;
let playlists = [];
let currentSong = null;
let pendingAddSong = null; // song waiting to be added to a playlist via picker
let isAdPlaying = false;
let pendingPlayRequest = null; // a song object, queued while an ad is playing
let currentAdMedia = null; // the <video>/<audio> element currently playing an ad, if any

// ============ DOM ============
const $ = (id) => document.getElementById(id);
const authView = $("auth-view");
const appView = $("app-view");
const audio = $("audio");
const playerBar = $("player-bar");

// ============ API HELPER ============
async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    // token invalid/expired — send back to login
    logout();
    throw new Error("Session expired, please log in again");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || `Request failed (${res.status})`);
  }
  return data;
}

// ============ AUTH ============
async function checkSession() {
  // Password reset link: #reset=<token>
  if (location.hash.startsWith("#reset=")) {
    resetToken = decodeURIComponent(location.hash.slice(7));
    history.replaceState(null, "", location.pathname);
    showAuth();
    showAuthForm("reset-form");
    return;
  }

  // Email verify link: #verify=<token>
  if (location.hash.startsWith("#verify=")) {
    const verifyToken = decodeURIComponent(location.hash.slice(8));
    history.replaceState(null, "", location.pathname);
    showAuth();
    try {
      await api(`/auth/verify-email?token=${encodeURIComponent(verifyToken)}`, { method: "GET", auth: false });
      showAuthForm("login-form");
      $("login-error").textContent = "";
      showToastEarly("Email verified — you can log in now.");
    } catch {
      showAuthForm("login-form");
      $("login-error").textContent = "That verification link is invalid or expired. Try resending it from the login form.";
    }
    return;
  }

  // Google OAuth redirects back with #token=... in the URL hash
  if (location.hash.startsWith("#token=")) {
    token = decodeURIComponent(location.hash.slice(7));
    localStorage.setItem("owlest_token", token);
    history.replaceState(null, "", location.pathname);
  }

  if (!token) return showAuth();

  try {
    currentUser = await api("/auth/me");
    await enterApp();
  } catch {
    showAuth();
  }
}

// Toast element doesn't exist yet this early (auth screen, before app view
// is entered) — a tiny inline version that just reuses the same toast div.
function showToastEarly(message) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 3500);
}

function showAuth() {
  authView.style.display = "flex";
  appView.classList.remove("active");
}

async function enterApp() {
  authView.style.display = "none";
  appView.classList.add("active");
  $("profile-name").textContent = currentUser.name;
  renderProfileView();
  document.querySelector(".admin-only").classList.toggle("hidden", currentUser.role !== "admin");

  if (!currentUser.has_onboarded) {
    // Full-screen onboarding shows first — Home content loads only after
    // it's completed or skipped, so the person never sees a half-loaded
    // home page flash by underneath it.
    openOnboarding();
    return;
  }

  await enterHome();
}

async function enterHome() {
  await loadPlaylists();
  await loadHome();
  restoreLastSong();
}

function restoreLastSong() {
  if (currentSong) return; // already playing something this session
  const saved = localStorage.getItem("owlest_last_song");
  if (!saved) return;
  try {
    const song = JSON.parse(saved);
    currentSong = song;
    updatePlayerUI(song); // shows title/art/etc — audio.src stays empty until they hit play
  } catch {
    localStorage.removeItem("owlest_last_song");
  }
}

function renderProfileView() {
  $("profile-view-name").textContent = currentUser.name;
  $("profile-view-email").textContent = currentUser.email;
  $("profile-avatar").textContent = currentUser.name.charAt(0);
  $("edit-name-input").value = currentUser.name;
  const badge = $("profile-verified-badge");
  if (currentUser.is_verified) {
    badge.textContent = "✓ Verified";
    badge.className = "profile-badge verified";
    $("profile-resend-btn").classList.add("hidden");
  } else {
    badge.textContent = "Not verified";
    badge.className = "profile-badge unverified";
    $("profile-resend-btn").classList.remove("hidden");
  }

  // Google accounts have no password to change
  $("change-password-section").classList.toggle("hidden", currentUser.auth_provider === "google");

  if (currentUser.created_at) {
    const joined = new Date(currentUser.created_at);
    $("profile-member-since").textContent = `Member since ${joined.toLocaleDateString(undefined, { year: "numeric", month: "long" })}`;
  }

  api("/profile/stats")
    .then((stats) => {
      const hrs = Math.floor(stats.total_playtime_seconds / 3600);
      const mins = Math.floor((stats.total_playtime_seconds % 3600) / 60);
      $("stat-playtime").textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
      $("stat-songs").textContent = stats.songs_played;
    })
    .catch(() => {
      $("stat-playtime").textContent = "—";
      $("stat-songs").textContent = "—";
    });
}

function logout() {
  api("/auth/logout").catch(() => {});
  token = null;
  currentUser = null;
  localStorage.removeItem("owlest_token");
  audio.pause();
  document.querySelector(".admin-only").classList.add("hidden");
  showAuth();
}

let resetToken = null; // holds the token when the reset-password form is active

// Auth tab switching
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    showAuthForm(`${tab.dataset.tab}-form`, false);
  });
});

// showAuthForm is the single place that switches which auth-card form is
// visible. Google sign-in only makes sense on login/signup — every other
// screen (forgot/reset/pending-verification) hides it.
function showAuthForm(id, syncTabs = true) {
  document.querySelectorAll(".auth-form").forEach((f) => f.classList.remove("active"));
  $(id).classList.add("active");

  const showGoogle = id === "login-form" || id === "signup-form";
  $("auth-divider").classList.toggle("hidden", !showGoogle);
  $("google-login-btn").classList.toggle("hidden", !showGoogle);
  $("auth-tabs").classList.toggle("hidden", !showGoogle);

  if (syncTabs) {
    document.querySelectorAll(".auth-tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === "login" && id === "login-form")
    );
  }
}

$("forgot-link").addEventListener("click", () => showAuthForm("forgot-form"));
$("back-to-login-link").addEventListener("click", () => showAuthForm("login-form"));

$("forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("forgot-error").textContent = "";
  $("forgot-success").textContent = "";
  try {
    const data = await api("/auth/forgot-password", {
      method: "POST",
      auth: false,
      body: { email: $("forgot-email").value },
    });
    $("forgot-success").textContent = data.dev_reset_url
      ? `Dev mode (no email configured) — reset link: ${data.dev_reset_url}`
      : data.detail;
  } catch (err) {
    $("forgot-error").textContent = err.message;
  }
});

$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("reset-error").textContent = "";
  try {
    await api("/auth/reset-password", {
      method: "POST",
      auth: false,
      body: { token: resetToken, new_password: $("reset-password").value },
    });
    showToastEarly("Password updated — you can log in now.");
    showAuthForm("login-form");
  } catch (err) {
    $("reset-error").textContent = err.message;
  }
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  $("login-resend-hint").classList.add("hidden");
  const email = $("login-email").value;
  try {
    const data = await api("/auth/login", {
      method: "POST",
      auth: false,
      body: { email, password: $("login-password").value },
    });
    token = data.access_token;
    currentUser = data.user;
    localStorage.setItem("owlest_token", token);
    await enterApp();
  } catch (err) {
    $("login-error").textContent = err.message;
    if (/verify/i.test(err.message)) {
      $("login-resend-hint").classList.remove("hidden");
      $("login-resend-btn").dataset.email = email;
    }
  }
});

$("login-resend-btn").addEventListener("click", async (e) => {
  const email = e.target.dataset.email;
  try {
    const data = await api("/auth/resend-verification-by-email", {
      method: "POST", auth: false, body: { email },
    });
    showToastEarly(data.dev_verify_url ? `Dev mode — verify link: ${data.dev_verify_url}` : data.detail);
  } catch (err) {
    showToastEarly(err.message);
  }
});

$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("signup-error").textContent = "";
  try {
    const data = await api("/auth/signup", {
      method: "POST",
      auth: false,
      body: {
        name: $("signup-name").value,
        email: $("signup-email").value,
        password: $("signup-password").value,
      },
    });
    showPendingVerification(data);
  } catch (err) {
    $("signup-error").textContent = err.message;
  }
});

function showPendingVerification(data) {
  showAuthForm("pending-verification");
  $("pending-verify-text").textContent = `We sent a verification link to ${data.email}. Confirm it, then log in. please check also spam mail. please also check spam mail.`;
  $("pending-dev-link").textContent = data.dev_verify_url
    ? `Dev mode (no email configured) — verify link: ${data.dev_verify_url}`
    : "";
  $("pending-resend-btn").dataset.email = data.email;
}

$("pending-resend-btn").addEventListener("click", async (e) => {
  const email = e.target.dataset.email;
  try {
    const data = await api("/auth/resend-verification-by-email", {
      method: "POST", auth: false, body: { email },
    });
    $("pending-dev-link").textContent = data.dev_verify_url
      ? `Dev mode — verify link: ${data.dev_verify_url}`
      : data.detail;
  } catch (err) {
    showToastEarly(err.message);
  }
});

$("pending-back-btn").addEventListener("click", () => showAuthForm("login-form"));

$("google-login-btn").addEventListener("click", () => {
  window.location.href = `${API_BASE}/auth/google`;
});

$("logout-btn").addEventListener("click", logout);
$("profile-logout-btn").addEventListener("click", logout);

$("change-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("change-password-error").textContent = "";
  $("change-password-success").textContent = "";
  try {
    await api("/auth/change-password", {
      method: "POST",
      body: {
        current_password: $("current-password").value,
        new_password: $("new-password").value,
      },
    });
    $("change-password-success").textContent = "Password updated.";
    e.target.reset();
  } catch (err) {
    $("change-password-error").textContent = err.message;
  }
});

$("edit-name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("edit-name-error").textContent = "";
  $("edit-name-success").textContent = "";
  try {
    const data = await api("/auth/name", {
      method: "PUT",
      body: { name: $("edit-name-input").value.trim() },
    });
    currentUser.name = data.name;
    $("profile-name").textContent = data.name;
    $("profile-view-name").textContent = data.name;
    $("profile-avatar").textContent = data.name.charAt(0);
    $("edit-name-success").textContent = "Saved.";
  } catch (err) {
    $("edit-name-error").textContent = err.message;
  }
});

$("toggle-edit-name-btn").addEventListener("click", () => {
  $("edit-name-form").classList.toggle("active");
});
$("toggle-change-password-btn").addEventListener("click", () => {
  $("change-password-form").classList.toggle("active");
});

$("profile-resend-btn").addEventListener("click", async () => {
  try {
    const data = await api("/auth/resend-verification", { method: "POST" });
    showToast(data.dev_verify_url ? `Dev mode — verify link: ${data.dev_verify_url}` : data.detail);
  } catch (err) {
    showToast(err.message);
  }
});

$("profile-btn").addEventListener("click", () => switchView("profile"));

$("legal-link").addEventListener("click", () => switchView("legal"));
$("legal-back-btn").addEventListener("click", () => switchView("profile"));
document.querySelectorAll(".legal-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".legal-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".legal-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    $(`legal-${tab.dataset.legal}`).classList.add("active");
  });
});

// ============ NAV ============
document.querySelectorAll(".nav-link, .bottom-nav-btn").forEach((link) => {
  link.addEventListener("click", () => {
    switchView(link.dataset.view);
    closeSidebar();
  });
});

function switchView(name) {
  document.querySelectorAll(".nav-link, .bottom-nav-btn").forEach((l) =>
    l.classList.toggle("active", l.dataset.view === name)
  );
  document.querySelectorAll(".view-panel").forEach((v) => v.classList.remove("active"));
  $(`view-${name}`).classList.add("active");
  if (name === "admin") loadAdmin();
  if (name === "profile") renderProfileView();
  if (name === "search" && !$("search-input").value.trim()) {
    renderSearchHistory();
    $("search-hint").classList.toggle("hidden", getSearchHistory().length > 0);
  }
}

// Mobile sidebar drawer
function openSidebar() {
  $("sidebar").classList.add("open");
  $("sidebar-backdrop").classList.remove("hidden");
}
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-backdrop").classList.add("hidden");
}
$("hamburger-btn").addEventListener("click", openSidebar);
$("sidebar-backdrop").addEventListener("click", closeSidebar);

// ============ SEARCH ============
const SEARCH_HISTORY_KEY = "owlest_search_history";
const SEARCH_HISTORY_MAX = 8;

function getSearchHistory() {
  try {
    return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function addToSearchHistory(query) {
  let history = getSearchHistory().filter((q) => q.toLowerCase() !== query.toLowerCase());
  history.unshift(query);
  if (history.length > SEARCH_HISTORY_MAX) history = history.slice(0, SEARCH_HISTORY_MAX);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
}

function renderSearchHistory() {
  const history = getSearchHistory();
  const container = $("search-history");
  if (history.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML =
    `<h2 class="home-section-title">Recent searches</h2><div class="chip-row">` +
    history.map((q) => `<button class="chip search-history-chip">${escapeHtml(q)}</button>`).join("") +
    `</div>`;
  container.querySelectorAll(".search-history-chip").forEach((chip, i) => {
    chip.addEventListener("click", () => {
      const q = history[i];
      $("search-input").value = q;
      $("search-clear-btn").classList.remove("hidden");
      $("search-history").innerHTML = "";
      $("search-hint").classList.add("hidden");
      runSearch(q);
    });
  });
}

let searchDebounce;
$("search-input").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  $("search-clear-btn").classList.toggle("hidden", !q);
  switchView("search"); // typing anywhere jumps to the Search page, Spotify-style

  if (!q) {
    $("results-list").innerHTML = "";
    renderSearchHistory();
    $("search-hint").classList.toggle("hidden", getSearchHistory().length > 0);
    return;
  }
  $("search-history").innerHTML = "";
  $("search-hint").classList.add("hidden");
  searchDebounce = setTimeout(() => runSearch(q), 400);
});

$("search-clear-btn").addEventListener("click", () => {
  $("search-input").value = "";
  $("search-clear-btn").classList.add("hidden");
  $("results-list").innerHTML = "";
  renderSearchHistory();
  $("search-hint").classList.toggle("hidden", getSearchHistory().length > 0);
  $("search-input").focus();
});

async function runSearch(q) {
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}&limit=20`, { auth: false });
    renderSongList($("results-list"), data.results);
    addToSearchHistory(q);
  } catch (err) {
    $("results-list").innerHTML = `<li class="hint">Search failed: ${err.message}</li>`;
  }
}

async function loadHome() {
  try {
    const data = await api("/home");
    renderHomeSections(data);
  } catch (err) {
    console.error("Failed to load home feed", err);
  }
}

function renderHomeSections(data) {
  const container = $("home-sections");
  container.innerHTML = "";

  const sections = [
    { title: "Recommended for you", songs: data.recommended },
    ...(data.featured_playlists || []).map((p) => ({ title: p.name, songs: p.songs })),
    { title: "Trending Now", songs: data.trending },
    ...Object.entries(data.genres || {}).map(([name, songs]) => ({ title: name, songs })),
  ];

  sections.forEach((section) => {
    if (!section.songs || section.songs.length === 0) return;
    const block = document.createElement("div");
    block.className = "home-section";
    const heading = document.createElement("h2");
    heading.className = "home-section-title";
    heading.textContent = section.title;
    block.appendChild(heading);
    const row = document.createElement("ul");
    row.className = "card-row";
    block.appendChild(row);
    renderCardGrid(row, section.songs);
    container.appendChild(block);
  });

  if (sections.every((s) => !s.songs || s.songs.length === 0)) {
    container.innerHTML = `<p class="hint">Nothing to show yet — try searching for something!</p>`;
  }
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function renderSongList(container, songs, options = {}) {
  container.innerHTML = "";
  songs.forEach((song, i) => {
    const li = document.createElement("li");
    li.className = "song-row playable-item";
    li.dataset.ytId = song.yt_id;
    if (currentSong && currentSong.yt_id === song.yt_id) li.classList.add("now-playing");
    if (loadingYtId === song.yt_id) li.classList.add("loading");
    const actionBtn = options.removable
      ? `<button class="song-remove-btn" title="Remove from playlist">×</button>`
      : `<button class="song-add-btn" title="Add to playlist">＋</button>`;
    li.innerHTML = `
      <img class="song-thumb" src="${song.thumbnail || ""}" alt="" loading="lazy" />
      <div class="song-info">
        <span class="song-title">${escapeHtml(song.title)}</span>
        <span class="song-artist">${escapeHtml(song.artist || "")}</span>
      </div>
      <span class="song-duration">${formatDuration(song.duration)}</span>
      ${actionBtn}
    `;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".song-add-btn, .song-remove-btn")) return;
      playFromList(songs, i, { isPlaylistContext: !!options.removable });
    });
    if (options.removable) {
      li.querySelector(".song-remove-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        removeSongFromPlaylist(options.playlistId, song.yt_id);
      });
    } else {
      li.querySelector(".song-add-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        openPlaylistPicker(song, e.currentTarget);
      });
    }
    container.appendChild(li);
  });
}

// Album-style card grid — used for the Recommended section on Home
function renderCardGrid(container, songs) {
  container.innerHTML = "";
  songs.forEach((song, i) => {
    const card = document.createElement("li");
    card.className = "song-card playable-item";
    card.dataset.ytId = song.yt_id;
    if (currentSong && currentSong.yt_id === song.yt_id) card.classList.add("now-playing");
    if (loadingYtId === song.yt_id) card.classList.add("loading");
    card.innerHTML = `
      <div class="song-card-art-wrap">
        <img class="song-card-art" src="${song.thumbnail || ""}" alt="" loading="lazy" />
        <span class="song-card-play">▶</span>
        <button class="song-card-add" title="Add to playlist">＋</button>
      </div>
      <span class="song-card-title">${escapeHtml(song.title)}</span>
      <span class="song-card-artist">${escapeHtml(song.artist || "")}</span>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".song-card-add")) return;
      playFromList(songs, i);
    });
    card.querySelector(".song-card-add").addEventListener("click", (e) => {
      e.stopPropagation();
      openPlaylistPicker(song, e.currentTarget);
    });
    container.appendChild(card);
  });
}

// Called after any play/loading-state change so every currently-rendered
// list (search results, recommended cards, library) reflects it immediately.
function updateSongRowStates() {
  document.querySelectorAll(".playable-item").forEach((row) => {
    row.classList.toggle("now-playing", !!currentSong && row.dataset.ytId === currentSong.yt_id);
    row.classList.toggle("loading", !!loadingYtId && row.dataset.ytId === loadingYtId);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ============ PLAYBACK ============
let playHistory = []; // stack of previously played songs, for the Previous button
let loadingYtId = null;

// When playing from a playlist, "next"/"prev" walk sequentially through
// that playlist's own tracklist — not the similar-songs discovery chain
// used everywhere else (search/recommended/trending). Falls back to
// discovery mode once the playlist runs out.
let activeQueue = null;      // the playlist's song array, or null when not in playlist mode
let activeQueueIndex = -1;

// Pre-fetch buffer: while a song plays, 2 similar tracks get resolved
// (stream URL and all) in the background, so hitting "next" is instant
// instead of waiting on two API calls every single time. Only used in
// discovery mode — irrelevant (and skipped) while activeQueue is set.
const UPNEXT_TARGET = 2;
let upNextQueue = []; // [{ song, streamUrl }]
let isRefillingQueue = false;

async function playFromList(list, index, options = {}) {
  const song = list[index];
  if (isAdPlaying) {
    pendingPlayRequest = song;
    showToast("Ad playing — your song starts right after");
    return;
  }
  if (currentSong) pushHistory(currentSong);
  upNextQueue = []; // a manual pick breaks whatever auto-similar chain was building

  if (options.isPlaylistContext) {
    activeQueue = list;
    activeQueueIndex = index;
  } else {
    activeQueue = null;
    activeQueueIndex = -1;
  }

  await playSong(song);
}

let playRequestId = 0;

async function playSong(song, preResolvedStreamUrl = null, isRetry = false) {
  const requestId = ++playRequestId;
  loadingYtId = song.yt_id;
  updateSongRowStates();
  // Immediate feedback in the player bar so a slow extraction doesn't feel like nothing happened
  $("player-title").textContent = song.title;
  $("player-artist").textContent = preResolvedStreamUrl ? (song.artist || "") : "Loading…";

  try {
    const streamUrl = preResolvedStreamUrl || (await api(`/stream/${song.yt_id}`)).stream_url;
    if (requestId !== playRequestId) return; // superseded by a newer click

    currentSong = song;
    audio.pause();
    audio.src = streamUrl;
    localStorage.setItem("owlest_last_song", JSON.stringify(song));

    try {
      await audio.play();
    } catch (err) {
      if (err.name === "AbortError") return; // superseded mid-play, ignore quietly
      throw err;
    }
    if (requestId !== playRequestId) return;

    updatePlayerUI(song);
    setPlayingUI(true);
    loadHome(); // fire-and-forget — reflects this new play shortly
    refillUpNextQueue(); // fire-and-forget — top up the buffer for a fast "next"
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("Playback error:", err);

    if (requestId !== playRequestId) return; // a newer click already took over

    if (!isRetry) {
      // The prefetched URL might just be stale — try once more with a
      // guaranteed-fresh one before giving up on this track.
      return playSong(song, null, true);
    }
    // Still failing even with a fresh URL — this track is genuinely
    // unavailable. Skip forward silently instead of leaving playback dead.
    console.warn(`Skipping unplayable track: ${song.title}`);
    playNext();
  } finally {
    if (loadingYtId === song.yt_id) loadingYtId = null;
    updateSongRowStates();
  }
}

function updatePlayerUI(song) {
  $("player-thumb").src = song.thumbnail || "";
  $("player-title").textContent = song.title;
  $("player-artist").textContent = song.artist || "";
  $("np-art").src = song.thumbnail || "";
  $("np-backdrop").src = song.thumbnail || "";
  $("np-title").textContent = song.title;
  $("np-artist").textContent = song.artist || "";
  updateSongRowStates();

  // Powers OS notification / lock-screen media controls, and shows the
  // current track there (Android, Windows, macOS all support this).
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist || "OWLEST Music",
      album: "OWLEST Music",
      artwork: song.thumbnail
        ? [
            { src: song.thumbnail, sizes: "96x96", type: "image/jpeg" },
            { src: song.thumbnail, sizes: "512x512", type: "image/jpeg" },
          ]
        : [],
    });
  }
}

function setPlayingUI(isPlaying) {
  playerBar.classList.toggle("playing", isPlaying);
  $("owl-eyes").classList.toggle("playing", isPlaying);
  $("np-owl-eyes").classList.toggle("playing", isPlaying);
  $("play-pause-btn").textContent = isPlaying ? "⏸" : "▶";
  $("np-play-pause-btn").textContent = isPlaying ? "⏸" : "▶";

  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }
  if (isPlaying) requestWakeLock(); else releaseWakeLock();
}

function togglePlayPause() {
  if (isAdPlaying || !currentSong) return;
  if (!audio.src) {
    // Restored from a previous session — nothing loaded yet, fetch it now
    playSong(currentSong);
    return;
  }
  if (audio.paused) {
    audio.play();
    setPlayingUI(true);
  } else {
    audio.pause();
    setPlayingUI(false);
  }
}
$("play-pause-btn").addEventListener("click", togglePlayPause);
$("np-play-pause-btn").addEventListener("click", togglePlayPause);

function handleNext() {
  if (isAdPlaying) {
    showToast("Ad playing — please wait");
    return;
  }
  playNext();
}
function handlePrev() {
  if (isAdPlaying) {
    showToast("Ad playing — please wait");
    return;
  }
  if (activeQueue && activeQueueIndex > 0) {
    activeQueueIndex--;
    playSong(activeQueue[activeQueueIndex]);
    return;
  }
  const prev = playHistory.pop();
  if (prev) playSong(prev);
}
$("next-btn").addEventListener("click", handleNext);
$("prev-btn").addEventListener("click", handlePrev);
$("np-next-btn").addEventListener("click", handleNext);
$("np-prev-btn").addEventListener("click", handlePrev);

// "Next" doesn't cycle through whatever static list you clicked from —
// searching for one song often returns a handful of near-duplicates.
// Instead it pulls something similar to what's currently playing, so
// listening never dead-ends and doesn't just repeat the search results.
function getUsedIds() {
  const ids = new Set();
  if (currentSong) ids.add(currentSong.yt_id);
  playHistory.forEach((s) => ids.add(s.yt_id));
  upNextQueue.forEach((q) => ids.add(q.song.yt_id));
  return ids;
}

function pushHistory(song) {
  playHistory.push(song);
  if (playHistory.length > 50) playHistory.shift(); // keep it bounded over long sessions
}

async function fetchSimilar(song, excludeIds = null) {
  try {
    const params = new URLSearchParams({
      artist: song.artist || "",
      title: song.title || "",
      exclude: song.yt_id,
      limit: "20",
    });
    const data = await api(`/similar?${params.toString()}`);
    const results = data.results || [];
    return excludeIds ? results.filter((r) => r.yt_id && !excludeIds.has(r.yt_id)) : results;
  } catch {
    return [];
  }
}

async function playNext() {
  if (!currentSong) return;

  if (activeQueue) {
    if (activeQueueIndex + 1 < activeQueue.length) {
      activeQueueIndex++;
      pushHistory(currentSong);
      await playSong(activeQueue[activeQueueIndex]);
      return;
    }
    // Reached the end of the playlist — drop into discovery mode from here
    activeQueue = null;
    activeQueueIndex = -1;
  }

  if (upNextQueue.length > 0) {
    const next = upNextQueue.shift();
    pushHistory(currentSong);
    await playSong(next.song, next.streamUrl); // instant — already resolved
    refillUpNextQueue();
    return;
  }

  // Buffer was empty (e.g. right after the very first play, before
  // prefetching had a chance to finish) — fall back to fetching live,
  // still filtered against everything already played this session.
  const similar = await fetchSimilar(currentSong, getUsedIds());
  if (similar.length > 0) {
    pushHistory(currentSong);
    await playSong(similar[Math.floor(Math.random() * Math.min(3, similar.length))]);
  } else {
    setPlayingUI(false);
  }
}

async function refillUpNextQueue() {
  if (isRefillingQueue || !currentSong || activeQueue) return;
  isRefillingQueue = true;
  try {
    let guard = 0; // safety cap so a bad run can't loop forever
    while (upNextQueue.length < UPNEXT_TARGET && guard < 4) {
      guard++;
      // Rotate the search seed across current + recent history instead of
      // always re-querying the same artist — this was the actual cause of
      // getting stuck cycling the same 2-3 songs (a small artist catalog
      // returns the same "similar" results every time you ask about them).
      const seedPool = [currentSong, ...playHistory.slice(-3)];
      const seed = seedPool[Math.floor(Math.random() * seedPool.length)];

      const usedIds = getUsedIds();
      const candidates = await fetchSimilar(seed, usedIds);
      const pick = candidates[0];
      if (!pick) break; // nothing new found this round

      try {
        const stream = await api(`/stream/${pick.yt_id}`);
        upNextQueue.push({ song: pick, streamUrl: stream.stream_url });
      } catch {
        break; // extraction failed — stop for now, will try again on the next play
      }
    }
  } finally {
    isRefillingQueue = false;
  }
}

// ============ ADS ============
// Real Spotify-style ad break: auto-plays, cannot be skipped, and any
// song the person tries to play during it is queued until the ad ends.
audio.addEventListener("ended", async () => {
  try {
    const result = await api("/song-ended", { method: "POST" });
    if (result.show_ad) {
      playAd(result);
      return; // playNext() / pending request happens once the ad finishes itself
    }
  } catch {
    // if the ad check fails, don't block playback
  }
  playNext();
});

// Defensive: a prefetched stream URL can occasionally go stale (rare, but
// possible if it sits unused for a while), or extraction can just fail
// mid-stream. Re-resolve fresh instead of leaving the person stuck.
let lastErrorRecoveryAttempt = 0;
audio.addEventListener("error", () => {
  if (!currentSong || isAdPlaying) return;
  const now = Date.now();
  if (now - lastErrorRecoveryAttempt < 5000) return; // avoid retry loops
  lastErrorRecoveryAttempt = now;
  console.warn("Playback error — retrying with a freshly resolved stream URL");
  playSong(currentSong);
});

function playAd(adInfo) {
  isAdPlaying = true;
  setPlayingUI(false);
  $("ad-overlay").classList.remove("hidden");

  const contentEl = $("ad-content");
  contentEl.innerHTML = "";
  currentAdMedia = null;

  if (adInfo.content_url && adInfo.ad_type === "video") {
    const video = document.createElement("video");
    video.src = adInfo.content_url;
    video.className = "ad-media";
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false; // no skip, by design
    video.addEventListener("ended", endAd);
    video.addEventListener("error", () => {
      console.error("Ad video failed to load — check the Ad media URL in Admin (must be a direct .mp4/.webm file, not a YouTube page link)");
      endAd();
    });
    contentEl.appendChild(video);
    currentAdMedia = video;
    armAdSafetyTimeout();
  } else if (adInfo.content_url && adInfo.ad_type === "audio") {
    contentEl.innerHTML = `<div class="ad-audio-viz">🔊<span style="font-size:0.85rem;color:var(--text-muted)">Ad playing…</span></div>`;
    const adAudio = new Audio(adInfo.content_url);
    adAudio.addEventListener("ended", endAd);
    adAudio.addEventListener("error", () => {
      console.error("Ad audio failed to load — check the Ad media URL in Admin (must be a direct .mp3 file, not a YouTube page link)");
      endAd();
    });
    adAudio.play().catch(endAd); // if it can't play, don't block the user forever
    currentAdMedia = adAudio;
    armAdSafetyTimeout();
  } else {
    // Shouldn't normally happen — backend only sends show_ad:true when
    // real media is configured — but never leave the user stuck.
    endAd();
  }
}

// Belt-and-suspenders: if an ad somehow never fires 'ended' or 'error'
// (e.g. a broken/misconfigured URL that just hangs), force it to end
// after 90s so nobody is ever stuck behind a non-skippable ad.
let adSafetyTimer = null;
function armAdSafetyTimeout() {
  clearTimeout(adSafetyTimer);
  adSafetyTimer = setTimeout(() => {
    if (isAdPlaying) endAd();
  }, 90000);
}

function endAd() {
  isAdPlaying = false;
  currentAdMedia = null;
  clearTimeout(adSafetyTimer);
  $("ad-overlay").classList.add("hidden");

  if (pendingPlayRequest) {
    const song = pendingPlayRequest;
    pendingPlayRequest = null;
    if (currentSong) pushHistory(currentSong);
    upNextQueue = [];
    playSong(song);
  } else {
    playNext();
  }
}

// ============ APP MODAL (replaces prompt()/confirm()) ============
function showModal({ title, message = "", withInput = false, placeholder = "", confirmLabel = "OK" }) {
  return new Promise((resolve) => {
    $("app-modal-title").textContent = title;
    $("app-modal-message").textContent = message;
    $("app-modal-message").classList.toggle("hidden", !message);

    const input = $("app-modal-input");
    input.classList.toggle("hidden", !withInput);
    input.value = "";
    input.placeholder = placeholder;

    $("app-modal-confirm").textContent = confirmLabel;
    $("app-modal").classList.remove("hidden");
    if (withInput) setTimeout(() => input.focus(), 50);

    const confirmBtn = $("app-modal-confirm");
    const cancelBtn = $("app-modal-cancel");

    function cleanup(result) {
      $("app-modal").classList.add("hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onConfirm() { cleanup(withInput ? (input.value.trim() || null) : true); }
    function onCancel() { cleanup(withInput ? null : false); }
    function onKeydown(e) { if (e.key === "Enter") onConfirm(); }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKeydown);
  });
}

// ============ TOAST ============
let toastTimer;
function showToast(message) {
  let toast = $("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2500);
}

// Progress bar — mini + full-screen stay in sync, filled track shows progress
audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  [$("seek-bar"), $("np-seek-bar")].forEach((el) => {
    el.value = pct;
    el.style.setProperty("--progress", `${pct}%`);
  });
  const cur = formatDuration(audio.currentTime);
  const tot = formatDuration(audio.duration);
  $("time-current").textContent = cur;
  $("time-total").textContent = tot;
  $("np-time-current").textContent = cur;
  $("np-time-total").textContent = tot;

  if ("mediaSession" in navigator && "setPositionState" in navigator.mediaSession) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: audio.currentTime,
      });
    } catch {
      // some browsers throw if called at the wrong moment — harmless to skip
    }
  }
});

function seekTo(value) {
  if (!audio.duration) return;
  audio.currentTime = (value / 100) * audio.duration;
}
$("seek-bar").addEventListener("input", (e) => seekTo(e.target.value));
$("np-seek-bar").addEventListener("input", (e) => seekTo(e.target.value));

// Full-screen Now Playing view
$("player-track").addEventListener("click", () => {
  if (!currentSong) return;
  $("now-playing-view").classList.remove("hidden");
});
$("np-close-btn").addEventListener("click", () => {
  $("now-playing-view").classList.add("hidden");
});

// ============ PLAYLISTS ============
async function loadPlaylists() {
  try {
    playlists = await api("/playlists");
    renderPlaylistSidebar();
  } catch (err) {
    console.error("Failed to load playlists", err);
  }
}

function renderPlaylistSidebar() {
  const list = $("playlist-list");
  list.innerHTML = "";
  playlists.forEach((p) => {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.name;
    li.appendChild(nameSpan);

    if (!p.is_default) {
      const delBtn = document.createElement("button");
      delBtn.className = "playlist-delete-btn";
      delBtn.title = "Delete playlist";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const confirmed = await showModal({
          title: "Delete playlist?",
          message: `"${p.name}" will be permanently deleted.`,
          confirmLabel: "Delete",
        });
        if (!confirmed) return;
        try {
          await api(`/playlists/${p.id}`, { method: "DELETE" });
          playlists = playlists.filter((pl) => pl.id !== p.id);
          renderPlaylistSidebar();
          if ($("library-title").textContent === p.name) {
            $("library-title").textContent = "Your Library";
            $("library-list").innerHTML = "";
            $("library-hint").textContent = "Pick a playlist on the left, or make a new one.";
            $("library-hint").classList.remove("hidden");
          }
        } catch (err) {
          showToast(err.message);
        }
      });
      li.appendChild(delBtn);
    }

    li.addEventListener("click", () => openPlaylist(p));
    list.appendChild(li);
  });
}

function openPlaylist(playlist) {
  switchView("library");
  $("library-title").textContent = playlist.name;
  if (playlist.songs.length === 0) {
    $("library-hint").classList.remove("hidden");
    $("library-hint").textContent = "No songs yet — add some from search.";
  } else {
    $("library-hint").classList.add("hidden");
  }
  renderSongList($("library-list"), playlist.songs, { removable: true, playlistId: playlist.id });
}

async function removeSongFromPlaylist(playlistId, ytId) {
  try {
    const updated = await api(`/playlists/${playlistId}/songs/${ytId}`, { method: "DELETE" });
    playlists = playlists.map((p) => (p.id === updated.id ? updated : p));
    renderPlaylistSidebar(); // sidebar's click handlers were holding stale playlist refs
    openPlaylist(updated);
  } catch (err) {
    showToast(err.message);
  }
}

$("new-playlist-btn").addEventListener("click", async () => {
  const name = await showModal({ title: "New playlist", withInput: true, placeholder: "Playlist name" });
  if (!name) return;
  try {
    const playlist = await api("/playlists", { method: "POST", body: { name } });
    playlists.push(playlist);
    renderPlaylistSidebar();
  } catch (err) {
    showToast(err.message);
  }
});

// Playlist picker popover (add-to-playlist)
function openPlaylistPicker(song, anchorEl) {
  pendingAddSong = song;
  const picker = $("playlist-picker");
  const list = $("playlist-picker-list");
  list.innerHTML = "";

  if (playlists.length === 0) {
    list.innerHTML = `<li>No playlists yet — make one first</li>`;
  } else {
    playlists.forEach((p) => {
      const li = document.createElement("li");
      li.textContent = p.name;
      li.addEventListener("click", () => addSongToPlaylist(p));
      list.appendChild(li);
    });
  }

  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = `${rect.bottom + 6}px`;
  picker.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
  picker.classList.remove("hidden");
}

async function addSongToPlaylist(playlist) {
  try {
    const updated = await api(`/playlists/${playlist.id}/songs`, {
      method: "POST",
      body: {
        yt_id: pendingAddSong.yt_id,
        title: pendingAddSong.title,
        artist: pendingAddSong.artist || null,
        thumbnail: pendingAddSong.thumbnail || null,
        duration: pendingAddSong.duration || null,
      },
    });
    playlists = playlists.map((p) => (p.id === updated.id ? updated : p));
    renderPlaylistSidebar(); // keeps the sidebar's click handlers pointing at fresh data
    showToast(`Added to ${playlist.name}`);
  } catch (err) {
    showToast(err.message);
  }
  $("playlist-picker").classList.add("hidden");
}

$("add-current-btn").addEventListener("click", (e) => {
  if (!currentSong) return;
  openPlaylistPicker(currentSong, e.currentTarget);
});

document.addEventListener("click", (e) => {
  const picker = $("playlist-picker");
  if (!picker.contains(e.target) && !e.target.closest(".song-add-btn") && e.target.id !== "add-current-btn") {
    picker.classList.add("hidden");
  }
  const devicePicker = $("device-picker");
  if (!devicePicker.contains(e.target) && e.target.id !== "np-output-btn") {
    devicePicker.classList.add("hidden");
  }
});

// ============ OUTPUT DEVICE PICKER ============
// Browsers don't expose "what physical device is audio currently coming
// out of" to web pages (privacy) — there's no way to auto-detect Bluetooth
// vs speaker. What IS possible (Chrome/Edge desktop only): let the person
// explicitly choose an output device via setSinkId(), and show an icon
// based on that choice. Hidden entirely on browsers without support.
function deviceIcon(label) {
  const l = (label || "").toLowerCase();
  if (l.includes("bluetooth") || l.includes("headphone") || l.includes("headset") || l.includes("airpods")) return "🎧";
  if (l.includes("hdmi") || l.includes("tv")) return "📺";
  return "🔊";
}

function setupOutputDevicePicker() {
  const btn = $("np-output-btn");
  if (!("mediaDevices" in navigator) || typeof audio.setSinkId !== "function") {
    return; // not supported here (Firefox/Safari/most mobile) — stays hidden
  }
  btn.classList.remove("hidden");

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      // Device labels are usually blank until a media permission has been granted once
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      if (tempStream) tempStream.getTracks().forEach((t) => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((d) => d.kind === "audiooutput");

      const picker = $("device-picker");
      const list = $("device-picker-list");
      list.innerHTML = outputs.length
        ? ""
        : `<li>No output devices found</li>`;

      outputs.forEach((d) => {
        const li = document.createElement("li");
        li.textContent = `${deviceIcon(d.label)} ${d.label || "Unknown device"}`;
        li.addEventListener("click", async () => {
          try {
            await audio.setSinkId(d.deviceId);
            btn.textContent = `${deviceIcon(d.label)} ${(d.label || "Device").split(" ").slice(0, 2).join(" ")}`;
            showToast(`Now playing on ${d.label || "selected device"}`);
          } catch {
            showToast("Couldn't switch output device");
          }
          picker.classList.add("hidden");
        });
        list.appendChild(li);
      });

      const rect = btn.getBoundingClientRect();
      picker.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      picker.style.top = "auto";
      picker.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 240))}px`;
      picker.classList.remove("hidden");
    } catch {
      showToast("Couldn't list audio devices — your browser may not allow this");
    }
  });
}

// ============ ADMIN ============
function renderAnalytics(a) {
  $("an-total-users").textContent = a.total_users;
  $("an-active-week").textContent = a.active_users_7d;
  $("an-new-today").textContent = a.new_users_today;
  $("an-total-plays").textContent = a.total_plays;
  $("an-total-playlists").textContent = a.total_playlists;

  const songsList = $("an-top-songs");
  songsList.innerHTML = a.top_songs.length
    ? a.top_songs.map((s) => `<li><span class="al-name">${escapeHtml(s.title || "Unknown")}</span><span class="al-count">${s.plays}</span></li>`).join("")
    : `<li class="hint">No plays yet</li>`;

  const artistsList = $("an-top-artists");
  artistsList.innerHTML = a.top_artists.length
    ? a.top_artists.map((ar) => `<li><span class="al-name">${escapeHtml(ar.artist || "Unknown")}</span><span class="al-count">${ar.plays}</span></li>`).join("")
    : `<li class="hint">No plays yet</li>`;
}

async function loadAdmin() {
  try {
    const analytics = await api("/admin/analytics");
    renderAnalytics(analytics);

    const config = await api("/admin/ad-config");
    $("ad-max").value = config.max_ads_per_day;

    const ads = await api("/admin/ads");
    const adsList = $("ads-list");
    adsList.innerHTML = ads.length
      ? ""
      : `<li class="hint">No ads yet — add one below.</li>`;
    ads.forEach((ad) => {
      const li = document.createElement("li");
      const typeIcon = ad.ad_type === "video" ? "🎬" : ad.ad_type === "audio" ? "🔊" : "📡";
      li.innerHTML = `
        <span>${typeIcon} ${escapeHtml(ad.content_url)}</span>
        <span class="user-actions"><button data-id="${ad.id}">Delete</button></span>
      `;
      li.querySelector("button").addEventListener("click", async () => {
        try {
          await api(`/admin/ads/${ad.id}`, { method: "DELETE" });
          loadAdmin();
        } catch (err) {
          showToast(err.message);
        }
      });
      adsList.appendChild(li);
    });

    await loadFeaturedPlaylists();
    await loadAdminUsers();
  } catch (err) {
    console.error("Admin load failed", err);
  }
}

async function loadAdminUsers(search = "") {
  const users = await api(`/admin/users${search ? `?search=${encodeURIComponent(search)}` : ""}`);
  const list = $("admin-user-list");
  list.innerHTML = users.length ? "" : `<li class="hint">No users found.</li>`;
  users.forEach((u) => {
    const isSelf = u.id === currentUser.id;
    const li = document.createElement("li");
    li.innerHTML = `
      <span>${escapeHtml(u.email)} ${u.role === "admin" ? "· admin" : ""} ${u.is_banned ? "· banned" : ""} ${u.is_ad_free ? "· ad-free" : ""}</span>
      <span class="user-actions">
        <button data-action="ad-free-toggle">${u.is_ad_free ? "Remove ad-free" : "Make ad-free"}</button>
        ${isSelf ? "" : `<button data-action="role-toggle">${u.role === "admin" ? "Remove admin" : "Make admin"}</button>`}
        <button data-action="${u.is_banned ? "unban" : "ban"}">${u.is_banned ? "Unban" : "Ban"}</button>
      </span>
    `;
    li.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        try {
          if (action === "ad-free-toggle") {
            await api(`/admin/users/${u.id}/ad-free/${!u.is_ad_free}`, { method: "PUT" });
          } else if (action === "role-toggle") {
            const newRole = u.role === "admin" ? "user" : "admin";
            await api(`/admin/users/${u.id}/role/${newRole}`, { method: "PUT" });
          } else {
            await api(`/admin/users/${u.id}/${action}`, { method: "PUT" });
          }
          loadAdminUsers($("admin-user-search").value.trim());
        } catch (err) {
          showToast(err.message);
        }
      });
    });
    list.appendChild(li);
  });
}

let adminUserSearchDebounce;
$("admin-user-search").addEventListener("input", (e) => {
  $("admin-user-search-clear").classList.toggle("hidden", !e.target.value.trim());
  clearTimeout(adminUserSearchDebounce);
  adminUserSearchDebounce = setTimeout(() => loadAdminUsers(e.target.value.trim()), 350);
});
$("admin-user-search-clear").addEventListener("click", () => {
  $("admin-user-search").value = "";
  $("admin-user-search-clear").classList.add("hidden");
  loadAdminUsers("");
});

// ============ FEATURED PLAYLISTS ============
let featuredPlaylistsCache = [];

async function loadFeaturedPlaylists() {
  const playlists = await api("/admin/featured-playlists");
  featuredPlaylistsCache = playlists;

  const list = $("featured-playlists-list");
  list.innerHTML = playlists.length ? "" : `<li class="hint">None yet — create one below.</li>`;
  playlists.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span>${escapeHtml(p.name)} · ${p.songs.length} song${p.songs.length === 1 ? "" : "s"}</span>
      <span class="user-actions"><button data-id="${p.id}">Delete</button></span>
    `;
    li.querySelector("button").addEventListener("click", async () => {
      const confirmed = await showModal({
        title: "Delete featured playlist?",
        message: `"${p.name}" will be removed from everyone's Home.`,
        confirmLabel: "Delete",
      });
      if (!confirmed) return;
      try {
        await api(`/admin/featured-playlists/${p.id}`, { method: "DELETE" });
        loadFeaturedPlaylists();
      } catch (err) {
        showToast(err.message);
      }
    });
    list.appendChild(li);
  });

  const select = $("featured-target-select");
  select.innerHTML = playlists.length
    ? playlists.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")
    : `<option value="">Create a playlist first</option>`;
}

$("add-featured-btn").addEventListener("click", async () => {
  const name = $("new-featured-name").value.trim();
  if (!name) return;
  try {
    await api("/admin/featured-playlists", { method: "POST", body: { name } });
    $("new-featured-name").value = "";
    loadFeaturedPlaylists();
  } catch (err) {
    showToast(err.message);
  }
});

$("featured-search-input").addEventListener("input", (e) => {
  $("featured-search-clear").classList.toggle("hidden", !e.target.value.trim());
});
$("featured-search-clear").addEventListener("click", () => {
  $("featured-search-input").value = "";
  $("featured-search-clear").classList.add("hidden");
  $("featured-search-results").innerHTML = ""; // this was the bug — results used to stick around after clearing
});

$("featured-search-btn").addEventListener("click", async () => {
  const q = $("featured-search-input").value.trim();
  if (!q) return;
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}&limit=15`, { auth: false });
    const resultsList = $("featured-search-results");
    resultsList.innerHTML = "";
    data.results.forEach((song) => {
      const li = document.createElement("li");
      li.className = "song-row";
      li.innerHTML = `
        <img class="song-thumb" src="${song.thumbnail || ""}" alt="" loading="lazy" />
        <div class="song-info">
          <span class="song-title">${escapeHtml(song.title)}</span>
          <span class="song-artist">${escapeHtml(song.artist || "")}</span>
        </div>
        <span class="song-duration">${formatDuration(song.duration)}</span>
        <button class="song-add-btn" title="Add to featured playlist">＋</button>
      `;
      li.querySelector(".song-add-btn").addEventListener("click", async () => {
        const targetId = $("featured-target-select").value;
        if (!targetId) {
          showToast("Create a featured playlist first");
          return;
        }
        try {
          await api(`/admin/featured-playlists/${targetId}/songs`, {
            method: "POST",
            body: { yt_id: song.yt_id, title: song.title, artist: song.artist, thumbnail: song.thumbnail, duration: song.duration },
          });
          showToast("Added");
          loadFeaturedPlaylists();
        } catch (err) {
          showToast(err.message);
        }
      });
      resultsList.appendChild(li);
    });
  } catch (err) {
    showToast(err.message);
  }
});

$("save-ad-config").addEventListener("click", async () => {
  try {
    await api("/admin/ad-config", {
      method: "PUT",
      body: { max_ads_per_day: Number($("ad-max").value) },
    });
    showToast("Ad settings saved");
  } catch (err) {
    showToast(err.message);
  }
});

$("add-ad-btn").addEventListener("click", async () => {
  const url = $("new-ad-url").value.trim();
  if (!url) {
    showToast("Paste an ad media URL first");
    return;
  }
  try {
    await api("/admin/ads", {
      method: "POST",
      body: { ad_type: $("new-ad-type").value, content_url: url },
    });
    $("new-ad-url").value = "";
    showToast("Ad added");
    loadAdmin();
  } catch (err) {
    showToast(err.message);
  }
});

// ============ ONBOARDING (taste picker) ============
const GENRE_OPTIONS = [
  "Bollywood", "Hindi Pop", "Lofi", "Punjabi", "Hip-Hop", "Rock",
  "Romantic", "Devotional", "EDM", "Indie", "English Pop", "Sufi",
  "Classical", "Ghazal", "Party", "Chill", "Workout", "K-Pop",
  "Rap", "Trap", "Folk", "90s Bollywood", "Instrumental", "Sad Songs",
];
let selectedGenres = new Set();

function openOnboarding() {
  const chipRow = $("genre-chips");
  chipRow.innerHTML = "";
  selectedGenres = new Set();
  GENRE_OPTIONS.forEach((g) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = g;
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
      if (selectedGenres.has(g)) selectedGenres.delete(g);
      else selectedGenres.add(g);
    });
    chipRow.appendChild(chip);
  });
  $("onboarding-view").classList.remove("hidden");
}

function closeOnboarding() {
  $("onboarding-view").classList.add("hidden");
  currentUser.has_onboarded = true; // don't show it again this session
}

$("onboarding-skip").addEventListener("click", async () => {
  closeOnboarding();
  try {
    await api("/auth/onboarding/skip", { method: "POST" });
  } catch (err) {
    console.error("Failed to record onboarding skip", err);
  }
  await enterHome();
});

$("onboarding-save").addEventListener("click", async () => {
  try {
    await api("/auth/preferences", {
      method: "PUT",
      body: { genres: [...selectedGenres], artists: [] },
    });
  } catch (err) {
    console.error("Failed to save preferences", err);
  }
  closeOnboarding();
  await enterHome();
});

// ============ INIT ============
setInterval(() => {
  if (token && !audio.paused && !isAdPlaying) {
    api("/playback/heartbeat", { method: "POST", body: { seconds: 15 } }).catch(() => {});
  }
}, 15000);

if ("serviceWorker" in navigator) {
  // updateViaCache: 'none' is the important part — without it, browsers can
  // serve a stale HTTP-cached copy of service-worker.js itself and never
  // even notice a new version exists, no matter how often CACHE_NAME changes.
  navigator.serviceWorker.register("service-worker.js", { updateViaCache: "none" })
    .then((reg) => reg.update()) // also force a check right now, don't wait
    .catch(() => {});

  let hasReloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hasReloaded) return;
    hasReloaded = true;
    window.location.reload();
  });
}
// ============ MEDIA SESSION (notification bar, Bluetooth, keyboard media keys) ============
// This one API covers all of it: OS notification/lock-screen controls,
// hardware media keys on a keyboard, and Bluetooth headset/car buttons —
// the browser routes all of them through these same handlers.
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => togglePlayPause());
  navigator.mediaSession.setActionHandler("pause", () => togglePlayPause());
  navigator.mediaSession.setActionHandler("previoustrack", () => handlePrev());
  navigator.mediaSession.setActionHandler("nexttrack", () => handleNext());
  navigator.mediaSession.setActionHandler("seekto", (details) => {
    if (details.seekTime !== undefined && audio.duration) {
      audio.currentTime = details.seekTime;
    }
  });
}

// In-app keyboard shortcuts (desktop, while the tab is focused) —
// separate from the OS-level media keys above.
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
    if (isAdPlaying || !currentSong) return;

    if (e.code === "Space") {
      e.preventDefault();
      togglePlayPause();
    } else if (e.shiftKey && e.code === "ArrowRight") {
      handleNext();
    } else if (e.shiftKey && e.code === "ArrowLeft") {
      handlePrev();
    } else if (e.code === "ArrowRight" && audio.duration) {
      audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    } else if (e.code === "ArrowLeft" && audio.duration) {
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    }
  });
}

// Wake Lock — keeps the screen from dimming/sleeping while a song plays,
// so playback controls stay reachable during a long listening session.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // not fatal — playback continues either way, this is just a nicety
  }
}
function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
// Wake locks auto-release when a tab is backgrounded — re-acquire on return
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !audio.paused) requestWakeLock();
});

setupMediaSession();
setupKeyboardShortcuts();
setupOutputDevicePicker();
checkSession();
