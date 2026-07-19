import fs from 'fs-extra';
import path from 'path';

/**
 * Checks the total size of the storage directory and deletes the oldest MP4 files
 * until the total size is within the configured limit.
 * @param {string} storagePath - The directory where recordings are saved.
 * @param {number} maxStorageGb - The maximum allowed directory size in Gigabytes.
 */
export async function checkAndRotateStorage(storagePath, maxStorageGb) {
  console.log(`[Storage] Starting storage check for: "${storagePath}"`);
  
  try {
    // Ensure the storage directory exists
    await fs.ensureDir(storagePath);

    // Read all files in the directory
    const files = await fs.readdir(storagePath);
    const mp4Files = [];

    for (const file of files) {
      const filePath = path.join(storagePath, file);
      const stat = await fs.stat(filePath);

      if (stat.isFile() && file.endsWith('.mp4')) {
        mp4Files.push({
          path: filePath,
          name: file,
          size: stat.size,
          mtime: stat.mtimeMs // Modification time in milliseconds
        });
      }
    }

    // Sort files by modification time, oldest first
    mp4Files.sort((a, b) => a.mtime - b.mtime);

    // Calculate total size in bytes
    let totalSizeBytes = mp4Files.reduce((sum, file) => sum + file.size, 0);
    const limitBytes = maxStorageGb * 1024 * 1024 * 1024;
    
    const currentGb = (totalSizeBytes / (1024 * 1024 * 1024)).toFixed(3);
    console.log(`[Storage] Current size: ${currentGb} GB / Limit: ${maxStorageGb} GB (${mp4Files.length} MP4 files)`);

    if (totalSizeBytes > limitBytes) {
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
  const { storage_path, max_storage_gb } = config;
  const intervalMs = 30 * 60 * 1000; // 30 minutes

  // Run immediately on startup
  checkAndRotateStorage(storage_path, max_storage_gb);

  // Set up background timer
  const intervalId = setInterval(() => {
    checkAndRotateStorage(storage_path, max_storage_gb);
  }, intervalMs);

  console.log(`[Storage] Background storage rotation scheduled to run every 30 minutes.`);
  
  return intervalId;
}
