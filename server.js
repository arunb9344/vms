import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { exec, spawn, execSync } from 'child_process';
import util from 'util';
import net from 'net';
import crypto from 'crypto';
import http from 'http';
import { Discovery } from '@2bad/onvif';
import { getCameraUris, clearRtspCache } from './onvif.js';
import ffmpegStatic from 'ffmpeg-static';

const execPromise = util.promisify(exec);

// --- Offline Licensing Engine ---
let isActivated = false;
const LICENSE_SECRET = 'eyetech_vms_securities_secret_passphrase_2026';

function getMotherboardSerial() {
  try {
    const output = execSync('powershell -Command "Get-CimInstance Win32_BaseBoard | Select-Object -ExpandProperty SerialNumber"', { encoding: 'utf8' });
    const serial = output.trim().replace(/[\s\r\n\t\-]+/g, '').toUpperCase();
    if (!serial || serial === 'TOBEFILLEDBYOEM' || serial === 'NONE') {
      const cpuOutput = execSync('powershell -Command "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty ProcessorId"', { encoding: 'utf8' });
      const cpuId = cpuOutput.trim().replace(/[\s\r\n\t\-]+/g, '').toUpperCase();
      return cpuId || 'GENERIC-HWID-12345';
    }
    return serial;
  } catch (err) {
    console.error('[License] Failed to query hardware serial:', err.message);
    return 'FALLBACK-HWID-67890';
  }
}

function getHardwareId() {
  const rawSerial = getMotherboardSerial();
  const hash = crypto.createHash('md5').update(rawSerial).digest('hex').toUpperCase();
  return `EYETECH-${hash.substring(0, 4)}-${hash.substring(4, 8)}`;
}

function generateActivationKey(hardwareId) {
  const hmac = crypto.createHmac('sha256', LICENSE_SECRET).update(hardwareId).digest('hex').toUpperCase();
  return `ET-VMS-${hmac.substring(0, 4)}-${hmac.substring(4, 8)}-${hmac.substring(8, 12)}-${hmac.substring(12, 16)}`;
}

function getConfigFilePath() {
  const appDataDir = process.env.APPDATA 
    ? path.join(process.env.APPDATA, 'EyeTechVMS')
    : path.resolve('.');
  fs.ensureDirSync(appDataDir);
  const userConfigPath = path.join(appDataDir, 'config.json');
  
  if (!fs.existsSync(userConfigPath)) {
    const defaultConfigPath = path.resolve('./config.json');
    if (fs.existsSync(defaultConfigPath)) {
      try {
        fs.copySync(defaultConfigPath, userConfigPath);
      } catch (err) {
        console.error('[Config] Failed to copy default config.json to AppData:', err.message);
      }
    }
  }
  return userConfigPath;
}

function checkLicense() {
  const licensePath = process.env.APPDATA 
    ? path.join(process.env.APPDATA, 'EyeTechVMS', 'license.json')
    : path.join(path.resolve(), 'license.json');

  if (!fs.existsSync(licensePath)) {
    isActivated = false;
    return false;
  }
  try {
    const licenseData = fs.readJsonSync(licensePath);
    const localHardwareId = getHardwareId();
    const expectedKey = generateActivationKey(localHardwareId);
    if (licenseData.licenseKey === expectedKey) {
      isActivated = true;
      return true;
    }
  } catch (err) {
    console.error('[License] Failed to read or parse license.json:', err.message);
  }
  isActivated = false;
  return false;
}
// ---------------------------------

/**
 * Calculates MD5 hex hash.
 */
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Custom HTTP client supporting Basic & Digest access authentication handshakes natively.
 * Essential for fast snapshot retrievals from IP cameras.
 * @param {string} urlStr - Camera target snapshot URL.
 * @param {string} username - User.
 * @param {string} password - Pass.
 * @param {number} timeoutMs - Timeout limit in milliseconds.
 * @returns {Promise<Buffer>} Resolves to file buffer.
 */
