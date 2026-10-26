// pages the "r" key jumps between
const RANDOM_PAGES = [
  "moiree.html",
  "bolo.html",
  "text.html",
  "ribbon.html",
  "sakamoto.html",
  "barcode.html",
  "vol.html",
  "matrix.html",
  "ascii.html",
];

const PALETTES = [
  ["blue", "red"],
  ["yellow", "purple"],
  ["white", "black"],
  ["cyan", "orangered"],
  ["gold", "mediumblue"],
  ["orange", "darkviolet"],
  ["springgreen", "red"],
  ["mediumorchid", "yellow"],
  ["dodgerblue", "magenta"],
  ["aquamarine", "indigo"],
  ["pink", "blue"],
  ["#9941FF", "lime"],
  ["#FF4701", "#FFFF04"],
  ["#222", "#111"],
];

// call fft.analyze() each frame before fft.getEnergy()
function startMic(smoothing = 0.6, bins = 256) {
  userStartAudio();
  const mic = new p5.AudioIn();
  mic.start();
  const fft = new p5.FFT(smoothing, bins);
  fft.setInput(mic);
  return { mic, fft };
}

function hash(x, y, t = 0) {
  const v = Math.sin(x * 12.9898 + y * 78.233 + t) * 43758.5453123;
  return v - Math.floor(v);
}

// wires <input id="{id}-slider"> and its <span id="{id}-value"> label
function bindRange(id, initial, onInput) {
  onDomReady(() => {
    const input = document.getElementById(`${id}-slider`);
    const label = document.getElementById(`${id}-value`);
    input.value = label.textContent = initial;
    input.addEventListener("input", () => {
      label.textContent = input.value;
      onInput(Number(input.value));
    });
  });
}

function onDomReady(fn) {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", fn);
  else fn();
}

window.addEventListener("keydown", (e) => {
  if (e.key !== "q") return;
  if (e.target instanceof Element && e.target.closest("input, textarea"))
    return;
  location.href = RANDOM_PAGES[Math.floor(Math.random() * RANDOM_PAGES.length)];
});
