// Shared video playlist for the p5 sketches.
//
// Entries can be local files ("media/video_2.mp4"), archive.org pages
// ("https://archive.org/details/ID"), bare archive.org ids, or direct video
// urls. The playlist is editable from the page header and saved per page.
//
// archive.org's /download/ urls have no CORS headers, so the sketches couldn't
// read their pixels (vid.get, VideoFrame, Vida). Its /cors/ endpoint serves
// the same files with CORS, but without range requests, so videos aren't
// seekable: for a random start they're downloaded whole and played as a blob.
//
// Usage (p5 global mode):
//   const videos = new VideoSource({
//     defaults: ["media/video_1.mp4", "https://archive.org/details/ID"],
//     size: () => [windowWidth, windowHeight],
//     onChange: (v) => (vid = v), // new element, or null while switching
//     onReady: (v) => {},         // first frame available
//   });
//   // in setup(), after createCanvas():
//   videos.load();

class VideoSource {
  static resolved = new Map();

  // bigger files stream from the start instead of being downloaded whole
  static MAX_BLOB_BYTES = 200 * 1024 * 1024;

  constructor({
    defaults = [],
    storageKey = `${location.pathname}:video-urls`,
    size = null,
    randomStart = true,
    onChange = () => {},
    onReady = () => {},
    ui = true,
  } = {}) {
    this.defaults = defaults;
    this.storageKey = storageKey;
    this.size = size;
    this.randomStart = randomStart;
    this.onChange = onChange;
    this.onReady = onReady;
    this.urls = VideoSource.shuffle(this.loadSaved() || [...defaults]);
    this.index = 0;
    this.vid = null;
    this.token = 0;
    this.failed = 0;
    if (ui) VideoSource.onDomReady(() => this.mountUI());
  }

  // --- url parsing -------------------------------------------------------