function fetchWithDigest(urlStr, username, password, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      headers: {},
      timeout: timeoutMs
    };

    // First request: challenge challenge server for auth requirements
    const req = http.request(options, (res) => {
      if (res.statusCode !== 401) {
        // If server allows anonymous requests, read buffer straight away
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        return;
      }

      const authHeader = res.headers['www-authenticate'];
      if (!authHeader) {
        return reject(new Error('Unauthorized request challenge holds no WWW-Authenticate headers.'));
      }

      // Handle standard Basic Authentication
      if (authHeader.startsWith('Basic')) {
        const authString = Buffer.from(`${username}:${password}`).toString('base64');
        options.headers['Authorization'] = `Basic ${authString}`;
        
        const reqBasic = http.request(options, (resBasic) => {
          if (resBasic.statusCode !== 200) {
            return reject(new Error(`Basic auth request failed with status: ${resBasic.statusCode}`));
          }
          const chunks = [];
          resBasic.on('data', chunk => chunks.push(chunk));
          resBasic.on('end', () => resolve(Buffer.concat(chunks)));
        });
        reqBasic.on('error', reject);
        reqBasic.end();
        return;
      }

      // Handle standard Digest Authentication
      if (!authHeader.startsWith('Digest ')) {
        return reject(new Error(`Unsupported camera authentication type: "${authHeader}"`));
      }

      const params = {};
      const matches = authHeader.matchAll(/(\w+)="?([^",]+)"?/g);
      for (const match of matches) {
        params[match[1]] = match[2];
      }

      const realm = params.realm;
      const nonce = params.nonce;
      const qop = params.qop;
      const opaque = params.opaque;
      const nc = '00000001';
      const cnonce = crypto.randomBytes(8).toString('hex');

      const ha1 = md5(`${username}:${realm}:${password}`);
      const ha2 = md5(`GET:${options.path}`);
      
      let responseHash;
      if (qop === 'auth') {
        responseHash = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
      } else {
        responseHash = md5(`${ha1}:${nonce}:${ha2}`);
      }

      let authStr = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${options.path}", response="${responseHash}"`;
      if (qop) {
        authStr += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
      }
      if (opaque) {
        authStr += `, opaque="${opaque}"`;
      }

      // Secondary authenticated request
      options.headers['Authorization'] = authStr;

      const reqAuth = http.request(options, (resAuth) => {
        if (resAuth.statusCode !== 200) {
          return reject(new Error(`Digest authentication failed with status: ${resAuth.statusCode}`));
        }
        const chunks = [];
        resAuth.on('data', chunk => chunks.push(chunk));
        resAuth.on('end', () => resolve(Buffer.concat(chunks)));
      });

      reqAuth.on('error', reject);
      reqAuth.end();
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Socket connection timeout limit exceeded.'));
    });
    req.end();
  });
}

/**
 * Performs a fast TCP socket check to see if a camera is reachable.
 * @param {string} ip - The camera IP.
 * @param {number} port - The target port.
 * @returns {Promise<boolean>} Resolves to true if reachable.
 */
function checkCameraOnline(ip, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500); // 1.5-second connection timeout

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, ip);
  });
}

/**
 * Detects available logical drives on Windows using PowerShell.
 */
async function getLogicalDrives() {
  try {
    const { stdout } = await execPromise(
      'powershell -Command "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, Size, FreeSpace | ConvertTo-Json"'
    );
    if (!stdout.trim()) return [];
    
    const parsed = JSON.parse(stdout.trim());
    const drives = Array.isArray(parsed) ? parsed : [parsed];
    
    return drives.map((d) => ({
      driveLetter: d.DeviceID,
      volumeName: d.VolumeName || 'Local Disk',
      sizeGb: (d.Size / (1024 * 1024 * 1024)).toFixed(1),
      freeGb: (d.FreeSpace / (1024 * 1024 * 1024)).toFixed(1),
      usedGb: ((d.Size - d.FreeSpace) / (1024 * 1024 * 1024)).toFixed(1),
      rawSize: d.Size,
      rawFree: d.FreeSpace
    }));
  } catch (error) {
    console.error('[Web Server] Error scanning logical drives:', error.message);
    return [];
  }
}

/**
 * Recursively scans a directory for all .mp4 recording files.
 */
