import * as THREE from 'three';
import { PrinterScene } from './viewer/scene.js';
import { Toolhead } from './viewer/toolhead.js';
import { GcodeRenderer } from './viewer/gcodeRenderer.js';
import { OctoService } from './services/octoService.js';
import { PrintSimulator } from './services/simulator.js';
import { generateDemoGcode } from './assets/demoGcode.js';
import { getCachedGcode, setCachedGcode } from './services/gcodeCache.js';

// --- APPLICATION STATE ---
let scene, toolhead, gcodeRenderer, octoService, simulator;
let gcodeWorker = null;
let parsedGcode = null;
let activeMode = 'SIMULATION'; // 'SIMULATION' | 'OCTO_LIVE'
let loadedFilename = '';
let lastReportedZ = 0;
let lastReportedProgress = 0;

// UI Elements Cache
const el = {
  viewport: document.getElementById('viewport'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  hudFilename: document.getElementById('hud-filename'),
  hudDownloadStatus: document.getElementById('hud-download-status'),
  hudDownloadLabel: document.getElementById('hud-download-label'),
  hudDownloadPct: document.getElementById('hud-download-pct'),
  hudDownloadBar: document.getElementById('hud-download-bar'),
  hudLayer: document.getElementById('hud-layer'),
  hudTotalLayers: document.getElementById('hud-total-layers'),
  hudPercent: document.getElementById('hud-percent'),
  hudProgressFill: document.getElementById('hud-progress-fill'),
  hudElapsed: document.getElementById('hud-elapsed'),
  hudRemaining: document.getElementById('hud-remaining'),
  hudNozzleTemp: document.getElementById('hud-nozzle-temp'),
  hudNozzleTarget: document.getElementById('hud-nozzle-target'),
  hudNozzleBar: document.getElementById('hud-nozzle-bar'),
  hudBedTemp: document.getElementById('hud-bed-temp'),
  hudBedTarget: document.getElementById('hud-bed-target'),
  hudBedBar: document.getElementById('hud-bed-bar'),
  hudCoordX: document.getElementById('hud-coord-x'),
  hudCoordY: document.getElementById('hud-coord-y'),
  hudCoordZ: document.getElementById('hud-coord-z'),

  btnPlayPause: document.getElementById('btn-play-pause'),
  playPauseIcon: document.getElementById('play-pause-icon'),
  playPauseText: document.getElementById('play-pause-text'),
  btnResetSim: document.getElementById('btn-reset-sim'),
  simScrubber: document.getElementById('sim-scrubber'),
  simSpeed: document.getElementById('sim-speed'),

  modeLive: document.getElementById('mode-live'),
  modeFull: document.getElementById('mode-full'),
  modeSolo: document.getElementById('mode-solo'),

  btnPipToggle: document.getElementById('btn-pip-toggle'),
  webcamPip: document.getElementById('webcam-pip'),
  webcamClose: document.getElementById('webcam-close'),
  webcamFeed: document.getElementById('webcam-feed'),
  webcamEmptyState: document.getElementById('webcam-empty-state'),

  btnConnect: document.getElementById('btn-connect'),
  btnSettings: document.getElementById('btn-settings'),
  settingsModal: document.getElementById('settings-modal'),
  btnModalClose: document.getElementById('btn-modal-close'),
  settingsForm: document.getElementById('settings-form'),
  btnFetchActiveJob: document.getElementById('btn-fetch-active-job'),

  cfgServerUrl: document.getElementById('cfg-server-url'),
  cfgPrinterType: document.getElementById('cfg-printer-type'),
  cfgApiKey: document.getElementById('cfg-api-key'),
  cfgWebcamUrl: document.getElementById('cfg-webcam-url'),
  cfgBedPreset: document.getElementById('cfg-bed-preset'),
  cfgFilamentColor: document.getElementById('cfg-filament-color'),
  cfgShowGhost: document.getElementById('cfg-show-ghost'),
  cfgShowTravel: document.getElementById('cfg-show-travel'),

  btnLoadDemo: document.getElementById('btn-load-demo'),
  fileInput: document.getElementById('file-input'),
  dragOverlay: document.getElementById('drag-overlay'),
  toast: document.getElementById('toast'),
  toastMessage: document.getElementById('toast-message'),

  camIso: document.getElementById('cam-iso'),
  camTop: document.getElementById('cam-top'),
  camFront: document.getElementById('cam-front'),
  camSide: document.getElementById('cam-side'),
  camFollow: document.getElementById('cam-follow'),
};

// --- INITIALIZATION ---
function init() {
  // 1. Initialize 3D Scene
  scene = new PrinterScene(el.viewport);
  toolhead = new Toolhead(scene.scene);
  gcodeRenderer = new GcodeRenderer(scene.scene);
  scene.setToolheadReference(toolhead);

  // 2. Services
  octoService = new OctoService();
  simulator = new PrintSimulator(gcodeRenderer, toolhead, handleTelemetry);

  // 3. Worker for G-code parsing
  initWorker();

  // 4. Load Saved Settings
  loadSettingsIntoUI();

  // 5. Setup Listeners
  setupEventListeners();

  // 6. Start Render Loop
  scene.render((delta) => {
    toolhead.update(delta);
    if (activeMode === 'SIMULATION') {
      simulator.update(delta);
    }
  });

  // 7. Auto-connect to printer immediately
  autoConnectAndSync();
}

let hasAutoLoadedActiveJob = false;

async function autoConnectAndSync() {
  setAppStatus('SIMULATING', 'Connecting to Ender 5 Plus...');
  await connectToPrinter();
}

function initWorker() {
  gcodeWorker = new Worker(new URL('./parser/gcodeWorker.js', import.meta.url), {
    type: 'module',
  });

  gcodeWorker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'PROGRESS') {
      showToast(`Generating 3D Toolpaths: ${data.percent}%`, 'info');
    } else if (data.type === 'SUCCESS') {
      parsedGcode = data;
      gcodeRenderer.setGcodeData(parsedGcode);
      simulator.setGcodeData(parsedGcode);

      el.hudTotalLayers.textContent = parsedGcode.totalLayers;
      showToast(`3D Model Ready: ${parsedGcode.totalLayers} layers (${parsedGcode.layers.reduce((acc, l) => acc + l.moveCount, 0).toLocaleString()} moves)`, 'success');

      if (activeMode === 'OCTO_LIVE') {
        simulator.pause();
        updatePlayPauseButton(false);
        syncLivePrintProgress(lastReportedZ, lastReportedProgress);
      } else {
        simulator.play();
        updatePlayPauseButton(true);
      }
    } else if (data.type === 'ERROR') {
      showToast(`Error parsing G-code: ${data.error}`, 'error');
    }
  };
}

