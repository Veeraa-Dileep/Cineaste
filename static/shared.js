(() => {
  "use strict";

  const STORAGE_TRACKS = "cineaste.tracks.v1";
  const blockingOwners = new Set();
  let toastTimer = null;

  function storageGet(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      return false;
    }
    return true;
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function escapeAttribute(value) {
    return escapeHTML(value);
  }

  function encodePath(path) {
    return String(path ?? "")
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  function thumbnailURL(video) {
    const path = typeof video === "string" ? video : video.path;
    const version = typeof video === "object" && video && video.modified
      ? `?v=${Math.floor(Number(video.modified))}`
      : "";
    return `/thumbnail/${encodePath(path)}${version}`;
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target.isContentEditable;
  }

  function extensionLabel(extension) {
    return String(extension || "").replace(/^\./, "").toUpperCase() || "FILE";
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const amount = bytes / (1024 ** power);
    const decimals = power === 0 || amount >= 100 ? 0 : 1;
    return `${amount.toFixed(decimals)} ${units[power]}`;
  }

  function formatDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
    }
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function formatDate(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return "Date unknown";
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(seconds * 1000));
  }

  function plural(count, singular, pluralForm = `${singular}s`) {
    return `${count} ${Number(count) === 1 ? singular : pluralForm}`;
  }

  function extractYear(title) {
    const match = String(title || "").match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : "";
  }

  function folderHash(folder) {
    return `#/folder/${encodeURIComponent(folder)}`;
  }

  function scrollPageTop() {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }

  async function fetchJSON(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    const response = await fetch(url, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    let data = null;
    if (contentType.includes("application/json")) {
      data = await response.json().catch(() => null);
    } else {
      const text = await response.text().catch(() => "");
      data = text || null;
    }
    if (!response.ok) {
      const message = data && typeof data === "object"
        ? data.error || data.message
        : data;
      throw new Error(message || `Request failed (${response.status})`);
    }
    return data;
  }

  function showToast(message, duration = 3800) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.hidden = false;
    toast.textContent = message;
    toast.style.animation = "none";
    void toast.offsetWidth;
    toast.style.animation = "";
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, duration);
  }

  function syncBlocking() {
    const blocked = blockingOwners.size > 0;
    document.body.classList.toggle("is-locked", blocked);
    ["masthead", "main", "footer"].forEach((id) => {
      const element = document.getElementById(id) || document.querySelector(`.${id}`);
      if (element) element.inert = blocked;
    });
  }

  function beginBlocking(owner) {
    blockingOwners.add(owner);
    syncBlocking();
  }

  function endBlocking(owner) {
    blockingOwners.delete(owner);
    syncBlocking();
  }

  function trapFocus(container, event) {
    if (!container) return;
    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "video[controls]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusable = Array.from(container.querySelectorAll(selector)).filter((element) => {
      if (element.hidden) return false;
      if (element.closest("[hidden]")) return false;
      if (element.getAttribute("aria-hidden") === "true") return false;
      return element.getClientRects().length > 0;
    });
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeInside = container.contains(document.activeElement);
    if (event.shiftKey && (!activeInside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!activeInside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, area.value.length);
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      area.remove();
      return copied;
    }
  }

  function readTrackPreferences() {
    const raw = storageGet(STORAGE_TRACKS, "{}");
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function getTrackPreferences(path) {
    const all = readTrackPreferences();
    const entry = all[path];
    return entry && typeof entry === "object" ? entry : {};
  }

  function setTrackPreference(path, kind, value) {
    if (kind !== "audio" && kind !== "subtitle" && kind !== "frame") return;
    const all = readTrackPreferences();
    const entry = { ...(all[path] && typeof all[path] === "object" ? all[path] : {}) };
    if (value === null || value === undefined || value === "") {
      delete entry[kind];
    } else {
      entry[kind] = value;
    }
    if (Object.keys(entry).length) {
      all[path] = entry;
    } else {
      delete all[path];
    }
    storageSet(STORAGE_TRACKS, JSON.stringify(all));
  }

  window.Cineaste = Object.freeze({
    storageGet,
    storageSet,
    escapeHTML,
    escapeAttribute,
    encodePath,
    thumbnailURL,
    normalizeText,
    isTypingTarget,
    extensionLabel,
    formatBytes,
    formatDuration,
    formatDate,
    plural,
    extractYear,
    folderHash,
    scrollPageTop,
    fetchJSON,
    showToast,
    beginBlocking,
    endBlocking,
    trapFocus,
    copyText,
    getTrackPreferences,
    setTrackPreference,
  });
})();
