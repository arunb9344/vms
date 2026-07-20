import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { CameraRecorder } from './recorder.js';
import { startStorageRotation } from './storage.js';
import { startWebServer } from './server.js';

const LICENSE_SECRET = 'eyetech_vms_securities_secret_passphrase_2026';

function isLicenseValid() {
  const licensePath = process.env.APPDATA 
    ? path.join(process.env.APPDATA, 'EyeTechVMS', 'license.json')
    : path.resolve('./license.json');
  if (!fs.existsSync(licensePath)) return false;
  try {
    const licenseData = fs.readJsonSync(licensePath);
    let serial = '';
    try {
      const output = execSync('powershell -Command "Get-CimInstance Win32_BaseBoard | Select-Object -ExpandProperty SerialNumber"', { encoding: 'utf8' });
      serial = output.trim().replace(/[\s\r\n\t\-]+/g, '').toUpperCase();
      if (!serial || serial === 'TOBEFILLEDBYOEM' || serial === 'NONE') {
        const cpuOutput = execSync('powershell -Command "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty ProcessorId"', { encoding: 'utf8' });
        serial = cpuOutput.trim().replace(/[\s\r\n\t\-]+/g, '').toUpperCase() || 'GENERIC-HWID-12345';
      }
    } catch (e) {
      serial = 'FALLBACK-HWID-67890';
    }
    const hash = crypto.createHash('md5').update(serial).digest('hex').toUpperCase();
    const hardwareId = `EYETECH-${hash.substring(0, 4)}-${hash.substring(4, 8)}`;
    const hmac = crypto.createHmac('sha256', LICENSE_SECRET).update(hardwareId).digest('hex').toUpperCase();
    const expectedKey = `ET-VMS-${hmac.substring(0, 4)}-${hmac.substring(4, 8)}-${hmac.substring(8, 12)}-${hmac.substring(12, 16)}`;
    
    return licenseData.licenseKey === expectedKey;
  } catch (err) {
    return false;
  }
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

async function main() {
  console.log('====================================================');
  console.log('  Lightweight Video Management System (VMS) Startup ');
  console.log('====================================================');

  let config;
  try {
    const configPath = getConfigFilePath();
    config = await fs.readJson(configPath);
    console.log(`[System] Configuration successfully loaded from "${configPath}".`);
  } catch (error) {
    console.error(`[System] [Error] Failed to load config.json: ${error.message}`);
    process.exit(1);
  }

  // Resolve storage path to an absolute path
  config.storage_path = path.resolve(config.storage_path);
  console.log(`[System] Target Storage Directory: "${config.storage_path}"`);

  // Ensure storage path folder exists
  try {
    await fs.ensureDir(config.storage_path);
    console.log(`[System] Storage directory verified/created.`);
  } catch (error) {
    console.error(`[System] [Error] Failed to create storage directory: ${error.message}`);
    process.exit(1);
  }

  // 1. Initialize and start storage rotation management
  let storageInterval = startStorageRotation(config);

  // 2. Initialize recording engines array.
  // We keep a single array reference so that Express server.js always points to the active list.
  const recorders = [];

  const startRecorders = () => {
    const activeCameras = config.cameras;
    if (!activeCameras || activeCameras.length === 0) {
      console.warn('[System] No cameras found in configuration.');
      return;
    }
    console.log(`[System] Starting recorders for ${activeCameras.length} camera(s)...`);
    for (const cameraConfig of activeCameras) {
      const recorder = new CameraRecorder(cameraConfig, config);
      recorders.push(recorder);
      
      if (cameraConfig.enabled !== false) {
        if (isLicenseValid()) {
          recorder.start();
        } else {
          console.log(`[System] Camera "${cameraConfig.name}" is enabled but skipped (unactivated license).`);
        }
      } else {
        console.log(`[System] Camera "${cameraConfig.name}" is disabled. Continuous recording skipped.`);
      }
    }
  };

  const stopRecorders = () => {
    console.log('[System] Stopping camera recorders...');
    for (const recorder of recorders) {
      recorder.stop();
    }
    recorders.length = 0; // Clears the array in-place, keeping the reference intact for server.js
  };

  // Start the recorders initially
  startRecorders();

  // 3. Define the reload callback for storage settings changes
  const onStoragePathChange = (newPath) => {
    console.log('\n[System] Reconfiguring storage path on-the-fly...');
    
    // Stop recording and clear storage interval
    stopRecorders();
    clearInterval(storageInterval);

    // Apply new path in config
    config.storage_path = newPath;

    // Restart storage rotation checking on the new folder
    storageInterval = startStorageRotation(config);

    // Restart camera recording onto the new path
    startRecorders();
    
    console.log('[System] Storage path reconfiguration complete.');
  };

  // 4. Start the Web Server Dashboard
  console.log('[System] Launching Web UI Server...');
  const webServer = startWebServer(config, recorders, onStoragePathChange);

  console.log('====================================================');
  console.log('  VMS is now running. Press Ctrl+C to stop recording.  ');
  console.log('====================================================');

  // Graceful shutdown logic
  let isShuttingDown = false;
  const gracefulShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log('\n====================================================');
    console.log('  Gracefully shutting down Video Management System...  ');
    console.log('====================================================');

    // Clear storage check interval
    clearInterval(storageInterval);

    // Stop Web Server
    try {
      console.log('[System] Stopping Web Server...');
      webServer.close();
    } catch (err) {
      console.error('[System] Error stopping Web Server:', err.message);
    }

    // Stop all recording processes
    stopRecorders();

    console.log('[System] Shutdown complete. Exiting.');
    process.exit(0);
  };

  // Register process termination handlers
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

// Execute the main script
main().catch((err) => {
  console.error('[System] Fatal error in main loop:', err);
  process.exit(1);
});
