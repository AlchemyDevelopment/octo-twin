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
    const saved = localStorage.getItem('octo_twin_config');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Failed to parse saved config', e);
      }
    }
    return {
      serverUrl: 'https://ender5plus.octoeverywhere.com',
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
    if (msg.method === 'notify_status_update' && msg.params && msg.params[0]) {
      const status = msg.params[0];
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

  async downloadCurrentGcode() {
    const { serverUrl, printerType } = this.config;
    if (!serverUrl) throw new Error('Server URL not configured');
    const base = this.cleanUrl(serverUrl);
    const headers = this.getAuthHeaders();

    if (printerType === 'moonraker') {
      // First find active filename from print_stats
      const statsResp = await fetch(`${base}/printer/objects/query?print_stats=filename`, { headers, credentials: 'include' });
      const stats = await statsResp.json();
      const filename = stats?.result?.status?.print_stats?.filename;
      if (!filename) throw new Error('No active file printing in Moonraker');

      const fileResp = await fetch(`${base}/server/files/gcodes/${encodeURIComponent(filename)}`, { headers, credentials: 'include' });
      if (!fileResp.ok) throw new Error(`Failed to download G-code: HTTP ${fileResp.status}`);
      return await fileResp.text();
    } else {
      // OctoPrint
      const jobResp = await fetch(`${base}/api/job`, { headers, credentials: 'include' });
      const job = await jobResp.json();
      const fileUrl = job?.job?.file?.resource;
      if (!fileUrl) throw new Error('No active file found in OctoPrint');

      const fileResp = await fetch(fileUrl, { headers, credentials: 'include' });
      if (!fileResp.ok) throw new Error(`Failed to download G-code: HTTP ${fileResp.status}`);
      return await fileResp.text();
    }
  }
}