  // -> { id, file } for archive.org pages/ids, null for anything else.
  // file is set for links to one file of an item: /details/ID/name.mp4
  static archiveItem(entry) {
    const m = entry.match(/archive\.org\/(?:details|embed)\/([^/?#]+)(?:\/([^?#]+))?/);
    if (m) {
      const decode = (s) => decodeURIComponent(s.replace(/\+/g, " "));
      return { id: decode(m[1]), file: m[2] ? decode(m[2]) : null };
    }
    if (/^[\w.-]+$/.test(entry) && !/\.(mp4|webm|ogv|mov|m4v)$/i.test(entry))
      return { id: entry, file: null };
    return null;
  }

  // archive.org/download/ID/file and dnXXXX.archive.org/N/items/ID/file
  static corsUrl(url) {
    const m = url.match(
      /^https?:\/\/(?:[\w-]+\.)*archive\.org\/(?:download\/|\d+\/items\/)(.+)$/
    );
    return m ? `https://archive.org/cors/${m[1]}` : url;
  }

  static async resolve(entry) {
    const item = VideoSource.archiveItem(entry);
    if (!item) return VideoSource.corsUrl(entry);
    if (VideoSource.resolved.has(entry)) return VideoSource.resolved.get(entry);
    const { id, file } = item;
    const res = await fetch(`https://archive.org/metadata/${id}`);
    const meta = await res.json();
    const videos = (meta.files || [])
      .map((f) => f.name)
      .filter((n) => /\.(mp4|webm|ogv|m4v)$/i.test(n));
    const pick =
      (file && videos.find((n) => n === file)) ||
      videos.find((n) => /_512kb\.mp4$/i.test(n)) ||
      videos.find((n) => /\.mp4$/i.test(n)) ||
      videos[0];
    if (!pick) throw new Error(`no video in archive.org item ${id}`);
    const path = pick.split("/").map(encodeURIComponent).join("/");
    const url = `https://archive.org/cors/${encodeURIComponent(id)}/${path}`;
    VideoSource.resolved.set(entry, url);
    return url;
  }

  // --- playback ----------------------------------------------------------

  async load({ retry = false } = {}) {
    this.unload();
    if (!this.urls.length) return;
    const token = ++this.token;
    this.retried = retry;
    const entry = this.urls[this.index];
    let src;
    try {
      src = await VideoSource.resolve(entry);
      if (token !== this.token) return;
      if (this.randomStart && src.startsWith("https://archive.org/cors/"))
        src = await this.download(src, token);
    } catch (e) {
      if (e.name === "AbortError") return;
      console.warn(e);
      return this.skip(token);
    }
    if (token !== this.token) return;

    // crossOrigin must be set before src, otherwise the video is tainted
    const el = document.createElement("video");
    el.crossOrigin = "anonymous";
    el.playsInline = true;
    el.muted = true;
    el.loop = true;
    el.autoplay = true;
    el.src = src;
    document.body.appendChild(el);
    const vid = new p5.MediaElement(el, _renderer._pInst);
    // what p5's createVideo() does on metadata: vid.get(), vid.speed()
    // and pixel access rely on it
    vid.loadedmetadata = false;
    el.addEventListener("loadedmetadata", () => {
      vid.width = el.videoWidth;
      vid.height = el.videoHeight;
      if (!el.width) el.width = el.videoWidth;
      if (!el.height) el.height = el.videoHeight;
      if (vid.presetPlaybackRate) {
        el.playbackRate = vid.presetPlaybackRate;
        delete vid.presetPlaybackRate;
      }
      vid.loadedmetadata = true;
    });
    if (this.size) vid.size(...this.size());
    vid.hide();
    this.vid = vid;

    el.onloadedmetadata = () => {
      if (token !== this.token) return;
      if (this.randomStart && isFinite(el.duration))
        el.currentTime = Math.random() * el.duration;
    };
    el.onloadeddata = () => {
      if (token !== this.token) return;
      this.failed = 0;
      this.onReady(vid);
    };
    el.onerror = () => {
      console.warn("video failed to load:", entry, src);
      this.skip(token);
    };
    this.onChange(vid);
  }

  // whole file as a blob url (seekable), or src itself if it's too big
  async download(src, token) {
    const ctrl = (this.abort = new AbortController());
    const res = await fetch(src, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${src}`);
    const size = Number(res.headers.get("content-length"));
    if (!size || size > VideoSource.MAX_BLOB_BYTES) {
      ctrl.abort();
      return src;
    }
    const blob = await res.blob();
    if (token !== this.token) return src;
    this.blobUrl = URL.createObjectURL(blob);
    return this.blobUrl;
  }

  unload() {
    if (this.abort) this.abort.abort();
    this.abort = null;
    if (this.vid) {
      // detach handlers first: removing the element can fire stale events
      const el = this.vid.elt;
      el.onloadedmetadata = el.onloadeddata = el.onerror = null;
      this.vid.remove();
      this.vid = null;
    }
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    this.onChange(null);
  }

  // true while `vid` is still the playing video (for async onReady work)
  isCurrent(vid) {
    return vid === this.vid;
  }

  next() {
    if (!this.urls.length) return;
    this.index = (this.index + 1) % this.urls.length;
    this.load();
  }

  skip(token) {
    if (token !== this.token) return;
    // archive.org sometimes fails transiently: retry once
    if (!this.retried) return this.load({ retry: true });
    this.failed++;
    if (this.failed < this.urls.length) this.next();
  }

  // --- playlist ----------------------------------------------------------

  play(url) {
    this.add(url);
    this.index = this.urls.indexOf(url);
    this.load();
  }

  add(url) {
    const list = this.savedList();
    list.push(url);
    this.save(list);
    // queue it right after the current video
    this.urls.splice(this.index + 1, 0, url);
  }

  setUrls(urls, { save = true } = {}) {
    if (save) this.save(urls);
    else this.clearSaved();
    this.urls = VideoSource.shuffle([...urls]);
    this.index = 0;
    this.failed = 0;
    this.load();
  }

  savedList() {
    return this.loadSaved() || [...this.defaults];
  }

  loadSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey));
      return Array.isArray(saved) && saved.length ? saved : null;
    } catch (e) {
      return null;
    }
  }

  save(urls) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(urls));
    } catch (e) {}
    if (this.listEl) this.listEl.value = urls.join("\n");
  }

  clearSaved() {
    try {
      localStorage.removeItem(this.storageKey);
    } catch (e) {}
    if (this.listEl) this.listEl.value = this.defaults.join("\n");
  }

  // --- header UI ---------------------------------------------------------

  mountUI() {
    VideoSource.injectStyles();
    let header = document.querySelector("header");
    if (!header) {
      header = document.createElement("header");
      document.body.prepend(header);
    }
    const box = document.createElement("div");
    box.className = "vs";
    box.innerHTML = `
      <div class="vs-row">
        <input type="text" class="vs-input"
          placeholder="archive.org/details/… or video url" />
        <button class="vs-play" title="Play now">Play</button>
        <button class="vs-add" title="Add to playlist">Add</button>
        <button class="vs-next">Next</button>
        <button class="vs-toggle">Playlist</button>
      </div>
      <div class="vs-panel">
        <textarea class="vs-list" spellcheck="false"></textarea>
        <div class="vs-row">
          <button class="vs-apply">Apply</button>
          <button class="vs-reset">Reset defaults</button>
        </div>
      </div>`;
    header.appendChild(box);

    const $ = (sel) => box.querySelector(sel);
    const input = $(".vs-input");
    this.listEl = $(".vs-list");
    this.listEl.value = this.savedList().join("\n");

    const take = () => {
      const url = input.value.trim();
      input.value = "";
      return url;
    };
    $(".vs-play").addEventListener("click", () => {
      const url = take();
      if (url) this.play(url);
    });
    $(".vs-add").addEventListener("click", () => {
      const url = take();
      if (url) this.add(url);
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't trigger the sketches' keyPressed
      if (e.key === "Enter") $(".vs-play").click();
    });
    $(".vs-next").addEventListener("click", () => this.next());
    $(".vs-toggle").addEventListener("click", () =>
      $(".vs-panel").classList.toggle("open")
    );
    this.listEl.addEventListener("keydown", (e) => e.stopPropagation());
    $(".vs-apply").addEventListener("click", () =>
      this.setUrls(
        this.listEl.value
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
    $(".vs-reset").addEventListener("click", () =>
      this.setUrls(this.defaults, { save: false })
    );
  }

  static injectStyles() {
    if (document.getElementById("vs-styles")) return;
    const style = document.createElement("style");
    style.id = "vs-styles";
    style.textContent = `
      header:focus-within { opacity: 1 !important; }
      .vs { flex-basis: 100%; padding: 6px 10px 0; box-sizing: border-box; }
      .vs-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .vs-input { width: 320px; max-width: 100%; }
      .vs-panel { display: none; margin-top: 6px; }
      .vs-panel.open { display: block; }
      .vs-list {
        width: 100%; height: 200px; box-sizing: border-box; margin-bottom: 6px;
        background: #111; color: white; border: 1px solid #444;
        font-family: monospace; font-size: 12px;
      }
      video { display: none; }`;
    document.head.appendChild(style);
  }

  // --- helpers -----------------------------------------------------------

  // p5 fires mousePressed for clicks anywhere, including the header controls
  static clickedCanvas(e) {
    return !e || !e.target || e.target.tagName === "CANVAS";
  }

  static onDomReady(fn) {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  static shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }
}
