/**
 * Service to connect to OctoEverywhere remote printer URLs or local Moonraker/OctoPrint instances.
 * Streams real-time telemetry (X, Y, Z, layer, temperatures, job progress) and proxies webcam video.
 */
export class OctoService {
  constructor() {
    this.config = this.loadConfig();
    this.ws = null;
    this.pollingTimer = null;
    this.isConnected = false;
    this.listeners = new Set();
    this.currentJobFile = null;
  }

  loadConfig() {
    const defaultUrl = 'https://shared-U73WMVCXZBZ511EYIX93F6OKMA8FJ0OP.octoeverywhere.com';
    const saved = localStorage.getItem('octo_twin_config');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (!parsed.serverUrl || parsed.serverUrl.includes('ender5plus.octoeverywhere.com')) {
          parsed.serverUrl = defaultUrl;
        }
        return parsed;
      } catch (e) {
        console.error('Failed to parse saved config', e);
      }
    }
    return {
      serverUrl: defaultUrl,
      apiKey: '',
      printerType: 'moonraker', // 'moonraker' | 'octoprint'
      webcamUrl: '',
      pollIntervalMs: 800,
    };
  }

  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    localStorage.setItem('octo_twin_config', JSON.stringify(this.config));
  }

  onTelemetry(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emit(telemetryData) {
    this.listeners.forEach((cb) => cb(telemetryData));
  }

  cleanUrl(url) {
    if (!url) return '';
    // Strip hash fragment and query parameters, plus trailing slashes
    let cleaned = url.trim().split('#')[0].split('?')[0].replace(/\/+$/, '');
    if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
      cleaned = 'https://' + cleaned;
    }
    return cleaned;
  }

  getAuthHeaders() {
    const headers = {};
    const key = (this.config.apiKey || '').trim();
    if (key) {
      if (key.startsWith('Bearer ') || key.startsWith('Basic ')) {
        headers['Authorization'] = key;
      } else {
        headers['X-Api-Key'] = key;
        headers['Authorization'] = `Bearer ${key}`;
      }
    }
    return headers;
  }

  async connect() {
    this.disconnect();
    const { serverUrl, printerType } = this.config;
    if (!serverUrl) {
      throw new Error('Server URL is required');
    }

    const base = this.cleanUrl(serverUrl);

    if (printerType === 'moonraker') {
      await this.connectMoonraker(base);
    } else {
      await this.connectOctoPrint(base);
    }
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.isConnected = false;
    this.emit({ type: 'STATUS', status: 'DISCONNECTED' });
  }

  async connectMoonraker(base) {
    // 1. Try WebSocket connection
    const wsProto = base.startsWith('https') ? 'wss://' : 'ws://';
    const wsHost = base.replace(/^https?:\/\//, '');
    const wsUrl = `${wsProto}${wsHost}/websocket`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.emit({ type: 'STATUS', status: 'CONNECTED', mode: 'WEBSOCKET' });

        // Subscribe to printer telemetry objects
        const subMsg = {
          jsonrpc: '2.0',
          method: 'printer.objects.subscribe',
          params: {
            objects: {
              toolhead: ['position', 'status', 'print_time'],
              extruder: ['temperature', 'target'],
              heater_bed: ['temperature', 'target'],
              print_stats: ['filename', 'total_duration', 'print_duration', 'state', 'info'],
              virtual_sdcard: ['progress', 'file_position'],
            },
          },
          id: 101,
        };
        this.ws.send(JSON.stringify(subMsg));

        // Also query full state immediately to guarantee initial snapshot
        const queryMsg = {
          jsonrpc: '2.0',
          method: 'printer.objects.query',
          params: {
            objects: {
              toolhead: null,
              extruder: null,
              heater_bed: null,
              print_stats: null,
              virtual_sdcard: null,
            },
          },
          id: 102,
        };
        this.ws.send(JSON.stringify(queryMsg));
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMoonrakerMessage(data);
        } catch (err) {
          console.warn('Failed to parse Moonraker WS message', err);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('Moonraker WS encountered error, falling back to HTTP polling', err);
        this.startMoonrakerPolling(base);
      };

      this.ws.onclose = () => {
        if (this.isConnected) {
          this.isConnected = false;
          this.emit({ type: 'STATUS', status: 'DISCONNECTED' });
        }
      };
    } catch (e) {
      console.warn('Failed to establish WebSocket, falling back to polling', e);
      this.startMoonrakerPolling(base);
    }
  }

  handleMoonrakerMessage(msg) {
    let status = null;
    if (msg.method === 'notify_status_update' && msg.params && msg.params[0]) {
      status = msg.params[0];
    } else if (msg.result && msg.result.status) {
      status = msg.result.status;
    }

    if (!status) return;

    const telemetry = {
      type: 'TELEMETRY',
      timestamp: Date.now(),
    };

    if (status.toolhead && status.toolhead.position) {
      telemetry.x = status.toolhead.position[0];
      telemetry.y = status.toolhead.position[1];
      telemetry.z = status.toolhead.position[2];
    }

    if (status.extruder) {
      telemetry.toolTemp = status.extruder.temperature;
      telemetry.toolTarget = status.extruder.target;
    }

    if (status.heater_bed) {
      telemetry.bedTemp = status.heater_bed.temperature;
      telemetry.bedTarget = status.heater_bed.target;
    }

    if (status.virtual_sdcard && status.virtual_sdcard.progress !== undefined) {
      telemetry.progress = status.virtual_sdcard.progress;
    }

    if (status.print_stats) {
      telemetry.printState = status.print_stats.state;
      telemetry.filename = status.print_stats.filename;
      if (status.print_stats.info) {
        telemetry.currentLayer = status.print_stats.info.current_layer;
        telemetry.totalLayers = status.print_stats.info.total_layer;
      }
    }

    this.emit(telemetry);
  }

  startMoonrakerPolling(base) {
    if (this.pollingTimer) clearInterval(this.pollingTimer);

    const queryUrl = `${base}/printer/objects/query?toolhead=position&extruder=temperature,target&heater_bed=temperature,target&print_stats=state,filename,info&virtual_sdcard=progress`;

    const poll = async () => {
      try {
        const headers = this.getAuthHeaders();
        const resp = await fetch(queryUrl, { headers, credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        this.isConnected = true;
        this.emit({ type: 'STATUS', status: 'CONNECTED', mode: 'POLLING' });

        const status = data.result?.status;
        if (status) {
          this.emit({
            type: 'TELEMETRY',
            x: status.toolhead?.position?.[0],
            y: status.toolhead?.position?.[1],
            z: status.toolhead?.position?.[2],
            toolTemp: status.extruder?.temperature,
            toolTarget: status.extruder?.target,
            bedTemp: status.heater_bed?.temperature,
            bedTarget: status.heater_bed?.target,
            progress: status.virtual_sdcard?.progress,
            printState: status.print_stats?.state,
            filename: status.print_stats?.filename,
            currentLayer: status.print_stats?.info?.current_layer,
            totalLayers: status.print_stats?.info?.total_layer,
          });
        }
      } catch (err) {
        console.warn('Moonraker poll error:', err);
        this.isConnected = false;
        this.emit({ type: 'STATUS', status: 'ERROR', error: err.message });
      }
    };

    poll();
    this.pollingTimer = setInterval(poll, this.config.pollIntervalMs || 1000);
  }

  async connectOctoPrint(base) {
    if (this.pollingTimer) clearInterval(this.pollingTimer);

    const poll = async () => {
      try {
        const headers = { 'Content-Type': 'application/json', ...this.getAuthHeaders() };

        const [jobResp, printerResp] = await Promise.all([
          fetch(`${base}/api/job`, { headers, credentials: 'include' }),
          fetch(`${base}/api/printer`, { headers, credentials: 'include' }),
        ]);

        if (!jobResp.ok) throw new Error(`HTTP ${jobResp.status} from OctoPrint`);
        const job = await jobResp.json();
        const printer = printerResp.ok ? await printerResp.json() : null;

        this.isConnected = true;
        this.emit({ type: 'STATUS', status: 'CONNECTED', mode: 'POLLING' });

        const toolTemp = printer?.temperature?.tool0?.actual;
        const toolTarget = printer?.temperature?.tool0?.target;
        const bedTemp = printer?.temperature?.bed?.actual;
        const bedTarget = printer?.temperature?.bed?.target;

        this.emit({
          type: 'TELEMETRY',
          filename: job?.job?.file?.name,
          progress: (job?.progress?.completion || 0) / 100,
          printTime: job?.progress?.printTime,
          printTimeLeft: job?.progress?.printTimeLeft,
          printState: job?.state,
          toolTemp,
          toolTarget,
          bedTemp,
          bedTarget,
        });
      } catch (err) {
        console.warn('OctoPrint poll error:', err);
        this.isConnected = false;
        this.emit({ type: 'STATUS', status: 'ERROR', error: err.message });
      }
    };

    poll();
    this.pollingTimer = setInterval(poll, this.config.pollIntervalMs || 1000);
  }

  async downloadCurrentGcode(onProgress) {
    const { serverUrl, printerType } = this.config;
    if (!serverUrl) throw new Error('Server URL not configured');
    const base = this.cleanUrl(serverUrl);
    const headers = this.getAuthHeaders();

    let downloadUrl = '';
    let targetFilename = 'model.gcode';

    if (printerType === 'moonraker') {
      const statsResp = await fetch(`${base}/printer/objects/query?print_stats=filename`, { headers, credentials: 'include' });
      const stats = await statsResp.json();
      const filename = stats?.result?.status?.print_stats?.filename;
      if (!filename) throw new Error('No active file printing in Moonraker');
      targetFilename = filename;
      downloadUrl = `${base}/server/files/gcodes/${encodeURIComponent(filename)}`;
    } else {
      const jobResp = await fetch(`${base}/api/job`, { headers, credentials: 'include' });
      const job = await jobResp.json();
      downloadUrl = job?.job?.file?.resource;
      targetFilename = job?.job?.file?.name || 'model.gcode';
      if (!downloadUrl) throw new Error('No active file found in OctoPrint');
    }

    const fileResp = await fetch(downloadUrl, { headers, credentials: 'include' });
    if (!fileResp.ok) throw new Error(`Failed to download G-code: HTTP ${fileResp.status}`);

    const contentLength = fileResp.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    if (!fileResp.body || !window.ReadableStream) {
      const text = await fileResp.text();
      return { text, filename: targetFilename };
    }

    const reader = fileResp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) {
        onProgress(received, total);
      }
    }

    const allBytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      allBytes.set(chunk, offset);
      offset += chunk.length;
    }

    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(allBytes);
    return { text, filename: targetFilename };
  }
}
