(() => {
  "use strict";

  const CS = window.Cineaste;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const STORAGE_THEME = "cineaste.theme.v1";
  const CODEC_NAMES = {
    h264: "H.264",
    hevc: "HEVC",
    h265: "HEVC",
    vp8: "VP8",
    vp9: "VP9",
    av1: "AV1",
    aac: "AAC",
    ac3: "AC3",
    eac3: "E-AC3",
    dts: "DTS",
    truehd: "TrueHD",
    opus: "Opus",
    flac: "FLAC",
    mp3: "MP3",
  };

  const els = {
    app: document.getElementById("app"),
    main: document.getElementById("main"),
    findOpen: document.getElementById("find-open"),
    findDialog: document.getElementById("find-dialog"),
    findPanel: document.querySelector(".find-panel"),
    findClose: document.getElementById("find-close"),
    findInput: document.getElementById("find-input"),
    findResults: document.getElementById("find-results"),
    lights: document.getElementById("lights-toggle"),
    lightsLabel: document.getElementById("lights-label"),
    statusDot: document.getElementById("status-dot"),
    statusLine: document.getElementById("status-line"),
    collectionCount: document.getElementById("collection-count"),
    encoderStatus: document.getElementById("encoder-status"),
    todayDate: document.getElementById("today-date"),
    themeMeta: document.querySelector("meta[name='theme-color']"),
  };

  const state = {
    videos: [],
    server: null,
    loaded: false,
    route: { kind: "home", folder: "" },
    queue: [],
    theme: "paper",
    routeTitle: "Cinéaste — Private Edition",
    featureToken: 0,
    find: {
      open: false,
      returnFocus: null,
      items: [],
      activeIndex: -1,
    },
  };

  function icon(name) {
    return `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
  }

  function humanizeSegment(value) {
    const cleaned = String(value || "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
    return cleaned || "Untitled";
  }

  function prettyFolderPath(folder) {
    if (!folder) return "The flat shelf";
    return String(folder).split("/").filter(Boolean).map(humanizeSegment).join(" / ");
  }

  function folderTitle(folder) {
    if (!folder) return "The flat shelf";
    const segments = String(folder).split("/").filter(Boolean);
    return humanizeSegment(segments[segments.length - 1]);
  }

  function folderLine(folder) {
    return folder ? prettyFolderPath(folder) : "The flat shelf";
  }

  function parentFolder(folder) {
    const segments = String(folder || "").split("/").filter(Boolean);
    segments.pop();
    return segments.join("/");
  }

  function folderChildren(folder, videos) {
    const prefix = folder ? `${folder}/` : "";
    const children = new Map();
    for (const video of videos) {
      if (!video.folder || !video.folder.startsWith(prefix) || video.folder === folder) continue;
      const remainder = video.folder.slice(prefix.length);
      const name = remainder.split("/")[0];
      if (!name) continue;
      const path = folder ? `${folder}/${name}` : name;
      const entry = children.get(path) || { path, name, count: 0, size: 0 };
      entry.count += 1;
      entry.size += Number(video.size) || 0;
      children.set(path, entry);
    }
    return Array.from(children.values()).sort((left, right) => collator.compare(left.name, right.name));
  }

  function sortByTitle(videos) {
    return videos.slice().sort((left, right) => collator.compare(left.title, right.title));
  }

  function sortByRecent(videos) {
    return videos.slice().sort((left, right) => {
      const difference = Number(right.modified) - Number(left.modified);
      return difference || collator.compare(left.title, right.title);
    });
  }

  function groupShelves(videos) {
    const groups = new Map();
    for (const video of videos) {
      const key = video.folder || "";
      const entry = groups.get(key) || { folder: key, videos: [], size: 0 };
      entry.videos.push(video);
      entry.size += Number(video.size) || 0;
      groups.set(key, entry);
    }
    return Array.from(groups.values()).sort((left, right) => {
      if (!left.folder) return -1;
      if (!right.folder) return 1;
      return collator.compare(folderLine(left.folder), folderLine(right.folder));
    });
  }

  function folderVideos(folder) {
    const prefix = folder ? `${folder}/` : "";
    return state.videos.filter((video) => video.folder === folder || video.folder.startsWith(prefix));
  }

  function videoByPath(path) {
    return state.videos.find((video) => video.path === path) || null;
  }

  function updateNav(active) {
    document.querySelectorAll("[data-nav]").forEach((link) => {
      if (link.dataset.nav === active) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  function applyRouteTitle(title) {
    state.routeTitle = title === "Screening room" ? "Cinéaste — Private Edition" : `${title} — Cinéaste`;
    if (!window.CineastePlayer || !window.CineastePlayer.isOpen()) {
      document.title = state.routeTitle;
    }
  }

  function sectionHead(number, title, note) {
    return `
      <header class="section-head">
        <span class="section-head__no">${CS.escapeHTML(number)}</span>
        <h2 class="section-head__title">${CS.escapeHTML(title)}</h2>
        ${note ? `<p class="section-head__note">${CS.escapeHTML(note)}</p>` : "<span></span>"}
      </header>
    `;
  }

  function shelfMarkup(folder, count, size, index) {
    const href = folder ? CS.folderHash(folder) : "#/all";
    const title = folderTitle(folder);
    return `
      <a class="shelf" href="${CS.escapeAttribute(href)}" style="--i:${index}" aria-label="Open ${CS.escapeAttribute(folderLine(folder))}, ${CS.escapeAttribute(CS.plural(count, "film"))}">
        <span class="shelf__no">${String(index + 1).padStart(2, "0")}</span>
        <span>
          <span class="shelf__title">${CS.escapeHTML(title)}</span>
          <span class="shelf__meta">${CS.escapeHTML(CS.plural(count, "film"))} · ${CS.escapeHTML(CS.formatBytes(size))}</span>
        </span>
        <span class="shelf__arrow">${icon("arrow-up-right")}</span>
      </a>
    `;
  }

  function filmCardMarkup(video, index, { lead = false } = {}) {
    const image = CS.thumbnailURL(video);
    return `
      <article class="film-card${lead ? " film-card--lead" : ""}" style="--i:${index}">
        <button class="film-card__button" type="button" data-play-path="${CS.escapeAttribute(video.path)}" aria-label="Play ${CS.escapeAttribute(video.title)}">
          <span class="film-card__visual">
            <img src="${CS.escapeAttribute(image)}" alt="" loading="lazy" decoding="async">
            <span class="film-card__index">No. ${String(index + 1).padStart(2, "0")}</span>
            <span class="film-card__format">${CS.escapeHTML(CS.extensionLabel(video.extension))}</span>
            <span class="film-card__play">${icon("play")}</span>
          </span>
          <span class="film-card__body">
            <span class="film-card__shelf">${CS.escapeHTML(folderLine(video.folder))}</span>
            <span class="film-card__title">${CS.escapeHTML(video.title)}</span>
            <span class="film-card__meta">
              <span>${CS.escapeHTML(CS.formatBytes(video.size))}</span>
              <span>${CS.escapeHTML(CS.formatDate(video.modified))}</span>
            </span>
          </span>
        </button>
      </article>
    `;
  }

  function lanTicketMarkup() {
    const server = state.server;
    if (!server) return "";
    const primary = server.primary_url || window.location.origin;
    const localOnly = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/i.test(primary);
    const addresses = Array.isArray(server.addresses) ? server.addresses : [];
    const seen = new Set([primary]);
    const others = addresses
      .map((address) => address.url)
      .filter((url) => {
        if (!url || seen.has(url)) return false;
        seen.add(url);
        return true;
      });
    const display = primary.replace(/^https?:\/\//i, "");
    return `
      <aside class="lan-ticket" aria-label="Private network address">
        <div class="lan-ticket__main">
          <div class="lan-ticket__top">
            <span class="lan-ticket__live">House open</span>
            <span>Admit one</span>
          </div>
          <p class="lan-ticket__label">${localOnly ? "Share on your home network" : "On your tablet or another room"}</p>
          <button class="lan-ticket__address" type="button" data-copy-url="${CS.escapeAttribute(primary)}" aria-label="Copy private address ${CS.escapeAttribute(primary)}">
            <span>${CS.escapeHTML(display)}</span>
            ${icon("copy")}
          </button>
          <p class="lan-ticket__hint">${localOnly ? "Join this laptop to Wi-Fi to share the screening room." : "Tap to copy · same Wi-Fi · no account"}</p>
          ${others.length ? `
            <details class="lan-ticket__other">
              <summary>Other network addresses</summary>
              <ul>
                ${others.map((url) => `<li><button type="button" data-copy-url="${CS.escapeAttribute(url)}">${CS.escapeHTML(url)}</button></li>`).join("")}
              </ul>
            </details>
          ` : ""}
        </div>
        <div class="lan-ticket__serial">
          <span>Private edition</span>
          <span>Vol. 01</span>
          <span>Admit one</span>
        </div>
      </aside>
    `;
  }

  function featureMarkup(video, sorted) {
    const folderHref = video.folder ? CS.folderHash(video.folder) : "#/all";
    return `
      <section class="feature" aria-labelledby="feature-title">
        <div class="feature__visual">
          <div class="feature__frame" data-feature-visual="${CS.escapeAttribute(video.path)}">
            <div class="feature__image">
              <img src="${CS.escapeAttribute(CS.thumbnailURL(video))}" alt="" fetchpriority="high" decoding="async">
            </div>
            <span class="feature__badge">Latest acquisition</span>
            <button class="feature__shutter" type="button" data-play-path="${CS.escapeAttribute(video.path)}" aria-label="Play ${CS.escapeAttribute(video.title)}">
              ${icon("play")}
            </button>
          </div>
          <div class="feature__slug">
            <span>${CS.escapeHTML(folderLine(video.folder))}</span>
            <span>Arrived ${CS.escapeHTML(CS.formatDate(video.modified))}</span>
          </div>
        </div>
        <div class="feature__copy">
          <p class="eyebrow feature__kicker">From the archive · Latest acquisition</p>
          <h1 class="feature__title" id="feature-title" tabindex="-1" data-page-heading>${CS.escapeHTML(video.title)}</h1>
          <p class="feature__note">The newest arrival in this private collection, ready for the largest screen in the house. No algorithm chose it. It is simply here, with the rest of the films on your shelf.</p>
          <dl class="feature__specs">
            <div><dt>Format</dt><dd id="feature-format">${CS.escapeHTML(CS.extensionLabel(video.extension))} · ${CS.escapeHTML(CS.formatBytes(video.size))}</dd></div>
            <div><dt>Runtime</dt><dd id="feature-runtime">Reading the print…</dd></div>
            <div><dt>Sound</dt><dd id="feature-audio">Reading the print…</dd></div>
            <div><dt>Shelf</dt><dd><a href="${CS.escapeAttribute(folderHref)}">${CS.escapeHTML(folderTitle(video.folder))}</a></dd></div>
          </dl>
          <div class="feature__actions">
            <button class="button-primary" type="button" data-play-path="${CS.escapeAttribute(video.path)}">
              ${icon("play")}
              Watch the film
            </button>
            <a class="button-quiet" href="${CS.escapeAttribute(folderHref)}">${video.folder ? "Browse the shelf" : "Browse all films"} ${icon("arrow-right")}</a>
          </div>
          ${lanTicketMarkup()}
        </div>
      </section>
      <p class="sr-only">${CS.escapeHTML(CS.plural(sorted.length, "film"))} in the collection.</p>
    `;
  }

  function pageHead({ breadcrumbs, kicker, title, note, count, backHref, backLabel }) {
    const crumbs = breadcrumbs.map((crumb, index) => {
      const last = index === breadcrumbs.length - 1;
      if (last || !crumb.href) {
        return `<span aria-current="page">${CS.escapeHTML(crumb.label)}</span>`;
      }
      return `<a href="${CS.escapeAttribute(crumb.href)}">${CS.escapeHTML(crumb.label)}</a>`;
    }).join(`<span class="breadcrumbs__sep" aria-hidden="true">/</span>`);
    return `
      <section class="page-head">
        <nav class="breadcrumbs" aria-label="Breadcrumb">${crumbs}</nav>
        <div class="page-head__grid">
          <div>
            <p class="eyebrow page-head__kicker">${CS.escapeHTML(kicker)}</p>
            <h1 class="page-title" tabindex="-1" data-page-heading>${CS.escapeHTML(title)}</h1>
          </div>
          <div class="page-head__aside">
            <p class="page-head__note">${CS.escapeHTML(note)}</p>
            <p class="page-head__count">${CS.escapeHTML(count)}</p>
            ${backHref ? `<a class="button-quiet page-head__back" href="${CS.escapeAttribute(backHref)}">${CS.escapeHTML(backLabel || "One shelf up")}</a>` : ""}
          </div>
        </div>
      </section>
    `;
  }

  function emptyLibraryMarkup() {
    return `
      <section class="empty-state">
        <p class="eyebrow">The archive is waiting</p>
        <h1 tabindex="-1" data-page-heading>The house is dark.</h1>
        <p>There are no films in the library yet. Point Cinéaste at a folder of films, then come back and open the house.</p>
        <code class="empty-code">python server.py "D:\\Movies"</code>
        <button class="button-primary" type="button" data-retry>
          ${icon("retry")}
          Look again
        </button>
      </section>
    `;
  }

  function fatalMarkup(message) {
    return `
      <section class="empty-state">
        <p class="eyebrow">A projection problem</p>
        <h1 tabindex="-1" data-page-heading>The projector is offline.</h1>
        <p>${CS.escapeHTML(message || "Cinéaste could not reach the library. Check that the server window is still open.")}</p>
        <button class="button-primary" type="button" data-retry>
          ${icon("retry")}
          Try the projector again
        </button>
      </section>
    `;
  }

  function hydrateFeature(video) {
    const token = ++state.featureToken;
    CS.fetchJSON(`/api/media-info/${CS.encodePath(video.path)}`)
      .then((info) => {
        if (!state.loaded || token !== state.featureToken || state.route.kind !== "home") return;
        const feature = videoByPath(video.path);
        if (!feature) return;
        const media = info.video || {};
        const formatParts = [CS.extensionLabel(feature.extension).replace(/^\./, "")];
        if (media.codec_name) formatParts.push(CODEC_NAMES[String(media.codec_name).toLowerCase()] || String(media.codec_name).toUpperCase());
        if (media.height) formatParts.push(`${media.height}p`);
        const format = document.getElementById("feature-format");
        const runtime = document.getElementById("feature-runtime");
        const audio = document.getElementById("feature-audio");
        if (format) format.textContent = formatParts.join(" · ");
        if (runtime) runtime.textContent = Number(info.duration) > 0 ? CS.formatDuration(info.duration) : "Runtime unknown";
        if (audio) {
          const tracks = info.audio_tracks || [];
          const firstCodec = tracks[0] && tracks[0].codec;
          const codec = firstCodec ? CODEC_NAMES[String(firstCodec).toLowerCase()] || String(firstCodec).toUpperCase() : "";
          audio.textContent = tracks.length
            ? [CS.plural(tracks.length, "track"), codec].filter(Boolean).join(" · ")
            : "Silent print";
        }
      })
      .catch(() => {});
  }

  function renderHome({ focus = false } = {}) {
    if (!state.videos.length) {
      applyRouteTitle("The empty house");
      updateNav("home");
      state.queue = [];
      els.app.innerHTML = emptyLibraryMarkup();
      focusHeading(focus);
      return;
    }
    const sorted = sortByRecent(state.videos);
    const feature = sorted[0];
    const shelves = groupShelves(state.videos);
    const recent = sorted.filter((video) => video.path !== feature.path).slice(0, 6);
    state.queue = sorted;
    const shelfSection = shelves.length
      ? `<section class="section">${sectionHead("01", "The shelves", `${CS.plural(shelves.length, "shelf", "shelves")} · ${CS.plural(state.videos.length, "film")}`)}<div class="shelf-grid">${shelves.map((shelf, index) => shelfMarkup(shelf.folder, shelf.videos.length, shelf.size, index)).join("")}</div></section>`
      : "";
    const recentSection = recent.length
      ? `<section class="section">${sectionHead(shelves.length ? "02" : "01", "Just arrived", "Newest additions to the private collection.")}<div class="collection-grid">${recent.map((video, index) => filmCardMarkup(video, index, { lead: index === 0 && recent.length >= 3 })).join("")}</div></section>`
      : "";
    applyRouteTitle("Screening room");
    updateNav("home");
    els.app.innerHTML = `${featureMarkup(feature, sorted)}${shelfSection}${recentSection}`;
    hydrateFeature(feature);
    focusHeading(focus);
  }

  function renderAll({ focus = false } = {}) {
    if (!state.videos.length) {
      applyRouteTitle("All films");
      updateNav("all");
      state.queue = [];
      els.app.innerHTML = `${pageHead({
        breadcrumbs: [{ label: "Screening room", href: "#/" }, { label: "All films" }],
        kicker: "The archive",
        title: "The whole archive",
        note: "Every film in the house, gathered in one programme.",
        count: "0 films",
      })}${emptyLibraryMarkup()}`;
      focusHeading(focus);
      return;
    }
    const archive = sortByTitle(state.videos);
    state.queue = archive;
    const cards = archive.map((video, index) => filmCardMarkup(video, index, { lead: index === 0 && archive.length >= 3 })).join("");
    applyRouteTitle("All films");
    updateNav("all");
    els.app.innerHTML = `
      ${pageHead({
        breadcrumbs: [{ label: "Screening room", href: "#/" }, { label: "All films" }],
        kicker: "The archive",
        title: "The whole archive",
        note: "Every film in the house, in alphabetical order. Pull up a chair and stay a while.",
        count: `${CS.plural(archive.length, "film")} · ${CS.plural(groupShelves(archive).length, "shelf", "shelves")}`,
        backHref: "#/",
        backLabel: "Back to the screening room",
      })}
      <section class="section">
        ${sectionHead("01", "The complete programme", "Alphabetical · newest additions marked by the box office.")}
        <div class="collection-grid">${cards}</div>
      </section>
    `;
    focusHeading(focus);
  }

  function renderFolder({ focus = false } = {}) {
    const folder = state.route.folder;
    const all = folderVideos(folder);
    if (!all.length) {
      applyRouteTitle("No such shelf");
      updateNav("");
      state.queue = [];
      els.app.innerHTML = `
        ${pageHead({
          breadcrumbs: [{ label: "Screening room", href: "#/" }, { label: "No such shelf" }],
          kicker: "The archive",
          title: "No such shelf",
          note: "This corner of the archive is empty, or the shelf has been moved. The house is still open.",
          count: "0 films",
          backHref: "#/",
          backLabel: "Back to the screening room",
        })}
        <section class="empty-state">
          <p class="eyebrow">An empty corner</p>
          <h1 tabindex="-1" data-page-heading>Nothing on this shelf.</h1>
          <p>Return to the screening room and wander a little further into the archive.</p>
          <a class="button-primary" href="#/">${icon("arrow-left")} Return to the screening room</a>
        </section>
      `;
      focusHeading(focus);
      return;
    }
    const direct = sortByTitle(all.filter((video) => video.folder === folder));
    const children = folderChildren(folder, all);
    state.queue = direct;
    const segments = String(folder).split("/").filter(Boolean);
    const crumbs = [{ label: "Screening room", href: "#/" }];
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      crumbs.push({
        label: humanizeSegment(segment),
        href: index === segments.length - 1 ? "" : CS.folderHash(path),
      });
    });
    const parent = parentFolder(folder);
    const totalSize = all.reduce((sum, video) => sum + (Number(video.size) || 0), 0);
    const childCount = children.length;
    const note = childCount && direct.length
      ? `A working shelf of ${CS.plural(direct.length, "film")}, with ${CS.plural(childCount, "deeper shelf", "deeper shelves")} to wander.`
      : childCount
        ? `A passage to ${CS.plural(childCount, "deeper shelf", "deeper shelves")}, holding ${CS.plural(all.length, "film")} between them.`
        : `${CS.plural(direct.length, "film")} resting on this shelf, waiting for a screening.`;
    const childSection = childCount
      ? `<section class="section">${sectionHead("01", "Within this shelf", `${CS.plural(childCount, "deeper shelf", "deeper shelves")} · ${CS.plural(all.length, "film")} beneath`)}<div class="shelf-grid">${children.map((child, index) => shelfMarkup(child.path, child.count, child.size, index)).join("")}</div></section>`
      : "";
    const filmSection = direct.length
      ? `<section class="section">${sectionHead(childCount ? "02" : "01", "Films on this shelf", `${CS.plural(direct.length, "print")} · ${CS.formatBytes(totalSize)}`)}<div class="collection-grid">${direct.map((video, index) => filmCardMarkup(video, index, { lead: index === 0 && direct.length >= 3 })).join("")}</div></section>`
      : "";
    applyRouteTitle(folderTitle(folder));
    updateNav("all");
    els.app.innerHTML = `
      ${pageHead({
        breadcrumbs: crumbs,
        kicker: "Shelf",
        title: folderTitle(folder),
        note,
        count: `${CS.plural(all.length, "film")} beneath · ${CS.formatBytes(totalSize)}`,
        backHref: parent ? CS.folderHash(parent) : "#/",
        backLabel: parent ? "One shelf up" : "Back to the screening room",
      })}
      ${childSection}
      ${filmSection}
    `;
    focusHeading(focus);
  }

  function focusHeading(enabled) {
    if (!enabled || window.CineastePlayer.isOpen()) return;
    const heading = els.app.querySelector("[data-page-heading]");
    if (!heading) return;
    window.requestAnimationFrame(() => {
      heading.focus({ preventScroll: true });
    });
  }

  function parseRoute() {
    const hash = window.location.hash || "#/";
    if (hash === "#/all") return { kind: "all", folder: "" };
    if (hash.startsWith("#/folder/")) {
      let folder = hash.slice("#/folder/".length);
      try {
        folder = decodeURIComponent(folder);
      } catch {
        folder = hash.slice("#/folder/".length);
      }
      folder = folder.replace(/^\/+|\/+$/g, "");
      if (folder) return { kind: "folder", folder };
    }
    return { kind: "home", folder: "" };
  }

  function renderRoute({ focus = false } = {}) {
    if (!state.loaded) return;
    state.route = parseRoute();
    if (focus) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (state.route.kind === "all") {
      renderAll({ focus });
    } else if (state.route.kind === "folder") {
      renderFolder({ focus });
    } else {
      renderHome({ focus });
    }
  }

  function searchVideos(query) {
    const normalized = CS.normalizeText(query).trim();
    if (!normalized) return [];
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const matches = [];
    for (const video of state.videos) {
      const title = CS.normalizeText(video.title);
      const folder = CS.normalizeText(video.folder);
      const extension = CS.normalizeText(video.extension);
      const haystack = `${title} ${folder} ${extension}`;
      if (!tokens.every((token) => haystack.includes(token))) continue;
      let score = 5;
      if (title === normalized) score = 0;
      else if (title.startsWith(normalized)) score = 1;
      else if (title.includes(normalized)) score = 2;
      else if (folder.includes(normalized)) score = 3;
      else if (extension.includes(normalized)) score = 4;
      matches.push({ video, score });
    }
    matches.sort((left, right) => {
      const byScore = left.score - right.score;
      if (byScore) return byScore;
      return collator.compare(left.video.title, right.video.title);
    });
    return matches.slice(0, 30).map((entry) => entry.video);
  }

  function findResultMarkup(video, index) {
    return `
      <button class="find-result${index === 0 ? " is-first" : ""}" type="button" data-find-path="${CS.escapeAttribute(video.path)}" aria-label="Play ${CS.escapeAttribute(video.title)}">
        <span class="find-result__no">${String(index + 1).padStart(2, "0")}</span>
        <span class="find-result__title">${CS.escapeHTML(video.title)}</span>
        <span class="find-result__folder">${CS.escapeHTML(folderLine(video.folder))}</span>
        <span class="find-result__format">${CS.escapeHTML(CS.extensionLabel(video.extension))}</span>
        ${icon("arrow-right")}
      </button>
    `;
  }

  function renderFindResults(query) {
    const trimmed = String(query || "").trim();
    const items = trimmed ? searchVideos(trimmed) : sortByRecent(state.videos).slice(0, 6);
    state.find.items = items;
    state.find.activeIndex = items.length ? 0 : -1;
    if (!items.length) {
      els.findResults.innerHTML = `
        <div class="find-empty">
          <strong>No match on the shelf.</strong>
          <span>Try a broader title, a folder name, or a format such as MKV.</span>
        </div>
      `;
      return;
    }
    const label = trimmed
      ? `${CS.plural(items.length, "film")}${items.length === 30 ? "+" : ""} matching “${trimmed.slice(0, 48)}”`
      : "Recently added";
    els.findResults.innerHTML = `
      <p class="find-group">${CS.escapeHTML(label)}</p>
      ${items.map(findResultMarkup).join("")}
    `;
  }

  function openFind() {
    if (window.CineastePlayer.isOpen() || state.find.open) return;
    state.find.open = true;
    state.find.returnFocus = document.activeElement;
    state.find.items = [];
    state.find.activeIndex = -1;
    els.findDialog.hidden = false;
    els.findOpen.setAttribute("aria-expanded", "true");
    CS.beginBlocking("find");
    els.findInput.value = "";
    renderFindResults("");
    window.requestAnimationFrame(() => {
      els.findInput.focus({ preventScroll: true });
      els.findInput.select();
    });
  }

  function closeFind({ restoreFocus = true } = {}) {
    if (!state.find.open) return;
    const returnFocus = state.find.returnFocus;
    state.find.open = false;
    state.find.items = [];
    state.find.activeIndex = -1;
    els.findDialog.hidden = true;
    els.findResults.innerHTML = "";
    els.findOpen.setAttribute("aria-expanded", "false");
    CS.endBlocking("find");
    if (restoreFocus && returnFocus && typeof returnFocus.focus === "function" && returnFocus.isConnected) {
      window.setTimeout(() => returnFocus.focus({ preventScroll: true }), 20);
    }
  }

  function focusFindResult(direction) {
    const buttons = Array.from(els.findResults.querySelectorAll("[data-find-path]"));
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement);
    let index;
    if (current === -1) {
      index = direction > 0 ? 0 : buttons.length - 1;
    } else {
      index = (current + direction + buttons.length) % buttons.length;
    }
    state.find.activeIndex = index;
    buttons[index].focus();
  }

  function launchPlayer(video, queue, index, returnFocus) {
    if (!video) return;
    if (!window.CineastePlayer || typeof window.CineastePlayer.open !== "function") {
      CS.showToast("The projector controls did not load. Reload the page and try again.");
      return;
    }
    const resolvedIndex = index >= 0 ? index : queue.findIndex((item) => item.path === video.path);
    window.CineastePlayer.open({
      video,
      queue,
      index: resolvedIndex < 0 ? 0 : resolvedIndex,
      returnFocus,
    });
  }

  function openFromPath(path, queue, returnFocus) {
    const video = queue.find((item) => item.path === path) || videoByPath(path);
    if (!video) return;
    const activeQueue = queue && queue.length ? queue : [video];
    const index = activeQueue.findIndex((item) => item.path === path);
    launchPlayer(video, activeQueue, index < 0 ? 0 : index, returnFocus);
  }

  function openFindResult(path) {
    const index = state.find.items.findIndex((video) => video.path === path);
    const video = state.find.items[index] || videoByPath(path);
    if (!video) return;
    const queue = state.find.items.slice();
    if (!queue.some((item) => item.path === video.path)) queue.unshift(video);
    const resolvedIndex = queue.findIndex((item) => item.path === video.path);
    const returnFocus = els.findOpen;
    closeFind({ restoreFocus: false });
    launchPlayer(video, queue, resolvedIndex, returnFocus);
  }

  function readTheme() {
    return CS.storageGet(STORAGE_THEME, "paper") === "ink" ? "ink" : "paper";
  }

  function applyTheme(theme, announce = false) {
    state.theme = theme === "ink" ? "ink" : "paper";
    document.documentElement.dataset.theme = state.theme;
    document.body.dataset.theme = state.theme;
    els.lights.setAttribute("aria-pressed", state.theme === "ink" ? "true" : "false");
    els.lights.setAttribute("aria-label", state.theme === "ink" ? "Raise the house lights" : "Dim the house lights");
    els.themeMeta?.setAttribute("content", state.theme === "ink" ? "#12100e" : "#f2e8d8");
    CS.storageSet(STORAGE_THEME, state.theme);
    if (announce) {
      CS.showToast(state.theme === "ink" ? "House lights down. The room is ready." : "House lights up. The paper returns.");
    }
  }

  function updateDate() {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    els.todayDate.dateTime = date;
    els.todayDate.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(now);
  }

  function updateStatus(offline = false) {
    if (offline) {
      els.statusDot.classList.add("is-offline");
      els.statusLine.textContent = "Projection booth offline";
      els.collectionCount.textContent = "— films";
      els.encoderStatus.textContent = "Check the server";
      els.encoderStatus.title = "";
      return;
    }
    els.statusDot.classList.remove("is-offline");
    const count = state.videos.length;
    const shelves = groupShelves(state.videos).length;
    els.collectionCount.textContent = CS.plural(count, "film");
    els.statusLine.textContent = count
      ? `${CS.plural(count, "film")} across ${CS.plural(shelves, "shelf", "shelves")}`
      : "The archive is empty";
    const server = state.server;
    if (!server) {
      els.encoderStatus.textContent = "Projector ready";
      els.encoderStatus.title = "";
      return;
    }
    if (!server.ffmpeg) {
      els.encoderStatus.textContent = "FFmpeg not found";
      els.encoderStatus.title = "Transcoding and thumbnails are unavailable until FFmpeg is installed.";
      return;
    }
    const encoder = server.encoder || "";
    if (["h264_nvenc", "h264_qsv", "h264_amf"].includes(encoder)) {
      els.encoderStatus.textContent = "Hardware projector";
    } else if (encoder === "libx264") {
      els.encoderStatus.textContent = "CPU projector";
    } else if (encoder === "detecting") {
      els.encoderStatus.textContent = "Warming the projector";
    } else if (encoder === "unavailable") {
      els.encoderStatus.textContent = "Projector unavailable";
    } else {
      els.encoderStatus.textContent = "Projector ready";
    }
    els.encoderStatus.title = encoder ? `Encoder: ${encoder}` : "";
  }

  function openingMarkup() {
    return `
      <div class="opening" aria-live="polite">
        <div class="opening__reel" aria-hidden="true"><span></span></div>
        <p class="eyebrow">Opening the house</p>
        <p class="opening__line">Threading the first reel…</p>
      </div>
    `;
  }

  function normalizeVideos(raw) {
    if (!Array.isArray(raw)) throw new Error("The library returned an unreadable film list.");
    return raw
      .filter((item) => item && typeof item.path === "string" && item.path)
      .map((item) => ({
        ...item,
        path: String(item.path),
        title: String(item.title || item.path),
        folder: String(item.folder || ""),
        extension: String(item.extension || ""),
        size: Number(item.size) || 0,
        modified: Number(item.modified) || 0,
      }));
  }

  async function loadLibrary({ initial = false } = {}) {
    const token = (state.loadToken || 0) + 1;
    state.loadToken = token;
    state.loaded = false;
    state.featureToken += 1;
    if (!initial) {
      els.app.innerHTML = openingMarkup();
      els.statusLine.textContent = "Opening the house";
      els.collectionCount.textContent = "— films";
      els.encoderStatus.textContent = "Projector at rest";
      els.statusDot.classList.remove("is-offline");
    }
    const [videosResult, serverResult] = await Promise.allSettled([
      CS.fetchJSON("/api/videos"),
      CS.fetchJSON("/api/server-info"),
    ]);
    if (token !== state.loadToken) return;
    state.server = serverResult.status === "fulfilled" ? serverResult.value : null;
    if (videosResult.status === "rejected") {
      state.videos = [];
      state.loaded = false;
      state.routeTitle = "Projection problem — Cinéaste";
      document.title = state.routeTitle;
      updateStatus(true);
      els.app.innerHTML = fatalMarkup(videosResult.reason ? videosResult.reason.message : "");
      return;
    }
    try {
      state.videos = normalizeVideos(videosResult.value);
    } catch (error) {
      state.videos = [];
      state.loaded = false;
      state.routeTitle = "Projection problem — Cinéaste";
      document.title = state.routeTitle;
      updateStatus(true);
      els.app.innerHTML = fatalMarkup(error.message);
      return;
    }
    state.loaded = true;
    updateStatus(false);
    renderRoute({ focus: false });
  }

  async function handleCopy(button, url) {
    if (!button || !url) return;
    const copied = await CS.copyText(url);
    if (!copied) {
      CS.showToast("The address could not be copied. Select it and copy it by hand.");
      return;
    }
    button.classList.add("is-copied");
    const use = button.querySelector("use");
    if (use) use.setAttribute("href", "#icon-check");
    window.clearTimeout(button._copyTimer);
    button._copyTimer = window.setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove("is-copied");
      if (use) use.setAttribute("href", "#icon-copy");
    }, 2300);
    CS.showToast("Address copied. Open it on a device on the same Wi-Fi.");
  }

  els.app.addEventListener("click", (event) => {
    const copyButton = event.target.closest("[data-copy-url]");
    if (copyButton) {
      event.preventDefault();
      handleCopy(copyButton, copyButton.dataset.copyUrl);
      return;
    }
    const retryButton = event.target.closest("[data-retry]");
    if (retryButton) {
      event.preventDefault();
      loadLibrary({ initial: false });
      return;
    }
    const playButton = event.target.closest("[data-play-path]");
    if (playButton) {
      event.preventDefault();
      openFromPath(playButton.dataset.playPath, state.queue, playButton);
      return;
    }
    const visual = event.target.closest("[data-feature-visual]");
    if (visual && !event.target.closest("button")) {
      event.preventDefault();
      const shutter = visual.querySelector("[data-play-path]");
      openFromPath(visual.dataset.featureVisual, state.queue, shutter || els.main);
    }
  });

  els.findOpen.addEventListener("click", openFind);
  els.findClose.addEventListener("click", () => closeFind());
  els.findDialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-find]") || event.target.closest("#find-close")) {
      closeFind();
      return;
    }
    const result = event.target.closest("[data-find-path]");
    if (result) {
      event.preventDefault();
      openFindResult(result.dataset.findPath);
    }
  });

  els.findInput.addEventListener("input", () => {
    renderFindResults(els.findInput.value);
  });

  els.findInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusFindResult(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const first = state.find.items[0];
      if (first) openFindResult(first.path);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    }
  });

  els.findResults.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      focusFindResult(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      const buttons = Array.from(els.findResults.querySelectorAll("[data-find-path]"));
      if (!buttons.length) return;
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : buttons.length - 1].focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
    }
  });

  els.lights.addEventListener("click", () => {
    applyTheme(state.theme === "ink" ? "paper" : "ink", true);
  });

  document.addEventListener("keydown", (event) => {
    if (window.CineastePlayer.isOpen()) {
      window.CineastePlayer.handleKeydown(event);
      return;
    }
    if (state.find.open) {
      if (event.key === "Tab") {
        CS.trapFocus(els.findPanel, event);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeFind();
      }
      return;
    }
    if (event.key === "/" && !CS.isTypingTarget(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!state.loaded) return;
      event.preventDefault();
      openFind();
    }
  });

  document.addEventListener("cineaste:player-closed", () => {
    document.title = state.routeTitle;
  });

  window.addEventListener("hashchange", () => {
    if (state.find.open) closeFind({ restoreFocus: false });
    renderRoute({ focus: !window.CineastePlayer.isOpen() });
  });

  function boot() {
    applyTheme(readTheme(), false);
    updateDate();
    els.findOpen.setAttribute("aria-expanded", "false");
    loadLibrary({ initial: true });
  }

  boot();
})();