async function scanRecordingsRecursively(dir) {
  let results = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subResults = await scanRecordingsRecursively(fullPath);
        results = results.concat(subResults);
      } else if (entry.isFile() && entry.name.endsWith('.mp4')) {
        const stat = await fs.stat(fullPath);
        const relativePath = path.relative(dir, fullPath).replace(/\\/g, '/');
        results.push({
          fullPath,
          relativePath,
          filename: entry.name,
          size: stat.size,
          mtime: stat.mtimeMs,
          mtimeDate: stat.mtime
        });
      }
    }
  } catch (err) {
    console.error(`[Web Server] Recursive recording scan error in "${dir}":`, err.message);
  }
  return results;
}

/**
 * Calculates storage statistics for the recordings directory.
 */
async function getStorageStats(storagePath, limitGb) {
  try {
    await fs.ensureDir(storagePath);
    const files = await scanRecordingsRecursively(storagePath);
    
    let totalSizeBytes = files.reduce((sum, f) => sum + f.size, 0);
    let mp4Count = files.length;

    const limitBytes = limitGb * 1024 * 1024 * 1024;
    const usagePercent = limitBytes > 0 
      ? Math.min((totalSizeBytes / limitBytes) * 100, 100).toFixed(1)
      : 0;

    return {
      path: storagePath,
      limitGb: limitGb,
      usedBytes: totalSizeBytes,
      usedGb: (totalSizeBytes / (1024 * 1024 * 1024)).toFixed(3),
      usagePercent: parseFloat(usagePercent),
      fileCount: mp4Count
    };
  } catch (error) {
    console.error('[Web Server] Error calculating storage stats:', error.message);
    return {
      path: storagePath,
      limitGb: limitGb,
      usedBytes: 0,
      usedGb: '0.000',
      usagePercent: 0,
      fileCount: 0
    };
  }
}

/**
 * Retrieves the list of recorded files sorted by modification date.
 * Identifies the currently active recording segment to prevent browser player errors.
 */
async function getRecordings(storagePath, activeRecorders) {
  try {
    await fs.ensureDir(storagePath);
    const files = await scanRecordingsRecursively(storagePath);
    const recordings = [];

    // Identify cameras that are actively running their recording process
    const activeRecordingCameraNames = activeRecorders
      .filter(r => r.ffmpegProcess && r.camera.enabled !== false)
      .map(r => r.camera.name.toLowerCase());

    for (const item of files) {
      const parts = item.filename.split('_');
      const cameraName = parts.length > 0 ? parts[0] : 'Unknown';

      recordings.push({
        filename: item.filename,
        relativePath: item.relativePath,
        cameraName: cameraName,
        sizeMb: (item.size / (1024 * 1024)).toFixed(2),
        mtime: item.mtime,
        created: item.mtimeDate.toLocaleString(),
        isActive: false
      });
    }

    // Sort newest first
    recordings.sort((a, b) => b.mtime - a.mtime);

    // Flag the newest file for each actively recording camera as active/incomplete
    const newestByCamera = {};
    recordings.forEach(rec => {
      const camLower = rec.cameraName.toLowerCase();
      if (activeRecordingCameraNames.includes(camLower)) {
        if (!newestByCamera[camLower] || rec.mtime > newestByCamera[camLower].mtime) {
          newestByCamera[camLower] = rec;
        }
      }
    });

    recordings.forEach(rec => {
      const camLower = rec.cameraName.toLowerCase();
      if (newestByCamera[camLower] && newestByCamera[camLower].filename === rec.filename) {
        rec.isActive = true;
      }
    });

    return recordings;
  } catch (error) {
    console.error('[Web Server] Error reading recordings library:', error.message);
    return [];
  }
}

/**
 * Spawns an FFmpeg process to capture a single frame from the RTSP stream.
 */