function parseGcodeString(gcodeStr, filename = 'custom_model.gcode') {
  loadedFilename = filename;
  el.hudFilename.textContent = filename;
  showToast(`Parsing ${filename}...`, 'info');
  gcodeWorker.postMessage({
    type: 'PARSE',
    gcodeText: gcodeStr,
  });
}

function loadDemo() {
  const demoStr = generateDemoGcode();
  parseGcodeString(demoStr, 'demo_twisted_vase.gcode');
}

let isDownloadingGcode = false;

async function loadActiveJobFile(filename) {
  if (isDownloadingGcode || (parsedGcode && loadedFilename === filename)) return;
  isDownloadingGcode = true;
  loadedFilename = filename;
  el.hudFilename.textContent = filename;

  // 1. Check local IndexedDB cache first
  const cached = await getCachedGcode(filename);
  if (cached) {
    showToast(`Loaded ${filename} from cache! Parsing toolpaths...`, 'success');
    parseGcodeString(cached, filename);
    isDownloadingGcode = false;
    return;
  }

  // 2. Stream download from printer
  if (el.hudDownloadStatus) {
    el.hudDownloadStatus.style.display = 'block';
    el.hudDownloadLabel.textContent = `Downloading ${filename}`;
    el.hudDownloadPct.textContent = '0%';
    el.hudDownloadBar.style.width = '0%';
  }

  try {
    const { text } = await octoService.downloadCurrentGcode((loaded, total) => {
      const mbLoaded = (loaded / (1024 * 1024)).toFixed(1);
      const mbTotal = total ? (total / (1024 * 1024)).toFixed(1) : '?';
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      if (el.hudDownloadStatus) {
        el.hudDownloadLabel.textContent = `${mbLoaded}MB / ${mbTotal}MB`;
        el.hudDownloadPct.textContent = `${pct}%`;
        el.hudDownloadBar.style.width = `${pct}%`;
      }
    });

    if (el.hudDownloadStatus) el.hudDownloadStatus.style.display = 'none';
    showToast(`Download finished (${(text.length / (1024 * 1024)).toFixed(1)}MB)! Caching...`, 'success');
    await setCachedGcode(filename, text);
    parseGcodeString(text, filename);
  } catch (err) {
    if (el.hudDownloadStatus) el.hudDownloadStatus.style.display = 'none';
    showToast(`Failed to download G-code: ${err.message}`, 'error');
  } finally {
    isDownloadingGcode = false;
  }
}

