// Video playlist for the sketches: local files, archive.org pages/ids or urls.
// archive.org videos go through its /cors/ endpoint so pixels stay readable.

class VideoSource {
  static resolved = new Map();

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

  async load() {
    const token = ++this.token;
    this.cancelPending();
    if (!this.urls.length) return;
    const entry = this.urls[this.index];
    const pending = (this.pending = { ctrl: new AbortController() });
    const stale = () => {
      if (token !== this.token) throw new DOMException("stale", "AbortError");
    };
    this.setLoading(true);
    try {
      let src = await VideoSource.resolve(entry);
      stale();
      if (this.randomStart && src.startsWith("https://archive.org/cors/"))
        src = await this.download(src, pending);
      stale();
      pending.el = VideoSource.createElement(src);
      await this.whenReady(pending.el, pending.ctrl.signal);
      stale();
    } catch (e) {
      if (token !== this.token) return;
      console.warn("video failed to load:", entry, e);
      this.cancelPending();
      return this.skip();
    }
    this.pending = null;
    this.retried = false;
    this.failed = 0;
    this.swap(pending.el, pending.blobUrl);
  }

  static createElement(src) {
    // crossOrigin must be set before src, otherwise the video is tainted
    const el = document.createElement("video");
    el.crossOrigin = "anonymous";
    el.playsInline = true;
    el.muted = true;
    el.loop = true;
    el.preload = "auto";
    el.style.display = "none";
    el.src = src;
    document.body.appendChild(el);
    return el;
  }

  whenReady(el, signal) {
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError"))
      );
      el.onerror = () =>
        reject(new Error(el.error ? el.error.message : "media error"));
      el.onloadedmetadata = () => {
        const end = el.seekable.length
          ? el.seekable.end(el.seekable.length - 1)
          : 0;
        if (this.randomStart && end > 1) {
          el.onseeked = () => resolve();
          el.currentTime = Math.random() * end;
        } else if (el.readyState >= 2) resolve();
        else el.onloadeddata = () => resolve();
      };
    });
  }

  async download(src, pending) {
    const res = await fetch(src, { signal: pending.ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${src}`);
    const size = Number(res.headers.get("content-length"));
    if (!size || size > VideoSource.MAX_BLOB_BYTES) {
      res.body.cancel();
      return src;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      this.setLoading(true, received / size);
    }
    const type = (res.headers.get("content-type") || "video/mp4").split(";")[0];
    pending.blobUrl = URL.createObjectURL(new Blob(chunks, { type }));
    return pending.blobUrl;
  }

  swap(el, blobUrl) {
    el.onloadedmetadata = el.onloadeddata = el.onseeked = el.onerror = null;
    const vid = new p5.MediaElement(el, _renderer._pInst);
    vid.width = el.videoWidth;
    vid.height = el.videoHeight;
    vid.loadedmetadata = true;
    if (this.size) vid.size(...this.size());
    vid.hide();

    const old = this.vid;
    const oldBlobUrl = this.blobUrl;
    this.vid = vid;
    this.blobUrl = blobUrl;
    if (old) old.remove();
    if (oldBlobUrl) URL.revokeObjectURL(oldBlobUrl);

    this.setLoading(false);
    el.play().catch(() => {});
    this.onChange(vid);
    this.onReady(vid);
  }

  cancelPending() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.ctrl.abort();
    if (p.el) {
      p.el.onloadedmetadata = p.el.onloadeddata = p.el.onseeked = null;
      p.el.onerror = null;
      p.el.removeAttribute("src");
      p.el.load();
      p.el.remove();
    }
    if (p.blobUrl) URL.revokeObjectURL(p.blobUrl);
  }

  isCurrent(vid) {
    return vid === this.vid;
  }

  next() {
    if (!this.urls.length) return;
    this.retried = false;
    this.index = (this.index + 1) % this.urls.length;
    this.load();
  }

  skip() {
    // archive.org sometimes fails transiently: retry once
    if (!this.retried) {
      this.retried = true;
      return this.load();
    }
    this.failed++;
    if (this.failed < this.urls.length) this.next();
    else this.setLoading(false);
  }

  setLoading(on, progress) {
    if (!this.loadingEl) {
      VideoSource.injectStyles();
      this.loadingEl = document.createElement("div");
      this.loadingEl.className = "vs-loading";
      document.body.appendChild(this.loadingEl);
    }
    this.loadingEl.classList.toggle("on", on);
    this.loadingEl.textContent =
      progress === undefined
        ? "loading"
        : `loading ${Math.floor(progress * 100)}%`;
  }

  play(url) {
    this.add(url);
    this.index = this.urls.indexOf(url);
    this.retried = false;
    this.load();
  }

  add(url) {
    const list = this.savedList();
    list.push(url);
    this.save(list);
    this.urls.splice(this.index + 1, 0, url);
  }

  setUrls(urls, { save = true } = {}) {
    if (save) this.save(urls);
    else this.clearSaved();
    this.urls = VideoSource.shuffle([...urls]);
    this.index = 0;
    this.failed = 0;
    this.retried = false;
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
      e.stopPropagation();
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
      video { display: none; }
      .vs-loading {
        position: fixed; right: 10px; bottom: 10px; z-index: 20;
        padding: 3px 6px; background: rgba(0, 0, 0, 0.6); color: white;
        font: 11px monospace; pointer-events: none; display: none;
      }
      .vs-loading.on { display: block; }`;
    document.head.appendChild(style);
  }

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
