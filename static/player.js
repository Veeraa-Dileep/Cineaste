(() => {
  "use strict";

  const CS = window.Cineaste;
  const STORAGE_QUALITY = "cineaste.quality.v1";
  const STORAGE_VOLUME = "cineaste.volume.v1";
  const MODE_LABELS = {
    direct: "Direct play",
    remux: "Remuxed for the house",
    transcode: "Transcoded for the house",
  };

  const $ = (id) => document.getElementById(id);
  const dom = {
    cinema: $("cinema"),
    frame: $("cinema-frame"),
    screen: $("player-screen"),
    video: $("player-video"),
    header: document.querySelector(".cinema__header"),
    controls: $("player-controls"),
    subtitleLayer: $("subtitle-layer"),
    title: $("player-title"),
    subtitle: $("player-subtitle"),
    counter: $("player-counter"),
    prev: $("player-prev"),
    next: $("player-next"),
    close: $("player-close"),
    loading: $("player-loading"),
    loadingKicker: $("player-loading-kicker"),
    loadingTitle: $("player-loading-title"),
    loadingRail: $("player-loading-rail"),
    loadingFill: $("player-loading-fill"),
    loadingNote: $("player-loading-note"),
    conversion: $("conversion-chip"),
    conversionLabel: $("conversion-label"),
    conversionPercent: $("conversion-percent"),
    bigPlay: $("big-play"),
    error: $("player-error"),
    errorText: $("player-error-text"),
    retry: $("player-retry"),
    errorClose: $("player-error-close"),
    endCard: $("end-card"),
    endTitle: $("end-card-title"),
    endNote: $("end-card-note"),
    endNext: $("end-next"),
    endClose: $("end-close"),
    seek: $("seek"),
    seekInput: $("seek-input"),
    seekAvailable: $("seek-available"),
    seekPlayed: $("seek-played"),
    playToggle: $("play-toggle"),
    playToggleIcon: $("play-toggle-icon"),
    back10: $("back-10"),
    forward10: $("forward-10"),
    timeCurrent: $("time-current"),
    timeTotal: $("time-total"),
    audioField: $("audio-field"),
    audioSelect: $("audio-select"),
    subtitleField: $("subtitle-field"),
    subtitleSelect: $("subtitle-select"),
    qualityField: $("quality-field"),
    qualitySelect: $("quality-select"),
    muteToggle: $("mute-toggle"),
    muteIcon: $("mute-icon"),
    volumeInput: $("volume-input"),
    fullscreen: $("fullscreen-toggle"),
    fullscreenIcon: $("fullscreen-icon"),
    frameToggle: $("frame-toggle"),
    footMeta: $("player-foot-meta"),
  };

  let active = null;
  let idleTimer = null;
  let conversionTimer = null;
  let lastSeekWarning = 0;
  let frameFitFrame = null;
  let frameResizeObserver = null;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function readQuality() {
    const value = CS.storageGet(STORAGE_QUALITY, "1080");
    return ["2160", "1080", "720"].includes(value) ? value : "1080";
  }

  function qualityLabel(value) {
    return value === "2160" ? "2160p (4K)" : `${value}p`;
  }

  function resetFrameTransform() {
    dom.video.style.transform = "";
    dom.video.style.transformOrigin = "";
  }

  function clearFrameFit() {
    resetFrameTransform();
    if (dom.frameToggle) dom.frameToggle.hidden = true;
  }

  function frameFillUseful() {
    if (!active || !active.letterbox) return false;
    const screenWidth = dom.screen.clientWidth;
    const screenHeight = dom.screen.clientHeight;
    const videoWidth = Number(dom.video.videoWidth) || 0;
    const videoHeight = Number(dom.video.videoHeight) || 0;
    if (!screenWidth || !screenHeight || !videoWidth || !videoHeight) return false;
    return screenWidth / screenHeight > videoWidth / videoHeight + 0.002;
  }

  function updateFrameControl() {
    if (!dom.frameToggle) return;
    const visible = frameFillUseful();
    dom.frameToggle.hidden = !visible;
    if (!visible) return;
    const fillActive = active.frameMode !== "original";
    const label = fillActive ? "Show original letterboxed frame" : "Fill the wide screen";
    dom.frameToggle.setAttribute("aria-pressed", String(fillActive));
    dom.frameToggle.setAttribute("aria-label", label);
    dom.frameToggle.title = label;
  }

  function applyFrameFit() {
    if (!active) return;
    const bars = active.letterbox;
    const videoWidth = Number(dom.video.videoWidth) || 0;
    const videoHeight = Number(dom.video.videoHeight) || 0;
    const screenWidth = dom.screen.clientWidth;
    const screenHeight = dom.screen.clientHeight;
    if (
      !bars
      || active.frameMode === "original"
      || !frameFillUseful()
      || !videoWidth
      || !videoHeight
      || !screenWidth
      || !screenHeight
    ) {
      resetFrameTransform();
      updateFrameControl();
      return;
    }
    const top = clamp(Number(bars.top) || 0, 0, 0.45);
    const bottom = clamp(Number(bars.bottom) || 0, 0, 0.45);
    const contentHeightFraction = 1 - top - bottom;
    if (contentHeightFraction <= 0.2) {
      resetFrameTransform();
      updateFrameControl();
      return;
    }
    const frameScale = Math.min(screenWidth / videoWidth, screenHeight / videoHeight);
    const frameWidth = videoWidth * frameScale;
    const frameHeight = videoHeight * frameScale;
    const frameLeft = (screenWidth - frameWidth) / 2;
    const frameTop = (screenHeight - frameHeight) / 2;
    const contentWidth = frameWidth;
    const contentHeight = frameHeight * contentHeightFraction;
    const contentLeft = frameLeft;
    const contentTop = frameTop + frameHeight * top;
    const scale = Math.min(screenWidth / contentWidth, screenHeight / contentHeight);
    const desiredLeft = (screenWidth - contentWidth * scale) / 2;
    const desiredTop = (screenHeight - contentHeight * scale) / 2;
    const translateX = desiredLeft - contentLeft * scale;
    const translateY = desiredTop - contentTop * scale;
    dom.video.style.transformOrigin = "0 0";
    dom.video.style.transform = `translate(${translateX.toFixed(2)}px, ${translateY.toFixed(2)}px) scale(${scale.toFixed(6)})`;
    updateFrameControl();
  }

  function scheduleFrameFit() {
    if (frameFitFrame !== null) return;
    frameFitFrame = window.requestAnimationFrame(() => {
      frameFitFrame = null;
      applyFrameFit();
    });
  }

  function toggleFrameMode() {
    if (!active || !active.letterbox) return;
    active.frameMode = active.frameMode === "original" ? "fill" : "original";
    CS.setTrackPreference(active.video.path, "frame", active.frameMode);
    updateFrameControl();
    scheduleFrameFit();
    CS.showToast(active.frameMode === "fill" ? "Filling the wide screen." : "Showing the original frame.");
    showControls();
  }

  function configureFrame(response) {
    if (!active) return;
    const raw = response.letterbox;
    let bars = null;
    if (raw && typeof raw === "object") {
      const top = Number(raw.top);
      const bottom = Number(raw.bottom);
      if (
        Number.isFinite(top)
        && Number.isFinite(bottom)
        && top > 0.01
        && bottom > 0.01
        && top < 0.45
        && bottom < 0.45
        && top + bottom < 0.8
      ) {
        bars = { top, bottom };
      }
    }
    active.letterbox = bars;
    const preference = CS.getTrackPreferences(active.video.path).frame;
    active.frameMode = bars && preference === "original" ? "original" : "fill";
    updateFrameControl();
    scheduleFrameFit();
  }

  function readVolume() {
    const value = Number(CS.storageGet(STORAGE_VOLUME, "1"));
    return Number.isFinite(value) ? clamp(value, 0, 1) : 1;
  }

  function cleanFolderName(value) {
    const last = String(value || "").split("/").filter(Boolean).pop();
    if (!last) return "The flat shelf";
    const cleaned = last.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
    return cleaned || "The flat shelf";
  }

  function folderLine(folder) {
    return folder ? folder : "The flat shelf";
  }

  function setIcon(element, name) {
    if (element) element.setAttribute("href", `#icon-${name}`);
  }

  function documentTitle(title) {
    document.title = `${title} · Cinéaste`;
  }

  function updateIdentity() {
    const video = active.video;
    dom.title.textContent = video.title;
    dom.subtitle.textContent = `${folderLine(video.folder)} · ${CS.formatDate(video.modified)}`;
    dom.counter.textContent = active.queue.length > 1
      ? `${active.index + 1} / ${active.queue.length}`
      : "";
    dom.prev.disabled = active.index <= 0;
    dom.next.disabled = active.index >= active.queue.length - 1;
    dom.footMeta.textContent = [
      CS.extensionLabel(video.extension).replace(/^\./, ""),
      CS.formatBytes(video.size),
      folderLine(video.folder),
    ].join(" · ");
    documentTitle(video.title);
  }

  function setLoading(title, kicker, note) {
    if (!active) return;
    dom.loading.hidden = false;
    dom.loadingTitle.textContent = title || active.video.title;
    dom.loadingKicker.textContent = kicker || "Threading the projector";
    dom.loadingNote.textContent = note || "Preparing the first frames.";
    dom.loadingRail.classList.add("is-indeterminate");
    dom.loadingFill.style.width = "";
    dom.conversion.hidden = true;
    dom.error.hidden = true;
    dom.endCard.hidden = true;
    dom.bigPlay.hidden = true;
    clearIdle();
  }

  function finishLoading() {
    dom.loading.hidden = true;
    dom.loadingRail.classList.remove("is-indeterminate");
    dom.loadingFill.style.width = "0%";
  }

  function clearError() {
    dom.error.hidden = true;
    dom.errorText.textContent = "";
    if (active) active.error = false;
  }

  function showError(message) {
    if (!active) return;
    active.error = true;
    active.ended = false;
    finishLoading();
    dom.endCard.hidden = true;
    dom.bigPlay.hidden = true;
    dom.conversion.hidden = true;
    dom.error.hidden = false;
    dom.errorText.textContent = message || "The projector could not prepare this film.";
    showControls();
    clearIdle();
  }

  function hideEndCard() {
    dom.endCard.hidden = true;
    if (active) active.ended = false;
  }

  function stopSession(sessionId) {
    if (!sessionId) return;
    const url = `/api/play/${encodeURIComponent(sessionId)}/stop`;
    try {
      fetch(url, { method: "POST", keepalive: true }).catch(() => {});
    } catch {
      return;
    }
  }

  function clearConversionTimer() {
    window.clearTimeout(conversionTimer);
    conversionTimer = null;
  }

  function clearSessionPoll() {
    if (!active) return;
    window.clearInterval(active.pollTimer);
    active.pollTimer = null;
  }

  function clearSessionHeartbeat() {
    if (!active) return;
    window.clearInterval(active.heartbeatTimer);
    active.heartbeatTimer = null;
  }

  function startSessionHeartbeat() {
    if (!active) return;
    clearSessionHeartbeat();
    const sessionId = active.sessionId;
    if (!sessionId) return;
    active.heartbeatTimer = window.setInterval(() => {
      if (!active || active.sessionId !== sessionId) return;
      CS.fetchJSON(`/api/play/${encodeURIComponent(sessionId)}/status`).catch(() => {});
    }, 60000);
  }

  function detachMedia(stopOldSession = true) {
    if (!active) return;
    clearSessionPoll();
    clearSessionHeartbeat();
    clearConversionTimer();
    window.clearTimeout(active.resumeChipTimer);
    active.resumeChipTimer = null;
    const sessionId = active.sessionId;
    active.sessionId = null;
    if (active.hls) {
      try {
        active.hls.destroy();
      } catch {
        active.hls = null;
      }
      active.hls = null;
    }
    if (active.nativeAudioHandler) {
      dom.video.removeEventListener("loadedmetadata", active.nativeAudioHandler);
      active.nativeAudioHandler = null;
    }
    active.suppressVideoErrors = true;
    try {
      dom.video.pause();
    } catch {
      active.suppressVideoErrors = false;
    }
    dom.video.removeAttribute("src");
    try {
      dom.video.load();
    } catch {
      active.suppressVideoErrors = false;
    }
    window.setTimeout(() => {
      if (active) active.suppressVideoErrors = false;
    }, 50);
    clearFrameFit();
    clearSubtitles();
    dom.subtitleLayer.textContent = "";
    dom.conversion.hidden = true;
    dom.bigPlay.hidden = true;
    if (stopOldSession) stopSession(sessionId);
  }

  function resetSelections() {
    dom.audioSelect.innerHTML = "<option>Preparing</option>";
    dom.audioSelect.disabled = true;
    dom.subtitleSelect.innerHTML = "<option value=\"off\">Off</option>";
    dom.subtitleSelect.disabled = true;
    dom.subtitleField.title = "";
    dom.qualitySelect.value = readQuality();
    dom.qualitySelect.disabled = true;
    dom.qualityField.title = "";
    dom.audioField.title = "";
  }

  function resetPlaybackUI() {
    dom.video.volume = readVolume();
    dom.video.muted = false;
    dom.volumeInput.value = String(dom.video.volume);
    dom.seekInput.value = "0";
    dom.seekInput.max = "0";
    dom.seekAvailable.style.width = "0%";
    dom.seekPlayed.style.width = "0%";
    dom.timeCurrent.textContent = "0:00";
    dom.timeTotal.textContent = "0:00";
    setIcon(dom.playToggleIcon, "play");
    dom.playToggle.setAttribute("aria-label", "Play");
    setIcon(dom.muteIcon, dom.video.muted || dom.video.volume === 0 ? "mute" : "volume");
    dom.muteToggle.setAttribute("aria-label", dom.video.muted ? "Unmute" : "Mute");
    dom.bigPlay.hidden = true;
  }

  function open(options) {
    if (!options || !options.video) return;
    if (active) close({ silent: true, restoreFocus: false });
    const queue = Array.isArray(options.queue) && options.queue.length ? options.queue.slice() : [options.video];
    let index = Number.isInteger(options.index) ? options.index : queue.findIndex((item) => item.path === options.video.path);
    if (index < 0 || index >= queue.length) index = 0;
    active = {
      video: queue[index],
      queue,
      index,
      returnFocus: options.returnFocus || document.activeElement,
      abort: null,
      loadToken: 0,
      sessionId: null,
      response: null,
      hls: null,
      duration: 0,
      converted: 0,
      limited: false,
      sessionStatus: "",
      pollTimer: null,
      heartbeatTimer: null,
      error: false,
      ended: false,
      cues: [],
      subtitleToken: 0,
      subtitleAbort: null,
      resumeAt: 0,
      suppressVideoErrors: false,
      suppressAudioChange: false,
      nativeAudioHandler: null,
      quality: readQuality(),
      letterbox: null,
      frameMode: "fill",
      idle: null,
    };
    CS.beginBlocking("player");
    dom.cinema.hidden = false;
    dom.cinema.classList.remove("is-idle");
    dom.video.controls = false;
    clearError();
    hideEndCard();
    resetSelections();
    resetPlaybackUI();
    updateIdentity();
    setLoading(active.video.title, "Threading the projector", "Preparing the first frames.");
    loadCurrent({ autoplay: true });
    window.setTimeout(() => {
      if (active && !active.error) dom.frame.focus({ preventScroll: true });
    }, 40);
  }

  function close({ silent = false, restoreFocus = true } = {}) {
    if (!active) return;
    const finished = active;
    const returnFocus = finished.returnFocus;
    finished.abort?.abort();
    finished.subtitleAbort?.abort();
    clearIdle();
    clearSessionPoll();
    clearConversionTimer();
    window.clearTimeout(finished.resumeChipTimer);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    detachMedia(true);
    active = null;
    dom.cinema.hidden = true;
    dom.cinema.classList.remove("is-idle");
    dom.subtitleLayer.textContent = "";
    dom.error.hidden = true;
    dom.endCard.hidden = true;
    dom.conversion.hidden = true;
    dom.loading.hidden = true;
    CS.endBlocking("player");
    if (!silent) {
      document.title = "";
      document.dispatchEvent(new CustomEvent("cineaste:player-closed", { detail: { video: finished.video } }));
    }
    if (restoreFocus && returnFocus && typeof returnFocus.focus === "function" && returnFocus.isConnected) {
      window.setTimeout(() => returnFocus.focus({ preventScroll: true }), 20);
    }
  }

  function switchTo(index) {
    if (!active || index < 0 || index >= active.queue.length || index === active.index) return;
    loadCurrent({ index, autoplay: true, resumeAt: 0 });
  }

  function attachDirect(response) {
    active.sessionId = null;
    active.limited = false;
    dom.video.src = response.url;
    dom.video.load();
    if (active.autoplay) attemptPlay();
  }

  function attachHls(response) {
    active.sessionId = response.session_id;
    active.limited = true;
    startSessionHeartbeat();
    const canNative = dom.video.canPlayType("application/vnd.apple.mpegurl");
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startPosition: active.resumeAt > 0 ? active.resumeAt : -1,
      });
      active.hls = hls;
      hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
        if (active && active.hls === hls) hls.loadSource(response.url);
      });
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (!active || active.hls !== hls) return;
        active.manifestReady = true;
        populateHlsAudio();
        scheduleFrameFit();
        if (active.autoplay) attemptPlay();
      });
      hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (!active || active.hls !== hls) return;
        populateHlsAudio();
      });
      hls.on(window.Hls.Events.AUDIO_TRACK_SWITCHED, () => {
        if (!active || active.hls !== hls) return;
        const trackIndex = hls.audioTrack;
        if (trackIndex >= 0) {
          const option = dom.audioSelect.querySelector(`option[value="${trackIndex}"]`);
          if (option) dom.audioSelect.value = option.value;
          if (!active.suppressAudioChange) {
            CS.setTrackPreference(active.video.path, "audio", String(trackIndex));
          }
        }
      });
      hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (!active || active.hls !== hls || !data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && !active.recoverNetwork) {
          active.recoverNetwork = true;
          hls.startLoad();
          return;
        }
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !active.recoverMedia) {
          active.recoverMedia = true;
          hls.recoverMediaError();
          return;
        }
        showError("The projector lost its connection to the prepared stream.");
      });
      hls.attachMedia(dom.video);
      return;
    }
    if (canNative) {
      active.nativeAudioHandler = () => populateNativeAudio();
      dom.video.addEventListener("loadedmetadata", active.nativeAudioHandler);
      dom.video.src = response.url;
      dom.video.load();
      if (active.autoplay) attemptPlay();
      return;
    }
    showError("This browser cannot play the prepared stream. Try a current version of Chrome, Edge, Firefox, or Safari.");
  }

  async function loadCurrent({ index = null, autoplay = true, resumeAt = 0 } = {}) {
    if (!active) return;
    const nextIndex = index === null ? active.index : index;
    if (nextIndex < 0 || nextIndex >= active.queue.length) return;
    const token = ++active.loadToken;
    active.abort?.abort();
    active.abort = new AbortController();
    active.autoplay = autoplay;
    active.resumeAt = Math.max(0, Number(resumeAt) || 0);
    active.recoverNetwork = false;
    active.recoverMedia = false;
    active.manifestReady = false;
    active.subtitleToken += 1;
    active.subtitleAbort?.abort();
    detachMedia(true);
    hideEndCard();
    clearError();
    active.video = active.queue[nextIndex];
    active.index = nextIndex;
    active.response = null;
    active.duration = 0;
    active.converted = 0;
    active.limited = false;
    active.sessionStatus = "";
    active.letterbox = null;
    active.frameMode = "fill";
    active.quality = readQuality();
    active.audioInitialized = false;
    active.suppressAudioChange = false;
    active.pollFailures = 0;
    updateIdentity();
    resetSelections();
    resetPlaybackUI();
    setLoading(active.video.title, "Threading the projector", "Preparing the first frames.");
    const requestBody = JSON.stringify({ height: Number(active.quality) });
    try {
      const response = await CS.fetchJSON(`/api/play/${CS.encodePath(active.video.path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        signal: active.abort.signal,
      });
      if (!active || token !== active.loadToken) {
        if (response && response.session_id) stopSession(response.session_id);
        return;
      }
      active.response = response;
      active.duration = Number(response.duration) || 0;
      active.limited = Boolean(response.limited_seeking);
      active.converted = response.limited_seeking ? 0 : active.duration;
      configureSettings(response);
      configureFootMeta(response);
      if (response.mode === "hls") {
        const label = response.play_mode === "remux" ? "Lacing the reel" : "Developing the print";
        dom.conversionLabel.textContent = label;
        dom.conversionPercent.textContent = "0%";
        dom.conversion.hidden = false;
        active.sessionId = response.session_id;
        startSessionPoll();
        attachHls(response);
      } else {
        dom.conversion.hidden = true;
        attachDirect(response);
      }
    } catch (error) {
      if (!active || token !== active.loadToken || error.name === "AbortError") return;
      showError(error.message || "The projector could not prepare this film.");
    }
  }

  function configureFootMeta(response) {
    if (!active) return;
    const parts = [CS.extensionLabel(active.video.extension).replace(/^\./, "")];
    if (response.height) parts.push(response.height >= 2160 ? "2160p (4K)" : `${response.height}p`);
    if (active.duration) parts.push(CS.formatDuration(active.duration));
    const audioCount = (response.audio_tracks || []).length;
    if (audioCount > 0) parts.push(CS.plural(audioCount, "audio track"));
    parts.push(MODE_LABELS[response.play_mode] || MODE_LABELS[response.mode] || "Prepared stream");
    dom.footMeta.textContent = parts.join(" · ");
    dom.timeTotal.textContent = CS.formatDuration(active.duration);
    dom.seekInput.max = String(active.duration || 0);
  }

  function configureSettings(response) {
    if (!active) return;
    const tracks = response.audio_tracks || [];
    dom.audioSelect.innerHTML = "";
    if (!tracks.length) {
      dom.audioSelect.innerHTML = "<option value=\"\">No sound</option>";
      dom.audioSelect.disabled = true;
    } else if (response.mode === "hls" && window.Hls && window.Hls.isSupported()) {
      tracks.forEach((track, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = track.label || `Audio ${index + 1}`;
        dom.audioSelect.append(option);
      });
      dom.audioSelect.disabled = tracks.length <= 1;
      const preferred = Number(CS.getTrackPreferences(active.video.path).audio);
      const defaultIndex = Math.max(0, tracks.findIndex((track) => track.default));
      dom.audioSelect.value = String(Number.isInteger(preferred) && preferred >= 0 && preferred < tracks.length ? preferred : defaultIndex);
      active.suppressAudioChange = true;
    } else {
      tracks.forEach((track, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = track.label || `Audio ${index + 1}`;
        dom.audioSelect.append(option);
      });
      dom.audioSelect.disabled = true;
      dom.audioSelect.value = "0";
    }
    dom.audioField.title = tracks.length > 1 ? "Choose a soundtrack" : "This print has one soundtrack";
    configureQuality(response);
    configureSubtitles(response);
    configureFrame(response);
  }

  function configureQuality(response) {
    const enabled = response.play_mode === "transcode";
    const heights = [];
    (Array.isArray(response.available_heights) ? response.available_heights : [1080, 720]).forEach((value) => {
      const height = Number(value);
      if ([2160, 1080, 720].includes(height) && !heights.includes(height)) heights.push(height);
    });
    if (!heights.includes(1080)) heights.push(1080);
    if (!heights.includes(720)) heights.push(720);
    heights.sort((left, right) => right - left);
    dom.qualitySelect.innerHTML = "";
    heights.forEach((height) => {
      const option = document.createElement("option");
      option.value = String(height);
      option.textContent = qualityLabel(String(height));
      dom.qualitySelect.append(option);
    });
    const stored = readQuality();
    dom.qualitySelect.value = heights.includes(Number(stored)) ? stored : "1080";
    dom.qualityField.hidden = !enabled;
    dom.qualitySelect.disabled = !enabled;
    dom.qualityField.title = enabled
      ? heights.includes(2160)
        ? "Choose a print. 4K uses more bandwidth and projector cache."
        : "Choose how the projector develops this film"
      : "This print already plays at its source quality";
  }

  function populateHlsAudio() {
    if (!active || !active.hls) return;
    const hlsTracks = active.hls.audioTracks || [];
    if (!hlsTracks.length) return;
    const backendTracks = (active.response && active.response.audio_tracks) || [];
    const previousValue = dom.audioSelect.value;
    dom.audioSelect.innerHTML = "";
    hlsTracks.forEach((track, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = (backendTracks[index] && backendTracks[index].label) || track.name || `Audio ${index + 1}`;
      dom.audioSelect.append(option);
    });
    dom.audioSelect.disabled = hlsTracks.length <= 1;
    const preferred = Number(CS.getTrackPreferences(active.video.path).audio);
    const defaultIndex = Math.max(0, backendTracks.findIndex((track) => track.default));
    let desired;
    if (!active.audioInitialized) {
      desired = Number.isInteger(preferred) && preferred >= 0 && preferred < hlsTracks.length
        ? preferred
        : defaultIndex;
      active.audioInitialized = true;
    } else {
      const previous = Number(previousValue);
      desired = Number.isInteger(previous) && previous >= 0 && previous < hlsTracks.length
        ? previous
        : defaultIndex;
    }
    dom.audioSelect.value = String(desired);
    if (active.hls.audioTrack !== desired) {
      active.suppressAudioChange = true;
      active.hls.audioTrack = desired;
      window.setTimeout(() => {
        if (active) active.suppressAudioChange = false;
      }, 300);
    }
  }

  function populateNativeAudio() {
    if (!active || !active.response || active.response.mode !== "hls" || active.hls) return;
    const tracks = dom.video.audioTracks;
    if (!tracks || !tracks.length) {
      dom.audioSelect.disabled = true;
      return;
    }
    dom.audioSelect.innerHTML = "";
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = track.label || track.language || `Audio ${index + 1}`;
      dom.audioSelect.append(option);
    }
    dom.audioSelect.disabled = tracks.length <= 1;
    const preferred = Number(CS.getTrackPreferences(active.video.path).audio);
    const desired = Number.isInteger(preferred) && preferred >= 0 && preferred < tracks.length ? preferred : 0;
    for (let index = 0; index < tracks.length; index += 1) {
      tracks[index].enabled = index === desired;
    }
    dom.audioSelect.value = String(desired);
  }

  function selectHlsAudio(value) {
    if (!active || !active.hls) return;
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= active.hls.audioTracks.length) return;
    active.suppressAudioChange = false;
    active.hls.audioTrack = index;
    CS.setTrackPreference(active.video.path, "audio", String(index));
  }

  function selectNativeAudio(value) {
    if (!active) return;
    const tracks = dom.video.audioTracks;
    if (!tracks) return;
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= tracks.length) return;
    for (let cursor = 0; cursor < tracks.length; cursor += 1) {
      tracks[cursor].enabled = cursor === index;
    }
    CS.setTrackPreference(active.video.path, "audio", String(index));
  }

  function parseTimestamp(raw) {
    const value = String(raw || "").trim().replace(",", ".");
    if (!value) return null;
    const parts = value.split(":").map(Number);
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + part;
    return seconds;
  }

  function decodeCueText(raw) {
    const cleaned = String(raw || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\{\\[^}]+\}/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
    return cleaned
      .split("\n")
      .map((line) => line.trim())
      .filter((line, index, lines) => line || (index > 0 && index < lines.length - 1))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function parseWebVTT(source) {
    const text = String(source || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const blocks = text.split(/\n{2,}/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trimEnd());
      if (!lines.length) continue;
      if (lines[0].startsWith("WEBVTT") || lines[0].startsWith("NOTE") || lines[0].startsWith("STYLE") || lines[0].startsWith("REGION")) {
        const timingLine = lines.findIndex((line) => line.includes("-->"));
        if (timingLine < 0) continue;
        lines.splice(0, timingLine);
      }
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) continue;
      const timing = lines[timingIndex].split("-->");
      if (timing.length < 2) continue;
      const start = parseTimestamp(timing[0]);
      const end = parseTimestamp(timing[1].trim().split(/\s+/)[0]);
      if (start === null || end === null || end <= start) continue;
      const body = decodeCueText(lines.slice(timingIndex + 1).join("\n"));
      if (!body) continue;
      cues.push({ start, end, text: body });
    }
    cues.sort((left, right) => left.start - right.start);
    return cues;
  }

  function clearSubtitles() {
    if (active) {
      active.subtitleToken += 1;
      active.subtitleAbort?.abort();
      active.subtitleAbort = null;
      active.cues = [];
      active.subtitleText = "";
    }
    dom.subtitleLayer.replaceChildren();
  }

  function renderSubtitles() {
    if (!active || !active.cues.length || dom.video.readyState === 0) {
      if (active) active.subtitleText = "";
      dom.subtitleLayer.replaceChildren();
      return;
    }
    const time = dom.video.currentTime;
    const parts = [];
    for (const cue of active.cues) {
      if (time >= cue.start && time < cue.end) parts.push(cue.text);
    }
    const text = parts.join("\n");
    if (text === active.subtitleText) return;
    active.subtitleText = text;
    if (!text) {
      dom.subtitleLayer.replaceChildren();
      return;
    }
    const span = document.createElement("span");
    span.textContent = text;
    dom.subtitleLayer.replaceChildren(span);
  }

  async function loadSubtitle(track) {
    if (!active) return;
    const token = ++active.subtitleToken;
    active.subtitleAbort?.abort();
    const controller = new AbortController();
    active.subtitleAbort = controller;
    active.cues = [];
    active.subtitleText = "";
    dom.subtitleLayer.replaceChildren();
    try {
      const response = await fetch(track.url, {
        headers: { Accept: "text/vtt, text/plain, */*" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Subtitle track unavailable.");
      const source = await response.text();
      if (!active || token !== active.subtitleToken) return;
      const cues = parseWebVTT(source);
      if (!cues.length) throw new Error("That track contains no readable cues.");
      active.cues = cues;
      renderSubtitles();
    } catch (error) {
      if (!active || token !== active.subtitleToken || error.name === "AbortError") return;
      dom.subtitleSelect.value = "off";
      CS.setTrackPreference(active.video.path, "subtitle", "off");
      CS.showToast("That subtitle track could not be read.");
    } finally {
      if (active && active.subtitleAbort === controller) active.subtitleAbort = null;
    }
  }

  function configureSubtitles(response) {
    if (!active) return;
    const tracks = response.subtitle_tracks || [];
    dom.subtitleSelect.innerHTML = "<option value=\"off\">Off</option>";
    tracks.forEach((track) => {
      const option = document.createElement("option");
      option.value = track.id;
      option.textContent = track.label || track.language_name || "Subtitle";
      dom.subtitleSelect.append(option);
    });
    dom.subtitleSelect.disabled = tracks.length === 0;
    const preference = CS.getTrackPreferences(active.video.path).subtitle;
    let choice = "off";
    if (preference && preference !== "off" && tracks.some((track) => track.id === preference)) {
      choice = preference;
    } else if (!preference) {
      const automatic = tracks.find((track) => track.forced) || tracks.find((track) => track.default);
      if (automatic) choice = automatic.id;
    }
    dom.subtitleSelect.value = choice;
    if (choice !== "off") {
      const track = tracks.find((item) => item.id === choice);
      if (track) loadSubtitle(track);
    }
    if (response.unsupported_subtitles > 0) {
      dom.subtitleField.title = "Bitmap subtitle tracks cannot be shown in the browser.";
    } else if (tracks.length) {
      dom.subtitleField.title = "Choose subtitles";
    } else {
      dom.subtitleField.title = "This print has no text subtitles";
    }
  }

  function updateSeekAvailability() {
    if (!active) return;
    const duration = active.duration || 0;
    let available = 100;
    if (active.limited && active.sessionStatus !== "complete") {
      available = duration > 0 ? clamp((active.converted / duration) * 100, 0, 100) : 0;
    }
    dom.seekAvailable.style.width = `${available}%`;
  }

  function updatePlaybackUI() {
    if (!active) return;
    const duration = active.duration || dom.video.duration || 0;
    const current = dom.video.currentTime || 0;
    const ratio = duration > 0 ? clamp((current / duration) * 100, 0, 100) : 0;
    dom.seekPlayed.style.width = `${ratio}%`;
    dom.timeCurrent.textContent = CS.formatDuration(current);
    dom.timeTotal.textContent = CS.formatDuration(duration);
    if (dom.seekInput.max !== String(duration)) dom.seekInput.max = String(duration);
    if (document.activeElement !== dom.seekInput) dom.seekInput.value = String(current);
    const playing = !dom.video.paused && !dom.video.ended;
    setIcon(dom.playToggleIcon, playing ? "pause" : "play");
    dom.playToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
    const canShowBigPlay = !playing && dom.loading.hidden && !active.error && !active.ended && dom.video.readyState >= 1;
    dom.bigPlay.hidden = !canShowBigPlay;
    if (playing) {
      if (!idleTimer && !dom.cinema.classList.contains("is-idle")) scheduleIdle();
    } else {
      clearIdle();
    }
  }

  function attemptPlay() {
    if (!active) return;
    const promise = dom.video.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch(() => {
        if (!active) return;
        finishLoading();
        updatePlaybackUI();
        showControls();
      });
    }
  }

  function togglePlay() {
    if (!active || active.error) return;
    if (dom.video.ended) {
      hideEndCard();
      dom.video.currentTime = 0;
      attemptPlay();
      return;
    }
    if (dom.video.paused) {
      hideEndCard();
      attemptPlay();
    } else {
      dom.video.pause();
    }
    showControls();
  }

  function seekCeiling() {
    if (!active) return 0;
    const duration = active.duration || dom.video.duration || 0;
    if (!active.limited || active.sessionStatus === "complete") return duration;
    return Math.min(duration, Math.max(0, active.converted));
  }

  function seekTo(seconds) {
    if (!active || !Number.isFinite(seconds)) return;
    const duration = active.duration || dom.video.duration || 0;
    let target = clamp(seconds, 0, duration);
    const ceiling = seekCeiling();
    if (active.limited && active.sessionStatus !== "complete" && target > ceiling + 0.35) {
      target = ceiling;
      const now = Date.now();
      if (now - lastSeekWarning > 3000) {
        lastSeekWarning = now;
        CS.showToast("The reel is still developing. You can seek up to the frames already prepared.");
      }
    }
    hideEndCard();
    try {
      dom.video.currentTime = target;
    } catch {
      return;
    }
    dom.seekInput.value = String(target);
    updatePlaybackUI();
    renderSubtitles();
    showControls();
  }

  function seekBy(delta) {
    if (!active) return;
    seekTo((dom.video.currentTime || 0) + delta);
  }

  function updateConversionChip(status) {
    if (!active) return;
    const percent = clamp(Number(status.percent) || 0, 0, 100);
    dom.conversionPercent.textContent = `${Math.floor(percent)}%`;
    if (status.status === "complete") {
      dom.conversionLabel.textContent = "Print ready";
      dom.conversionPercent.textContent = "100%";
      clearConversionTimer();
      const currentSession = active.sessionId;
      conversionTimer = window.setTimeout(() => {
        if (active && active.sessionId === currentSession) dom.conversion.hidden = true;
      }, 2800);
    } else {
      dom.conversionLabel.textContent = status.mode === "remux" ? "Lacing the reel" : "Developing the print";
      dom.conversion.hidden = false;
      clearConversionTimer();
    }
  }

  function pollSession(token, sessionId) {
    if (!active || active.loadToken !== token || active.sessionId !== sessionId) return;
    CS.fetchJSON(`/api/play/${encodeURIComponent(sessionId)}/status`)
      .then((status) => {
        if (!active || active.loadToken !== token || active.sessionId !== sessionId) return;
        active.pollFailures = 0;
        active.sessionStatus = status.status || "";
        active.converted = status.status === "complete" ? active.duration : Number(status.converted) || 0;
        updateSeekAvailability();
        if (!dom.loading.hidden) {
          const percent = clamp(Number(status.percent) || 0, 0, 100);
          dom.loadingFill.style.width = `${percent}%`;
          dom.loadingNote.textContent = status.status === "starting"
            ? "Warming the lamp and preparing the first frames."
            : `${Math.floor(percent)}% developed. The first frames are nearly ready.`;
        }
        updateConversionChip(status);
        if (status.status === "complete") {
          clearSessionPoll();
          updatePlaybackUI();
        } else if (status.status === "error") {
          clearSessionPoll();
          showError(status.error || "The projector stopped before the print was finished.");
        }
      })
      .catch(() => {
        if (!active || active.loadToken !== token || active.sessionId !== sessionId) return;
        active.pollFailures = (active.pollFailures || 0) + 1;
        if (active.pollFailures > 4) clearSessionPoll();
      });
  }

  function startSessionPoll() {
    if (!active) return;
    clearSessionPoll();
    const token = active.loadToken;
    const sessionId = active.sessionId;
    if (!sessionId) return;
    pollSession(token, sessionId);
    active.pollTimer = window.setInterval(() => pollSession(token, sessionId), 1300);
  }

  function showEndCard() {
    if (!active) return;
    active.ended = true;
    clearIdle();
    finishLoading();
    dom.bigPlay.hidden = true;
    dom.error.hidden = true;
    dom.conversion.hidden = true;
    const nextVideo = active.queue[active.index + 1];
    dom.endTitle.textContent = nextVideo ? "The next reel is ready." : "That is the last reel.";
    dom.endNote.textContent = nextVideo
      ? `Next in the queue: ${nextVideo.title}.`
      : "Thank you for coming to the pictures.";
    dom.endNext.hidden = !nextVideo;
    dom.endCard.hidden = false;
    CS.showToast("The end. The house lights are ready when you are.");
    window.setTimeout(() => {
      if (!active || !active.ended) return;
      (nextVideo ? dom.endNext : dom.endClose).focus({ preventScroll: true });
    }, 50);
  }

  function retry() {
    if (!active) return;
    loadCurrent({ index: active.index, autoplay: true, resumeAt: 0 });
  }

  function changeQuality() {
    if (!active) return;
    const value = ["2160", "1080", "720"].includes(dom.qualitySelect.value) ? dom.qualitySelect.value : "1080";
    CS.storageSet(STORAGE_QUALITY, value);
    active.quality = value;
    if (!active.response) return;
    const label = qualityLabel(value);
    if (active.response.play_mode !== "transcode") {
      CS.showToast(`Saved. ${label} will be used the next time this film needs transcoding.`);
      return;
    }
    const resumeAt = dom.video.currentTime || 0;
    const autoplay = !dom.video.paused && !active.ended;
    CS.showToast(`Changing the print to ${label}. The projector needs a moment.`);
    loadCurrent({ index: active.index, autoplay, resumeAt });
  }

  function updateVolumeUI() {
    const muted = dom.video.muted || dom.video.volume === 0;
    setIcon(dom.muteIcon, muted ? "mute" : "volume");
    dom.muteToggle.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    dom.volumeInput.value = String(dom.video.volume);
  }

  function toggleMute() {
    if (!active) return;
    if (dom.video.muted || dom.video.volume === 0) {
      dom.video.muted = false;
      if (dom.video.volume === 0) dom.video.volume = 0.6;
    } else {
      dom.video.muted = true;
    }
    updateVolumeUI();
    showControls();
  }

  function changeVolume(value) {
    if (!active) return;
    const volume = clamp(Number(value), 0, 1);
    dom.video.volume = volume;
    dom.video.muted = volume === 0;
    CS.storageSet(STORAGE_VOLUME, String(volume));
    updateVolumeUI();
    showControls();
  }

  function setFullscreenUI(isFullscreen) {
    setIcon(dom.fullscreenIcon, isFullscreen ? "exit-fullscreen" : "fullscreen");
    dom.fullscreen.setAttribute("aria-label", isFullscreen ? "Leave full screen" : "Enter full screen");
  }

  function updateFullscreenUI() {
    setFullscreenUI(Boolean(document.fullscreenElement) || Boolean(dom.video.webkitDisplayingFullscreen));
  }

  function focusScreen() {
    try {
      dom.screen.focus({ preventScroll: true });
    } catch {
      return;
    }
  }

  function enterNativeFullscreen() {
    const enter = dom.video.webkitEnterFullscreen;
    if (typeof enter !== "function") return false;
    try {
      enter.call(dom.video);
      return true;
    } catch {
      return false;
    }
  }

  function toggleFullscreen() {
    if (!active) return;
    if (document.fullscreenElement || dom.video.webkitDisplayingFullscreen) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (typeof dom.video.webkitExitFullscreen === "function") {
        try {
          dom.video.webkitExitFullscreen();
        } catch {
          return;
        }
      }
      return;
    }
    let request;
    try {
      request = dom.screen.requestFullscreen?.();
    } catch {
      request = null;
    }
    if (!request) {
      if (enterNativeFullscreen()) {
        showControls();
        return;
      }
      CS.showToast("Full screen is not available in this browser.");
      return;
    }
    Promise.resolve(request)
      .then(() => {
        if (!active) return;
        focusScreen();
        showControls();
      })
      .catch(() => {
        if (enterNativeFullscreen()) return;
        CS.showToast("Full screen is not available in this browser.");
      });
    showControls();
  }

  function clearIdle() {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdle() {
    clearIdle();
    if (!active || active.error || active.ended || dom.video.paused) return;
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      if (!active || active.error || active.ended || dom.video.paused) return;
      if (!dom.error.hidden || !dom.endCard.hidden) return;
      if (
        dom.frame.contains(document.activeElement) &&
        document.activeElement !== dom.frame &&
        document.activeElement !== dom.screen
      ) return;
      if ((dom.controls && dom.controls.matches(":hover")) || (dom.header && dom.header.matches(":hover"))) {
        scheduleIdle();
        return;
      }
      dom.cinema.classList.add("is-idle");
    }, 2800);
  }

  function showControls() {
    if (!active) return;
    dom.cinema.classList.remove("is-idle");
    scheduleIdle();
  }

  function handleKeydown(event) {
    if (!active) return false;
    if (event.key === "Tab") {
      CS.trapFocus(document.fullscreenElement === dom.screen ? dom.screen : dom.frame, event);
      return true;
    }
    if (event.key === "Escape") {
      if (document.fullscreenElement || dom.video.webkitDisplayingFullscreen) return false;
      event.preventDefault();
      close();
      return true;
    }
    const interactive = event.target.closest && event.target.closest("button, select, input, textarea, a");
    if (interactive) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const code = event.code;
    if (code === "Space" || event.key.toLowerCase() === "k") {
      event.preventDefault();
      togglePlay();
      return true;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekBy(-10);
      return true;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(10);
      return true;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      changeVolume(dom.video.volume + (event.key === "ArrowUp" ? 0.05 : -0.05));
      return true;
    }
    if (event.key.toLowerCase() === "m") {
      event.preventDefault();
      toggleMute();
      return true;
    }
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      toggleFullscreen();
      return true;
    }
    return false;
  }

  dom.video.addEventListener("loadedmetadata", () => {
    if (!active) return;
    if (!active.duration || !Number.isFinite(active.duration)) {
      active.duration = Number.isFinite(dom.video.duration) ? dom.video.duration : 0;
    }
    if (active.duration > 0) {
      dom.seekInput.max = String(active.duration);
      dom.timeTotal.textContent = CS.formatDuration(active.duration);
    }
    if (active.resumeAt > 0) {
      const target = clamp(active.resumeAt, 0, Math.max(0, (active.duration || dom.video.duration || 0) - 0.25));
      try {
        if (Math.abs(dom.video.currentTime - target) > 0.5) dom.video.currentTime = target;
      } catch {
        active.resumeAt = 0;
      }
      active.resumeAt = 0;
    }
    scheduleFrameFit();
    finishLoading();
    updatePlaybackUI();
    updateSeekAvailability();
    renderSubtitles();
  });

  dom.video.addEventListener("canplay", () => {
    if (!active) return;
    finishLoading();
    updatePlaybackUI();
  });

  dom.video.addEventListener("playing", () => {
    if (!active) return;
    dom.error.hidden = true;
    active.error = false;
    hideEndCard();
    updatePlaybackUI();
    scheduleIdle();
  });

  dom.video.addEventListener("play", () => {
    if (!active) return;
    updatePlaybackUI();
    showControls();
  });

  dom.video.addEventListener("pause", () => {
    if (!active) return;
    updatePlaybackUI();
    showControls();
  });

  dom.video.addEventListener("timeupdate", () => {
    if (!active) return;
    updatePlaybackUI();
    renderSubtitles();
  });

  dom.video.addEventListener("seeked", () => {
    if (!active) return;
    updatePlaybackUI();
    renderSubtitles();
  });

  dom.video.addEventListener("ended", () => {
    if (!active) return;
    showEndCard();
    updatePlaybackUI();
  });

  dom.video.addEventListener("volumechange", () => {
    updateVolumeUI();
  });

  dom.video.addEventListener("error", () => {
    if (!active || active.suppressVideoErrors || !dom.video.getAttribute("src")) return;
    const messages = {
      1: "Playback was interrupted before the film could begin.",
      2: "The network stopped delivering the prepared stream.",
      3: "This browser could not decode the prepared stream.",
      4: "The prepared stream is not available.",
    };
    const code = dom.video.error ? dom.video.error.code : 0;
    showError(messages[code] || "The projector could not play this film.");
  });

  dom.video.addEventListener("click", () => {
    if (active) togglePlay();
  });

  dom.playToggle.addEventListener("click", togglePlay);
  dom.bigPlay.addEventListener("click", () => {
    if (active) togglePlay();
  });
  dom.back10.addEventListener("click", () => seekBy(-10));
  dom.forward10.addEventListener("click", () => seekBy(10));
  dom.muteToggle.addEventListener("click", toggleMute);
  dom.volumeInput.addEventListener("input", () => changeVolume(dom.volumeInput.value));
  dom.fullscreen.addEventListener("click", toggleFullscreen);
  dom.frameToggle.addEventListener("click", toggleFrameMode);
  dom.close.addEventListener("click", () => close());
  dom.prev.addEventListener("click", () => {
    if (active) switchTo(active.index - 1);
  });
  dom.next.addEventListener("click", () => {
    if (active) switchTo(active.index + 1);
  });
  dom.seekInput.addEventListener("input", () => {
    seekTo(Number(dom.seekInput.value));
  });
  dom.audioSelect.addEventListener("change", () => {
    if (!active) return;
    if (active.hls) {
      selectHlsAudio(dom.audioSelect.value);
    } else if (dom.video.audioTracks && dom.video.audioTracks.length) {
      selectNativeAudio(dom.audioSelect.value);
    }
    showControls();
  });
  dom.subtitleSelect.addEventListener("change", () => {
    if (!active || !active.response) return;
    const value = dom.subtitleSelect.value;
    CS.setTrackPreference(active.video.path, "subtitle", value);
    if (value === "off") {
      clearSubtitles();
      return;
    }
    const track = (active.response.subtitle_tracks || []).find((item) => item.id === value);
    if (track) loadSubtitle(track);
    showControls();
  });
  dom.qualitySelect.addEventListener("change", changeQuality);
  dom.retry.addEventListener("click", retry);
  dom.errorClose.addEventListener("click", () => close());
  dom.endNext.addEventListener("click", () => {
    if (active) switchTo(active.index + 1);
  });
  dom.endClose.addEventListener("click", () => close());

  dom.frame.addEventListener("pointermove", showControls);
  dom.frame.addEventListener("pointerdown", showControls);
  dom.frame.addEventListener("focusin", showControls);
  window.addEventListener("resize", scheduleFrameFit);
  document.addEventListener("fullscreenchange", () => {
    updateFullscreenUI();
    scheduleFrameFit();
  });
  dom.video.addEventListener("webkitbeginfullscreen", updateFullscreenUI);
  dom.video.addEventListener("webkitendfullscreen", updateFullscreenUI);
  if ("ResizeObserver" in window) {
    frameResizeObserver = new window.ResizeObserver(() => scheduleFrameFit());
    frameResizeObserver.observe(dom.screen);
  }

  window.addEventListener("pagehide", () => {
    if (!active || !active.sessionId) return;
    try {
      navigator.sendBeacon(`/api/play/${encodeURIComponent(active.sessionId)}/stop`);
    } catch {
      return;
    }
  });

  dom.qualitySelect.value = readQuality();
  dom.volumeInput.value = String(readVolume());
  dom.video.volume = readVolume();
  dom.frame.setAttribute("tabindex", "-1");

  window.CineastePlayer = Object.freeze({
    open,
    close: () => close(),
    isOpen: () => Boolean(active),
    handleKeydown,
  });
})();