function syncLivePrintProgress(zHeight, overallProgress) {
  if (!parsedGcode || !parsedGcode.layers || parsedGcode.layers.length === 0) return;
  let activeLayerIdx = 0;
  for (let i = 0; i < parsedGcode.layers.length; i++) {
    if (parsedGcode.layers[i].z <= zHeight + 0.05) {
      activeLayerIdx = i;
    } else {
      break;
    }
  }
  const progressInLayer = overallProgress !== undefined ? ((overallProgress * parsedGcode.layers.length) - activeLayerIdx) : 0.5;
  gcodeRenderer.updateProgress(activeLayerIdx, Math.max(0, Math.min(1.0, progressInLayer)));
  el.hudLayer.textContent = activeLayerIdx + 1;
  el.hudTotalLayers.textContent = parsedGcode.totalLayers;
}

// --- TELEMETRY HANDLING ---
function handleTelemetry(t) {
  // Save latest telemetry state
  if (t.z !== undefined) lastReportedZ = Number(t.z);
  if (t.progress !== undefined) lastReportedProgress = Number(t.progress);

  // Auto-download active job file if printing
  if (t.filename && (!parsedGcode || loadedFilename !== t.filename) && activeMode === 'OCTO_LIVE') {
    loadActiveJobFile(t.filename);
  }

  // Update Coordinates
  if (t.x !== undefined) el.hudCoordX.textContent = Number(t.x).toFixed(1);
  if (t.y !== undefined) el.hudCoordY.textContent = Number(t.y).toFixed(1);
  if (t.z !== undefined) el.hudCoordZ.textContent = Number(t.z).toFixed(2);

  // Update Live Toolhead & Slicing in 3D Scene
  if (activeMode === 'OCTO_LIVE' && t.x !== undefined && t.y !== undefined && t.z !== undefined) {
    toolhead.setTargetPosition(t.x, t.y, t.z);
    syncLivePrintProgress(t.z, t.progress);
  }

  // Update Thermals
  if (t.toolTemp !== undefined) {
    el.hudNozzleTemp.textContent = Math.round(t.toolTemp);
    const target = t.toolTarget || 215;
    el.hudNozzleTarget.textContent = Math.round(target);
    const pct = Math.min(100, Math.max(0, (t.toolTemp / Math.max(1, target)) * 100));
    el.hudNozzleBar.style.width = `${pct}%`;
    toolhead.updateTemperature(t.toolTemp, target);
  }

  if (t.bedTemp !== undefined) {
    el.hudBedTemp.textContent = Math.round(t.bedTemp);
    const target = t.bedTarget || 60;
    el.hudBedTarget.textContent = Math.round(target);
    const pct = Math.min(100, Math.max(0, (t.bedTemp / Math.max(1, target)) * 100));
    el.hudBedBar.style.width = `${pct}%`;
    scene.updateBedTemperature(t.bedTemp, target);
  }

  // Update Filename
  if (t.filename) {
    el.hudFilename.textContent = t.filename;
  }

  // Update Layer & Overall Progress
  if (t.currentLayer !== undefined && t.currentLayer !== null) {
    el.hudLayer.textContent = t.currentLayer;
  }
  if (t.totalLayers !== undefined && t.totalLayers !== null && t.totalLayers > 0) {
    el.hudTotalLayers.textContent = t.totalLayers;
  }
  if (t.progress !== undefined) {
    const pct = Math.round(t.progress * 100);
    el.hudPercent.textContent = `${pct}%`;
    el.hudProgressFill.style.width = `${pct}%`;
    el.simScrubber.value = Math.round(t.progress * 1000);
  }

  // Time metrics
  if (t.elapsedTime !== undefined) {
    el.hudElapsed.textContent = formatTime(t.elapsedTime);
  }
  if (t.remainingTime !== undefined) {
    el.hudRemaining.textContent = formatTime(t.remainingTime);
  }
}

