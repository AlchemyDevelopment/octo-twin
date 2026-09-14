# ⬡ OctoTwin — Real-Time 3D Print Visualizer & Digital Twin

> A high-performance, real-time 3D print visualizer powered by **Three.js** and **OctoEverywhere**. Sync your physical 3D printer with an interactive digital twin in the browser, complete with live toolhead tracking, layer-by-layer dynamic slicing, thermal HUD, and Picture-in-Picture webcam stream.

---

## 🌟 Features

* **3D Digital Twin**: Render live extrusion toolpaths layer-by-layer as the print happens.
* **OctoEverywhere Remote Proxy**: Connect securely anywhere across the globe to your Klipper / Moonraker or OctoPrint printer without port forwarding or VPNs.
* **Dual Firmware Support**:
  * **Klipper / Moonraker**: WebSocket stream (`notify_status_update`) for real-time toolhead coordinates, virtual SD card progress, and heater statuses.
  * **OctoPrint**: REST & SockJS telemetry polling for job completion, layer offsets, and temps.
* **Live 3D Toolhead Model**: Modeled hotend assembly with nozzle emissive glow (reacts to nozzle temperature) and dynamic worklight illuminating the extrusion path.
* **Picture-in-Picture Webcam**: Watch your real-world camera stream overlaid alongside the 3D simulation for instant print verification.
* **Web Worker Parsing**: Non-blocking asynchronous G-code parser handles multi-megabyte files smoothly at 60 FPS.
* **Zero-Setup Simulation Mode**: Built-in sample model with speed controls (1x to 100x), play/pause, and scrubber so you can preview the experience anytime.
* **Camera View Presets**: Isometric orbit, top-down layer inspector, front elevation, side profile, and follow-toolhead tracking.
* **GitHub Pages Ready**: 100% static client-side bundle with automated GitHub Actions CI/CD.

---

## 🚀 Quick Start

### 1. Run Locally

```bash
# Clone the repository
git clone https://github.com/AlchemyDevelopment/octo-twin.git
cd octo-twin

# Install dependencies
npm install

# Start local dev server
npm run dev
```

Visit `http://localhost:3000` in your browser.

---

## ⚡ Connecting to OctoEverywhere

1. Log in to [OctoEverywhere.com](https://octoeverywhere.com) and copy your **Printer Remote Access URL** (e.g. `https://xxx.octoeverywhere.com`).
2. Click **Connect OctoEverywhere** in OctoTwin.
3. Paste your URL and select your firmware (**Klipper / Moonraker** or **OctoPrint**).
4. If authentication is enabled, provide your **API Key** or Bearer token.
5. (Optional) Paste your OctoEverywhere webcam stream link into the **Webcam Stream URL** field.
6. Click **Fetch Active G-code** to automatically pull the current print file, or click **Save & Connect** to sync telemetry immediately.

---

## 📦 Deployment to GitHub Pages

This project is configured with a GitHub Actions workflow (`.github/workflows/deploy.yml`) that automatically builds and publishes the app to GitHub Pages upon pushing to the `main` branch.

To enable GitHub Pages in your repo:
1. Go to your repository on GitHub: `Settings` → `Pages`.
2. Under **Build and deployment** → **Source**, select **GitHub Actions**.
3. Push to `main`, and your site will be live at `https://alchemydevelopment.github.io/octo-twin/`.

---

## 🛠️ Technology Stack

* **Rendering**: Three.js (WebGL, OrbitControls, PBR shaders)
* **Parser**: Web Worker API + ES6
* **Telemetry**: WebSocket + Fetch API (Moonraker JSON-RPC / OctoPrint REST)
* **Styling**: Vanilla CSS (Cyberpunk dark mode, Glassmorphism, Responsive CSS Grid)
* **Bundler**: Vite