function grabCameraSnapshot(rtspUri) {
  return new Promise((resolve, reject) => {
    const args = [
      '-rtsp_transport', 'tcp',
      '-timeout', '5000000', // 5-second socket timeout
      '-y',
      '-i', rtspUri,
      '-vframes', '1',
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      'pipe:1'
    ];

    const proc = spawn(ffmpegStatic, args);
    const chunks = [];

    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    proc.stderr.on('data', () => {
      // Omit stderr log noise
    });

    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`FFmpeg frame-grabber exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Starts the Express web server.
 * @param {Object} config - System configuration reference.
 * @param {Array<CameraRecorder>} recorders - Active camera recorders.
 * @param {Function} onStoragePathChange - Callback invoked when settings change.
 * @returns {Object} Express server instance.
 */
export function startWebServer(config, recorders, onStoragePathChange) {
  const app = express();
  const port = config.web_port || 3000;

  // Run initial offline license check
  checkLicense();
  if (isActivated) {
    console.log('[License] Software is fully activated.');
  } else {
    console.log('[License] WARNING: Software not activated. Access restricted to activation panel.');
  }

  app.use(express.json());

  // Licensing Verification & Security Middleware Guard
  app.use((req, res, next) => {
    const publicPaths = [
      '/activate.html',
      '/owner.html',
      '/api/license/hardware-id',
      '/api/license/activate',
      '/api/owner/login',
      '/api/owner/generate',
      '/api/owner/licenses',
      '/styles.css'
    ];
    
    const isPublic = publicPaths.some(p => req.path === p || req.path.startsWith('/api/owner/licenses'));
    
    if (!isActivated && !isPublic) {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ success: false, message: 'Software not activated.' });
      }
      return res.redirect('/activate.html');
    }
    next();
  });

  app.use(express.static('public'));

  app.use('/recordings', (req, res, next) => {
    express.static(config.storage_path)(req, res, next);
  });

  // --- Licensing API Endpoints ---
  app.get('/api/license/hardware-id', (req, res) => {
    res.json({ hardwareId: getHardwareId() });
  });

  app.post('/api/license/activate', async (req, res) => {
    const { licenseKey } = req.body;
    if (!licenseKey) {
      return res.status(400).json({ success: false, message: 'License key is required.' });
    }

    const localHardwareId = getHardwareId();
    const expectedKey = generateActivationKey(localHardwareId);

    if (licenseKey.trim() === expectedKey) {
      const licensePath = process.env.APPDATA 
        ? path.join(process.env.APPDATA, 'EyeTechVMS', 'license.json')
        : path.join(path.resolve(), 'license.json');
      try {
        fs.ensureDirSync(path.dirname(licensePath));
        fs.writeJsonSync(licensePath, { licenseKey: licenseKey.trim() });
        isActivated = true;
        console.log('[License] Activation key matched. VMS unlocked!');
        
        // Trigger recorders starting sequence on successful activation
        recorders.forEach(r => {
          if (r.camera.enabled !== false && !r.ffmpegProcess) {
            r.start();
          }
        });

        return res.json({ success: true, message: 'Activation successful.' });
      } catch (err) {
        console.error('[License] Failed to write license.json:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to write activation key to local disk.' });
      }
    } else {
      return res.status(400).json({ success: false, message: 'Invalid Activation Key.' });
    }
  });

  // --- Owner Management Panel API Endpoints (Password Protected) ---
  const adminPassword = config.admin_password || 'EyeTechAdmin2026';

  function authorizeOwner(req, res, next) {
    const password = req.headers['x-admin-password'] || req.body.password;
    if (password === adminPassword) {
      next();
    } else {
      res.status(401).json({ success: false, message: 'Unauthorized. Incorrect administrator password.' });
    }
  }

  app.post('/api/owner/login', (req, res) => {
    const { password } = req.body;
    if (password === adminPassword) {
      res.json({ success: true, message: 'Login successful.' });
    } else {
      res.status(401).json({ success: false, message: 'Incorrect administrator password.' });
    }
  });

  app.post('/api/owner/generate', authorizeOwner, async (req, res) => {
    const { customerName, hardwareId } = req.body;
    if (!customerName || !hardwareId) {
      return res.status(400).json({ success: false, message: 'Customer Name and Hardware ID are required.' });
    }

    const key = generateActivationKey(hardwareId.trim());
    const issuedPath = path.join(path.resolve(), 'licenses_issued.json');
    let records = [];

    if (fs.existsSync(issuedPath)) {
      try {
        records = fs.readJsonSync(issuedPath);
      } catch (e) {
        console.error('[License] Failed to parse licenses_issued.json:', e.message);
      }
    }

    const newRecord = {
      id: crypto.randomBytes(4).toString('hex'),
      customerName: customerName.trim(),
      hardwareId: hardwareId.trim(),
      activationKey: key,
      created: new Date().toLocaleString()
    };

    records.push(newRecord);
    fs.writeJsonSync(issuedPath, records, { spaces: 2 });

    res.json({ success: true, license: newRecord });
  });

  app.get('/api/owner/licenses', authorizeOwner, (req, res) => {
    const issuedPath = path.join(path.resolve(), 'licenses_issued.json');
    let records = [];
    if (fs.existsSync(issuedPath)) {
      try {
        records = fs.readJsonSync(issuedPath);
      } catch (e) {
        console.error('[License] Failed to read licenses_issued.json:', e.message);
      }
    }
    res.json(records);
  });

  app.delete('/api/owner/licenses/:id', authorizeOwner, (req, res) => {
    const id = req.params.id;
    const issuedPath = path.join(path.resolve(), 'licenses_issued.json');
    if (!fs.existsSync(issuedPath)) {
      return res.status(404).json({ success: false, message: 'No licenses database found.' });
    }

    try {
      let records = fs.readJsonSync(issuedPath);
      const filtered = records.filter(r => r.id !== id);
      fs.writeJsonSync(issuedPath, filtered, { spaces: 2 });
      res.json({ success: true, message: 'License record deleted from logs.' });
    } catch (e) {
      console.error('[License] Failed to delete license record:', e.message);
      res.status(500).json({ success: false, message: 'Failed to delete license record.' });
    }
  });
  // ------------------------------------------------------------------

  // API Route: Current System and Camera Status
  app.get('/api/status', async (req, res) => {
    const cameraStatuses = await Promise.all(recorders.map(async (r) => {
      const isEnabled = r.camera.enabled !== false;
      let status = 'idle';

      if (!isEnabled) {
        const isOnline = await checkCameraOnline(r.camera.ip, r.camera.port || 80);
        status = isOnline ? 'online' : 'offline';
      } else {
        status = r.ffmpegProcess ? 'recording' : (r.reconnectTimeout ? 'retrying' : 'idle');
      }

      return {
        name: r.camera.name,
        ip: r.camera.ip,
        port: r.camera.port || 80,
        enabled: isEnabled,
        compression: r.camera.compression || 'copy',
        status: status
      };
    }));

    const storageStats = await getStorageStats(config.storage_path, config.max_storage_gb);

    res.json({
      cameras: cameraStatuses,
      storage: storageStats
    });
  });

  // API Route: Fetch live camera snapshot preview
  app.get('/api/cameras/:name/snapshot', async (req, res) => {
    const name = req.params.name;
    const recorder = recorders.find(r => r.camera.name.toLowerCase() === name.toLowerCase());

    if (!recorder) {
      return res.status(404).json({ error: `Camera "${name}" not found.` });
    }

    try {
      const uris = await getCameraUris(recorder.camera);
      
      // 1. Try to fetch HTTP JPEG directly from camera using custom Basic/Digest authenticated client
      if (uris && uris.snapshotUri) {
        try {
          const snapshotBuffer = await fetchWithDigest(
            uris.snapshotUri,
            recorder.camera.username,
            recorder.camera.password,
            2500
          );
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
          return res.send(snapshotBuffer);
        } catch (fetchErr) {
          console.warn(`[Web Server] HTTP Snapshot download failed for "${name}", falling back to RTSP:`, fetchErr.message);
        }
      }

      // 2. Fall back to FFmpeg frame grab from RTSP stream (compatible, supports all auth engines)
      if (uris && uris.rtspUri) {
        const snapshotBuffer = await grabCameraSnapshot(uris.rtspUri);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.send(snapshotBuffer);
      } else {
        throw new Error('Failed to retrieve a valid RTSP stream path or HTTP snapshot URL.');
      }
    } catch (err) {
      console.error(`[Web Server] Snapshot grab failed for camera "${name}":`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // API Route: Real-time 30-50 FPS MJPEG Stream
  app.get('/api/cameras/:name/stream', async (req, res) => {
    const name = req.params.name;
    const recorder = recorders.find(r => r.camera.name.toLowerCase() === name.toLowerCase());

    if (!recorder) {
      return res.status(404).json({ error: `Camera "${name}" not found.` });
    }

    try {
      const uris = await getCameraUris(recorder.camera);
      if (!uris || !uris.rtspUri) {
        throw new Error(`No RTSP stream URI found for camera "${name}".`);
      }

      console.log(`[Web Server] Starting real-time 30-50 FPS MJPEG stream for "${name}"...`);

      // Set boundary-based MJPEG stream headers
      res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=ffmpeg');
      res.setHeader('Connection', 'close');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

      // Spawn FFmpeg to decode RTSP and re-encode to MJPEG stream on stdout
      const args = [
        '-rtsp_transport', 'tcp',
        '-timeout', '5000000',
        '-i', uris.rtspUri,
        '-an',
        '-f', 'mpjpeg',
        '-q:v', '5', // Quality factor (1-31, lower is better. 5 is very high quality, low bandwidth)
        'pipe:1'
      ];

      const proc = spawn(ffmpegStatic, args);
      proc.stdout.pipe(res);

      // Handle user leaving/modal closed: kill process immediately to free CPU
      req.on('close', () => {
        console.log(`[Web Server] MJPEG live stream socket closed for "${name}". Terminating FFmpeg process.`);
        proc.kill('SIGKILL');
      });

      proc.on('error', (err) => {
        console.error(`[Web Server] MJPEG live stream FFmpeg process error for "${name}":`, err.message);
      });
    } catch (err) {
      console.error(`[Web Server] Failed to initiate stream for camera "${name}":`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // API Route: List recordings
  app.get('/api/recordings', async (req, res) => {
    const list = await getRecordings(config.storage_path, recorders);
    res.json(list);
  });

  // API Route: Available drives list
  app.get('/api/drives', async (req, res) => {
    const drives = await getLogicalDrives();
    res.json(drives);
  });

  // API Route: Get entire configuration
  app.get('/api/settings', async (req, res) => {
    try {
      const configData = await fs.readJson(getConfigFilePath());
      res.json(configData);
    } catch (err) {
      console.error('[Web Server] Failed to read configuration:', err.message);
      res.status(500).json({ error: `Failed to load settings: ${err.message}` });
    }
  });

  // API Route: Update general settings
  app.post('/api/settings', async (req, res) => {
    const { max_storage_gb, chunk_minutes, auto_overwrite } = req.body;
    if (max_storage_gb === undefined || chunk_minutes === undefined) {
      return res.status(400).json({ error: 'max_storage_gb and chunk_minutes are required' });
    }

    try {
      const configPath = getConfigFilePath();
      const currentConfig = await fs.readJson(configPath);
      
      currentConfig.max_storage_gb = parseFloat(max_storage_gb);
      currentConfig.chunk_minutes = parseInt(chunk_minutes);
      if (auto_overwrite !== undefined) {
        currentConfig.auto_overwrite = !!auto_overwrite;
      }

      await fs.writeJson(configPath, currentConfig, { spaces: 2 });

      config.max_storage_gb = currentConfig.max_storage_gb;
      config.chunk_minutes = currentConfig.chunk_minutes;
      config.auto_overwrite = currentConfig.auto_overwrite;

      console.log(`[Web Server] Settings updated. Limit: ${config.max_storage_gb} GB, Chunk: ${config.chunk_minutes} mins, Auto-Overwrite: ${config.auto_overwrite}`);

      if (typeof onStoragePathChange === 'function') {
        onStoragePathChange(config.storage_path);
      }

      res.json({ success: true, config: currentConfig });
    } catch (err) {
      console.error('[Web Server] Failed to update settings:', err.message);
      res.status(500).json({ error: `Failed to save settings: ${err.message}` });
    }
  });

  // API Route: Update storage path
  app.post('/api/settings/storage', async (req, res) => {
    const { storage_path: newPath } = req.body;
    if (!newPath) {
      return res.status(400).json({ error: 'storage_path is required' });
    }

    try {
      const absolutePath = path.resolve(newPath);
      await fs.ensureDir(absolutePath);

      const configPath = getConfigFilePath();
      const currentConfig = await fs.readJson(configPath);
      currentConfig.storage_path = absolutePath;
      await fs.writeJson(configPath, currentConfig, { spaces: 2 });

      config.storage_path = absolutePath;
      console.log(`[Web Server] Storage path dynamically reconfigured to: "${absolutePath}"`);

      if (typeof onStoragePathChange === 'function') {
        onStoragePathChange(absolutePath);
      }

      res.json({ success: true, storage_path: absolutePath });
    } catch (err) {
      console.error('[Web Server] Failed to reconfigure storage path:', err.message);
      res.status(500).json({ error: `Failed to configure path: ${err.message}` });
    }
  });

  // API Route: Add or edit a camera
  app.post('/api/settings/cameras', async (req, res) => {
    const { camera } = req.body;
    if (!camera || !camera.name || !camera.ip) {
      return res.status(400).json({ error: 'Camera name and IP are required' });
    }

    try {
      const configPath = getConfigFilePath();
      const currentConfig = await fs.readJson(configPath);
      if (!currentConfig.cameras) currentConfig.cameras = [];

      const index = currentConfig.cameras.findIndex(c => c.name.toLowerCase() === camera.name.toLowerCase());
      
      const cameraObj = {
        name: camera.name,
        ip: camera.ip,
        port: parseInt(camera.port) || 80,
        username: camera.username || 'admin',
        password: camera.password || '',
        enabled: camera.enabled !== false,
        compression: camera.compression || 'copy'
      };

      if (index !== -1) {
        currentConfig.cameras[index] = cameraObj;
        console.log(`[Web Server] Camera "${camera.name}" updated (Enabled: ${cameraObj.enabled}, Quality: ${cameraObj.compression}).`);
      } else {
        currentConfig.cameras.push(cameraObj);
        console.log(`[Web Server] Camera "${camera.name}" added (Enabled: ${cameraObj.enabled}, Quality: ${cameraObj.compression}).`);
      }

      await fs.writeJson(configPath, currentConfig, { spaces: 2 });

      config.cameras = currentConfig.cameras;
      clearRtspCache();

      if (typeof onStoragePathChange === 'function') {
        onStoragePathChange(config.storage_path);
      }

      res.json({ success: true, cameras: currentConfig.cameras });
    } catch (err) {
      console.error('[Web Server] Failed to save camera:', err.message);
      res.status(500).json({ error: `Failed to save camera: ${err.message}` });
    }
  });
  // API Route: Quick toggle enabled state for ALL cameras at once
  app.post('/api/settings/cameras/toggle-all', async (req, res) => {
    const { enabled } = req.body;
    if (enabled === undefined) {
      return res.status(400).json({ error: 'enabled parameter is required' });
    }

    try {
      const configPath = getConfigFilePath();
      const currentConfig = await fs.readJson(configPath);
      if (!currentConfig.cameras) currentConfig.cameras = [];

      currentConfig.cameras.forEach(cam => {
        cam.enabled = !!enabled;
      });

      await fs.writeJson(configPath, currentConfig, { spaces: 2 });

      config.cameras = currentConfig.cameras;
      clearRtspCache();

      console.log(`[Web Server] ALL cameras dynamically toggled to: ${enabled ? 'Enabled' : 'Disabled'}`);

      if (typeof onStoragePathChange === 'function') {
        onStoragePathChange(config.storage_path);
      }

      res.json({ success: true, enabled: !!enabled });
    } catch (err) {
      console.error('[Web Server] Failed to toggle all cameras:', err.message);
      res.status(500).json({ error: `Failed to toggle all cameras: ${err.message}` });
    }
  });

  // API Route: Quick toggle enabled state for a camera
  app.post('/api/settings/cameras/:name/toggle', async (req, res) => {
    const name = req.params.name;
    const { enabled } = req.body;
    if (enabled === undefined) {
      return res.status(400).json({ error: 'enabled parameter is required' });
    }

    try {
      const configPath = getConfigFilePath();
      const currentConfig = await fs.readJson(configPath);
      if (!currentConfig.cameras) currentConfig.cameras = [];

      const index = currentConfig.cameras.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
      if (index === -1) {
        return res.status(404).json({ error: `Camera "${name}" not found.` });
      }

      currentConfig.cameras[index].enabled = !!enabled;
      await fs.writeJson(configPath, currentConfig, { spaces: 2 });

      config.cameras = currentConfig.cameras;
      clearRtspCache();

      console.log(`[Web Server] Camera "${name}" dynamically toggled to: ${enabled ? 'Enabled' : 'Disabled'}`);

      if (typeof onStoragePathChange === 'function') {
        onStoragePathChange(config.storage_path);
      }

      res.json({ success: true, enabled: !!enabled });
    } catch (err) {
      console.error('[Web Server] Failed to toggle camera:', err.message);
      res.status(500).json({ error: `Failed to toggle camera: ${err.message}` });
    }
  });

  // API Route: Quick update compression option
  app.post('/api/settings/cameras/:name/compression', async (req, res) => {
    const name = req.params.name;
    const { compression } = req.body;
    if (!compression) {
      return res.status(400).json({ error: 'compression parameter is required' });
    }

    try {
      const configPath = getConfigFilePath();
      const currentConfig = await fs.readJson(configPath);
      if (!currentConfig.cameras) currentConfig.cameras = [];

      const index = currentConfig.cameras.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
      if (index === -1) {
        return res.status(404).json({ error: `Camera "${name}" not found.` });
      }

      currentConfig.cameras[index].compression = compression;
      await fs.writeJson(configPath, currentConfig, { spaces: 2 });

      config.cameras = currentConfig.cameras;
      clearRtspCache();
      console.log(`[Web Server] Camera "${name}" compression changed to: ${compression}`);

      if (typeof onStoragePathChange === 'function') {
        onStoragePathChange(config.storage_path);
      }

      res.json({ success: true, compression });
    } catch (err) {
      console.error('[Web Server] Failed to change camera compression:', err.message);
      res.status(500).json({ error: `Failed to change compression: ${err.message}` });
    }
  });

  // API Route: Delete a camera
  app.delete('/api/settings/cameras/:name', async (req, res) => {
    const name = req.params.name;
    try {
      const configPath = getConfigFilePath();
      const currentConfig = await fs.readJson(configPath);
      if (!currentConfig.cameras) currentConfig.cameras = [];

      const initialLength = currentConfig.cameras.length;
      currentConfig.cameras = currentConfig.cameras.filter(c => c.name.toLowerCase() !== name.toLowerCase());

      if (currentConfig.cameras.length === initialLength) {
        return res.status(404).json({ error: `Camera "${name}" not found.` });
      }

      await fs.writeJson(configPath, currentConfig, { spaces: 2 });

      config.cameras = currentConfig.cameras;
      clearRtspCache();
      console.log(`[Web Server] Camera "${name}" deleted from configuration.`);

      if (typeof onStoragePathChange === 'function') {
        onStoragePathChange(config.storage_path);
      }

      res.json({ success: true, cameras: currentConfig.cameras });
    } catch (err) {
      console.error('[Web Server] Failed to delete camera:', err.message);
      res.status(500).json({ error: `Failed to delete camera: ${err.message}` });
    }
  });

  // API Route: Trigger ONVIF WS-Discovery network probe scan
  app.post('/api/discover', async (req, res) => {
    console.log('[Web Server] Launching ONVIF network auto-discovery scan...');
    try {
      const devices = await Discovery.probe({ timeout: 4000 });
      
      const list = devices.map(d => ({
        ip: d.hostname,
        port: d.port || 80,
        path: d.path,
        urn: d.urn
      }));

      console.log(`[Web Server] Discovery completed. Discovered ${list.length} network camera(s).`);
      res.json(list);
    } catch (err) {
      console.error('[Web Server] Auto-discovery search failed:', err.message);
      res.status(500).json({ error: `Discovery scan failed: ${err.message}` });
    }
  });

  // Start listening
  const server = app.listen(port, () => {
    console.log(`[Web Server] VMS Web Dashboard running at: http://localhost:${port}`);
  });

  return server;
}