function formatTime(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function setAppStatus(status, text) {
  el.statusDot.className = 'status-dot';
  if (status === 'ONLINE') {
    el.statusDot.classList.add('online');
    el.statusText.textContent = text || 'Live Sync';
    el.btnConnect.innerHTML = '<span>🟢 Live: Ender 5 Plus</span>';
    el.btnConnect.style.background = 'rgba(16, 185, 129, 0.2)';
    el.btnConnect.style.borderColor = 'rgba(16, 185, 129, 0.6)';
    el.btnConnect.style.color = '#10b981';
  } else if (status === 'SIMULATING') {
    el.statusDot.classList.add('simulating');
    el.statusText.textContent = text || 'Simulating';
    el.btnConnect.innerHTML = '<span>⚡ Connect Ender 5 Plus</span>';
    el.btnConnect.style.background = '';
    el.btnConnect.style.borderColor = '';
    el.btnConnect.style.color = '';
  } else if (status === 'ERROR') {
    el.statusDot.classList.add('error');
    el.statusText.textContent = text || 'Error';
    el.btnConnect.innerHTML = '<span>⚠️ Reconnect</span>';
    el.btnConnect.style.background = 'rgba(239, 68, 68, 0.2)';
    el.btnConnect.style.borderColor = 'rgba(239, 68, 68, 0.6)';
    el.btnConnect.style.color = '#ef4444';
  } else {
    el.statusText.textContent = text || 'Disconnected';
    el.btnConnect.innerHTML = '<span>⚡ Connect OctoEverywhere</span>';
    el.btnConnect.style.background = '';
    el.btnConnect.style.borderColor = '';
    el.btnConnect.style.color = '';
  }
}

// --- EVENT LISTENERS ---
function setupEventListeners() {
  // 1. Play / Pause & Scrubber
  el.btnPlayPause.addEventListener('click', () => {
    if (activeMode === 'OCTO_LIVE') {
      showToast('Live OctoEverywhere stream active. Switch to simulation to use playback controls.', 'info');
      return;
    }
    if (simulator.isPlaying) {
      simulator.pause();
      updatePlayPauseButton(false);
    } else {
      simulator.play();
      updatePlayPauseButton(true);
    }
  });

  el.btnResetSim.addEventListener('click', () => {
    activeMode = 'SIMULATION';
    setAppStatus('SIMULATING', 'Simulating');
    simulator.reset();
    updatePlayPauseButton(false);
  });

  el.simScrubber.addEventListener('input', (e) => {
    if (activeMode === 'SIMULATION') {
      simulator.pause();
      updatePlayPauseButton(false);
      simulator.scrub(e.target.value / 1000);
    }
  });

  el.simSpeed.addEventListener('change', (e) => {
    simulator.setSpeed(parseFloat(e.target.value));
  });

  // 2. View Mode buttons
  const setViewMode = (mode, activeBtn) => {
    [el.modeLive, el.modeFull, el.modeSolo].forEach((btn) => btn.classList.remove('active'));
    activeBtn.classList.add('active');
    gcodeRenderer.setViewMode(mode);
  };

  el.modeLive.addEventListener('click', () => setViewMode('LIVE', el.modeLive));
  el.modeFull.addEventListener('click', () => setViewMode('FULL', el.modeFull));
  el.modeSolo.addEventListener('click', () => setViewMode('LAYER_SOLO', el.modeSolo));

  // 3. Camera Presets & Movement
  const setCamActive = (btn, preset) => {
    [el.camIso, el.camTop, el.camFront, el.camSide].forEach((b) => {
      if (b) b.classList.remove('active');
    });
    if (btn) btn.classList.add('active');
    scene.setCameraView(preset);
  };

  if (el.camIso) el.camIso.addEventListener('click', () => setCamActive(el.camIso, 'ISO'));
  if (el.camTop) el.camTop.addEventListener('click', () => setCamActive(el.camTop, 'TOP'));
  if (el.camFront) el.camFront.addEventListener('click', () => setCamActive(el.camFront, 'FRONT'));
  if (el.camSide) el.camSide.addEventListener('click', () => setCamActive(el.camSide, 'SIDE'));

  const camFocus = document.getElementById('cam-focus');
  if (camFocus) {
    camFocus.addEventListener('click', () => {
      if (parsedGcode && parsedGcode.bounds) {
        scene.focusOnBounds(parsedGcode.bounds);
        showToast('Camera focused on print', 'info');
      } else {
        scene.resetCameraToIsometric();
      }
    });
  }

  const camZoomIn = document.getElementById('cam-zoom-in');
  if (camZoomIn) {
    camZoomIn.addEventListener('click', () => {
      scene.camera.position.lerp(scene.controls.target, 0.25);
      scene.controls.update();
    });
  }

  const camZoomOut = document.getElementById('cam-zoom-out');
  if (camZoomOut) {
    camZoomOut.addEventListener('click', () => {
      scene.camera.position.sub(scene.controls.target).multiplyScalar(1.3).add(scene.controls.target);
      scene.controls.update();
    });
  }

  const camReset = document.getElementById('cam-reset');
  if (camReset) {
    camReset.addEventListener('click', () => {
      scene.resetCameraToIsometric();
      showToast('Camera view reset', 'info');
    });
  }

  // 4. Appearance & Colors Panel
  const appearancePanel = document.getElementById('appearance-panel');
  const btnToggleVisuals = document.getElementById('btn-toggle-visuals');
  const btnCloseAppearance = document.getElementById('btn-close-appearance');

  if (btnToggleVisuals && appearancePanel) {
    btnToggleVisuals.addEventListener('click', () => {
      const isHidden = appearancePanel.style.display === 'none';
      appearancePanel.style.display = isHidden ? 'block' : 'none';
    });
  }

  if (btnCloseAppearance && appearancePanel) {
    btnCloseAppearance.addEventListener('click', () => {
      appearancePanel.style.display = 'none';
    });
  }

  // Bed Color Swatches
  document.querySelectorAll('[data-bed]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-bed]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const hex = parseInt(btn.getAttribute('data-bed').replace('#', '0x'), 16);
      scene.setBedColor(hex);
    });
  });

  const bedPicker = document.getElementById('bed-color-picker');
  if (bedPicker) {
    bedPicker.addEventListener('input', (e) => {
      const hex = parseInt(e.target.value.replace('#', '0x'), 16);
      scene.setBedColor(hex);
    });
  }

  // Filament Color Swatches
  document.querySelectorAll('[data-filament]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-filament]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const hex = parseInt(btn.getAttribute('data-filament').replace('#', '0x'), 16);
      gcodeRenderer.setFilamentColor(hex);
    });
  });

  const filamentPicker = document.getElementById('filament-color-picker');
  if (filamentPicker) {
    filamentPicker.addEventListener('input', (e) => {
      const hex = parseInt(e.target.value.replace('#', '0x'), 16);
      gcodeRenderer.setFilamentColor(hex);
    });
  }

  // Background Theme Swatches
  document.querySelectorAll('[data-bg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-bg]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const hex = parseInt(btn.getAttribute('data-bg').replace('#', '0x'), 16);
      scene.setBackgroundColor(hex);
    });
  });

  // Toggles
  const toggleGrid = document.getElementById('toggle-grid');
  if (toggleGrid) toggleGrid.addEventListener('change', (e) => scene.setGridVisibility(e.target.checked));

  const toggleGhost = document.getElementById('toggle-ghost');
  if (toggleGhost) toggleGhost.addEventListener('change', (e) => gcodeRenderer.setShowGhost(e.target.checked));

  const toggleToolhead = document.getElementById('toggle-toolhead');
  if (toggleToolhead) toggleToolhead.addEventListener('change', (e) => toolhead.setVisible(e.target.checked));

  const toggleCage = document.getElementById('toggle-cage');
  if (toggleCage) toggleCage.addEventListener('change', (e) => scene.setCageVisibility(e.target.checked));

  // Drag & drop custom G-code files still supported via drag
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.dragOverlay.classList.add('active');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      el.dragOverlay.classList.remove('active');
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dragOverlay.classList.remove('active');
    if (e.dataTransfer.files.length > 0) {
      handleLoadedFile(e.dataTransfer.files[0]);
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dragOverlay.classList.remove('active');
    if (e.dataTransfer.files.length > 0) {
      handleLoadedFile(e.dataTransfer.files[0]);
    }
  });

  // 5. Webcam Picture-in-Picture
  el.btnPipToggle.addEventListener('click', () => {
    const isHidden = el.webcamPip.style.display === 'none';
    el.webcamPip.style.display = isHidden ? 'block' : 'none';
    updateWebcamStream();
  });

  el.webcamClose.addEventListener('click', () => {
    el.webcamPip.style.display = 'none';
  });

  // 6. Settings & Connect Modal
  el.btnConnect.addEventListener('click', () => {
    if (activeMode === 'OCTO_LIVE') {
      openModal();
    } else {
      connectToPrinter();
    }
  });
  el.btnSettings.addEventListener('click', () => openModal());
  el.btnModalClose.addEventListener('click', () => closeModal());
  el.settingsModal.addEventListener('click', (e) => {
    if (e.target === el.settingsModal) closeModal();
  });

  el.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettingsFromUI();
    closeModal();
    connectToPrinter();
  });

  el.btnFetchActiveJob.addEventListener('click', async () => {
    try {
      saveSettingsFromUI();
      showToast('Contacting printer for active G-code...', 'info');
      const { text, filename } = await octoService.downloadCurrentGcode((loaded, total) => {
        const mbLoaded = (loaded / (1024 * 1024)).toFixed(1);
        const mbTotal = total ? (total / (1024 * 1024)).toFixed(1) : '?';
        const pct = total ? ` (${Math.round((loaded / total) * 100)}%)` : '';
        showToast(`Downloading ${filename}: ${mbLoaded}MB / ${mbTotal}MB${pct}`, 'info');
      });
      showToast(`Downloaded ${filename}! Parsing toolpaths...`, 'info');
      parseGcodeString(text, filename);
      closeModal();
      connectToPrinter();
    } catch (err) {
      showToast(`Failed to fetch G-code: ${err.message}`, 'error');
    }
  });

  // 7. Dynamic UI configuration changes
  el.cfgBedPreset.addEventListener('change', () => {
    const [x, y, z] = el.cfgBedPreset.value.split(',').map(Number);
    scene.setBedDimensions({ x, y, z });
  });

  el.cfgFilamentColor.addEventListener('change', () => {
    gcodeRenderer.setFilamentColor(parseInt(el.cfgFilamentColor.value.replace('#', '0x'), 16));
  });

  el.cfgShowGhost.addEventListener('change', () => {
    gcodeRenderer.setShowGhost(el.cfgShowGhost.checked);
  });

  el.cfgShowTravel.addEventListener('change', () => {
    gcodeRenderer.setShowTravel(el.cfgShowTravel.checked);
  });
}

