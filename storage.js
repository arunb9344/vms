import fs from 'fs-extra';
import path from 'path';

/**
 * Recursively scans a directory for all .mp4 recording files.
 * @param {string} dir - Directory path to scan.
 * @returns {Promise<Array<{path: string, name: string, size: number, mtime: number}>>}
 */
async function getAllMp4Files(dir) {
  let mp4Files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await getAllMp4Files(fullPath);
        mp4Files = mp4Files.concat(subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.mp4')) {
        const stat = await fs.stat(fullPath);
        mp4Files.push({
          path: fullPath,
          name: entry.name,
          size: stat.size,
          mtime: stat.mtimeMs
        });
      }
    }
  } catch (err) {
    console.error(`[Storage] Subfolder scan error in "${dir}":`, err.message);
  }
  return mp4Files;
}

/**
 * Checks the total size of the storage directory and deletes the oldest MP4 files
 * until the total size is within the configured limit (if autoOverwrite is enabled).
 * @param {string} storagePath - The directory where recordings are saved.
 * @param {number} maxStorageGb - The maximum allowed directory size in Gigabytes.
 * @param {boolean} autoOverwrite - Whether to automatically delete old recordings when limit is reached.
 */
export async function checkAndRotateStorage(storagePath, maxStorageGb, autoOverwrite = true) {
  console.log(`[Storage] Starting storage check for: "${storagePath}" (Auto-Overwrite: ${autoOverwrite ? 'ENABLED' : 'DISABLED'})`);
  
  try {
    // Ensure the storage directory exists
    await fs.ensureDir(storagePath);

    // Read all MP4 files recursively
    const mp4Files = await getAllMp4Files(storagePath);

    // Sort files by modification time, oldest first
    mp4Files.sort((a, b) => a.mtime - b.mtime);

    // Calculate total size in bytes
    let totalSizeBytes = mp4Files.reduce((sum, file) => sum + file.size, 0);
    const limitBytes = maxStorageGb * 1024 * 1024 * 1024;
    
    const currentGb = (totalSizeBytes / (1024 * 1024 * 1024)).toFixed(3);
    console.log(`[Storage] Current size: ${currentGb} GB / Limit: ${maxStorageGb} GB (${mp4Files.length} MP4 files)`);

    if (totalSizeBytes > limitBytes) {
      if (autoOverwrite === false) {
        console.warn(`[Storage] Storage limit of ${maxStorageGb} GB reached! Auto-overwrite is DISABLED. Skipping file deletion.`);
        return;
      }

      console.log(`[Storage] Limit exceeded. Rotating oldest files...`);
      
      for (const file of mp4Files) {
        if (totalSizeBytes <= limitBytes) {
          console.log(`[Storage] Storage is now within the limit of ${maxStorageGb} GB.`);
          break;
        }

        // Safety check: Do not delete files modified in the last 30 minutes
        // to protect the active recording files currently being written by FFmpeg.
        const ageMinutes = (Date.now() - file.mtime) / (1000 * 60);
        if (ageMinutes < 30) {
          console.log(`[Storage] Skipping file "${file.name}" because it is active or was recently written (${ageMinutes.toFixed(1)} mins old).`);
          continue;
        }

        try {
          console.log(`[Storage] Deleting oldest file: "${file.name}" (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);
          await fs.remove(file.path);
          
          // Deduct size from total
          totalSizeBytes -= file.size;
        } catch (err) {
          console.error(`[Storage] Failed to delete file "${file.name}": ${err.message}`);
        }
      }
    } else {
      console.log(`[Storage] Storage is within the limit. No rotation required.`);
    }
  } catch (error) {
    console.error(`[Storage] Error during storage check and rotation: ${error.message}`);
  }
}

/**
 * Starts a background loop to check and rotate the storage every 30 minutes.
 * @param {Object} config - The configuration object.
 * @returns {NodeJS.Timeout} The interval object.
 */
export function startStorageRotation(config) {
  const intervalMs = 30 * 60 * 1000; // 30 minutes

  // Run immediately on startup
  checkAndRotateStorage(config.storage_path, config.max_storage_gb, config.auto_overwrite !== false);

  // Set up background timer
  const intervalId = setInterval(() => {
    checkAndRotateStorage(config.storage_path, config.max_storage_gb, config.auto_overwrite !== false);
  }, intervalMs);

  console.log(`[Storage] Background storage rotation scheduled to run every 30 minutes.`);
  
  return intervalId;
}