function handleLoadedFile(file) {
  if (!file.name.toLowerCase().endsWith('.gcode')) {
    showToast('Please provide a valid .gcode file', 'error');
    return;
  }
  showToast(`Reading ${file.name}...`, 'info');
  const reader = new FileReader();
  reader.onload = (evt) => {
    activeMode = 'SIMULATION';
    setAppStatus('SIMULATING', 'Simulating');
    parseGcodeString(evt.target.result, file.name);
  };
  reader.readAsText(file);
}

function updatePlayPauseButton(isPlaying) {
  el.playPauseIcon.textContent = isPlaying ? '⏸' : '▶';
  el.playPauseText.textContent = isPlaying ? 'Pause Simulation' : 'Play Simulation';
}

function openModal() {
  loadSettingsIntoUI();
  el.settingsModal.classList.add('open');
}

function closeModal() {
  el.settingsModal.classList.remove('open');
}

function loadSettingsIntoUI() {
  const cfg = octoService.config;
  el.cfgServerUrl.value = cfg.serverUrl || '';
  el.cfgApiKey.value = cfg.apiKey || '';
  el.cfgPrinterType.value = cfg.printerType || 'moonraker';
  el.cfgWebcamUrl.value = cfg.webcamUrl || '';
}

function saveSettingsFromUI() {
  const cfg = {
    serverUrl: el.cfgServerUrl.value.trim(),
    apiKey: el.cfgApiKey.value.trim(),
    printerType: el.cfgPrinterType.value,
    webcamUrl: el.cfgWebcamUrl.value.trim(),
  };
  octoService.saveConfig(cfg);
  updateWebcamStream();
}

function updateWebcamStream() {
  const url = octoService.config.webcamUrl;
  if (url) {
    el.webcamFeed.src = url;
    el.webcamFeed.style.display = 'block';
    el.webcamEmptyState.style.display = 'none';
  } else {
    el.webcamFeed.src = '';
    el.webcamFeed.style.display = 'none';
    el.webcamEmptyState.style.display = 'block';
  }
}

async function connectToPrinter() {
  if (!octoService.config.serverUrl) {
    showToast('Please enter an OctoEverywhere printer URL first', 'error');
    return;
  }

  showToast('Connecting to OctoEverywhere / Printer...', 'info');
  simulator.pause();

  octoService.onTelemetry((msg) => {
    if (msg.type === 'STATUS') {
      if (msg.status === 'CONNECTED') {
        activeMode = 'OCTO_LIVE';
        setAppStatus('ONLINE', `Live (${msg.mode})`);
        showToast('Connected to printer live stream!', 'success');
      } else if (msg.status === 'DISCONNECTED') {
        setAppStatus('DISCONNECTED', 'Disconnected');
      } else if (msg.status === 'ERROR') {
        setAppStatus('ERROR', 'Error');
        showToast(`Connection error: ${msg.error}`, 'error');
      }
    } else if (msg.type === 'TELEMETRY') {
      handleTelemetry(msg);
    }
  });

  try {
    await octoService.connect();
  } catch (err) {
    setAppStatus('ERROR', 'Connection Failed');
    showToast(`Failed to connect: ${err.message}`, 'error');
  }
}

function showToast(msg, type = 'info') {
  el.toastMessage.textContent = msg;
  el.toast.className = `toast show ${type}`;
  clearTimeout(el.toastTimer);
  el.toastTimer = setTimeout(() => {
    el.toast.className = `toast ${type}`;
  }, 3500);
}

// Start application
window.addEventListener('DOMContentLoaded', init);
