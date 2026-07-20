// VMS Dashboard Frontend Logic

// DOM Elements - General Views
const navDashboardTab = document.getElementById('nav-dashboard-tab');
const navSettingsTab = document.getElementById('nav-settings-tab');
const dashboardView = document.getElementById('dashboard-view');
const settingsView = document.getElementById('settings-view');
const viewTitle = document.getElementById('view-title');
const currentTimeEl = document.getElementById('current-time');

// DOM Elements - Dashboard Widgets
const activeCamerasCountEl = document.getElementById('active-cameras-count');
const camerasOnlineLabelEl = document.getElementById('cameras-online-label');
const storageLoadValueEl = document.getElementById('storage-load-value');
const storageFilesLabelEl = document.getElementById('storage-files-label');
const storageLimitValueEl = document.getElementById('storage-limit-value');
const storagePercentLabelEl = document.getElementById('storage-percent-label');
const cameraListContainer = document.getElementById('camera-list-container');
const diskProgressCircle = document.getElementById('disk-progress-circle');
const diskPercentText = document.getElementById('disk-percent-text');
const storageUsedMeta = document.getElementById('storage-used-meta');
const storageLimitMeta = document.getElementById('storage-limit-meta');
const recordingsTableBody = document.getElementById('recordings-table-body');
const refreshRecordingsBtn = document.getElementById('refresh-recordings-btn');

// DOM Elements - Settings & Camera Manager
const configCamerasTableBody = document.getElementById('config-cameras-table-body');
const generalSettingsForm = document.getElementById('general-settings-form');
const maxStorageInput = document.getElementById('max-storage-input');
const chunkMinutesInput = document.getElementById('chunk-minutes-input');
const autoOverwriteInput = document.getElementById('auto-overwrite-input');
const triggerAddCameraBtn = document.getElementById('trigger-add-camera-btn');
const triggerDiscoverBtn = document.getElementById('trigger-discover-btn');
const masterRecordingToggle = document.getElementById('master-recording-toggle');

// DOM Elements - Storage Location manager
const driveListContainer = document.getElementById('drive-list-container');
const folderNameInput = document.getElementById('folder-name-input');
const saveDriveBtn = document.getElementById('save-drive-btn');

// DOM Elements - Modals
const videoModal = document.getElementById('video-modal');
const playbackVideo = document.getElementById('playback-video');
const modalVideoTitle = document.getElementById('modal-video-title');
const modalVideoMeta = document.getElementById('modal-video-meta');

const cameraModal = document.getElementById('camera-modal');
const cameraConfigForm = document.getElementById('camera-config-form');
const cameraModalTitle = document.getElementById('camera-modal-title');
const camNameInput = document.getElementById('cam-name');
const camIpInput = document.getElementById('cam-ip');
const camPortInput = document.getElementById('cam-port');
const camUsernameInput = document.getElementById('cam-username');
const camPasswordInput = document.getElementById('cam-password');
const camEnabledInput = document.getElementById('cam-enabled');
const camCompressionInput = document.getElementById('cam-compression');

const discoverModal = document.getElementById('discover-modal');
const discoverResultsContainer = document.getElementById('discover-results-container');
const discoverRetryBtn = document.getElementById('discover-retry-btn');

const livePreviewModal = document.getElementById('live-preview-modal');
const livePreviewImg = document.getElementById('live-preview-img');
const livePreviewTitle = document.getElementById('live-preview-title');
const livePreviewLoader = document.getElementById('live-preview-loader');

// Global state
let selectedDriveLetter = null;
let activeStoragePath = '';
let livePreviewInterval = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Update date/time display
  updateDateTime();
  setInterval(updateDateTime, 1000);

  // Initial fetch and start polling loop
  fetchStatus();
  fetchRecordings();
  fetchDrives();
  
  // Poll system status every 5 seconds
  setInterval(fetchStatus, 5000);

  // Set up general event listeners
  refreshRecordingsBtn.addEventListener('click', fetchRecordings);
  saveDriveBtn.addEventListener('click', saveStorageLocation);

  // Master switch recording toggle listener
  if (masterRecordingToggle) {
    masterRecordingToggle.addEventListener('change', async (e) => {
      const isChecked = e.target.checked;
      masterRecordingToggle.disabled = true;
      try {
        const response = await fetch('/api/settings/cameras/toggle-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: isChecked })
        });
        if (!response.ok) {
          throw new Error('Failed to toggle all recorders');
        }
        console.log(`[App] All cameras toggled to: ${isChecked}`);
        await fetchStatus();
      } catch (error) {
        console.error('[App] Toggle all error:', error);
        alert(`Failed to toggle all cameras: ${error.message}`);
        e.target.checked = !isChecked; // Revert switch UI state
      } finally {
        masterRecordingToggle.disabled = false;
      }
    });
  }
  
  // Navigation tabs listeners
  navDashboardTab.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('dashboard');
  });

  navSettingsTab.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('settings');
  });

  // Camera settings actions listeners
  triggerAddCameraBtn.addEventListener('click', openAddCameraForm);
  triggerDiscoverBtn.addEventListener('click', startNetworkScan);
  discoverRetryBtn.addEventListener('click', startNetworkScan);

  // Forms submit listeners
  cameraConfigForm.addEventListener('submit', handleCameraFormSubmit);
  generalSettingsForm.addEventListener('submit', handleGeneralSettingsSubmit);
});

/**
 * Handles toggling views between Dashboard and Settings & Cameras.
 */
function switchView(view) {
  if (view === 'dashboard') {
    navDashboardTab.classList.add('active');
    navSettingsTab.classList.remove('active');
    dashboardView.style.display = 'flex';
    settingsView.style.display = 'none';
    viewTitle.textContent = 'System Overview';
  } else {
    navSettingsTab.classList.add('active');
    navDashboardTab.classList.remove('active');
    settingsView.style.display = 'block';
    dashboardView.style.display = 'none';
    viewTitle.textContent = 'System Settings & Cameras';
    fetchSettings(); // Refresh settings UI components
  }
}

/**
 * Updates the date/time header string.
 */
function updateDateTime() {
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  currentTimeEl.textContent = new Date().toLocaleDateString('en-US', options);
}

/**
 * Sets the stroke-dashoffset of the circular progress indicator.
 * R=80, Circumference = 502.65
 */
function setDiskProgressRing(percent) {
  const radius = 80;
  const circumference = 2 * Math.PI * radius; // 502.65
  
  diskProgressCircle.style.strokeDasharray = `${circumference} ${circumference}`;
  const offset = circumference - (percent / 100) * circumference;
  diskProgressCircle.style.strokeDashoffset = offset;
  
  // Set text
  diskPercentText.textContent = `${percent.toFixed(1)}%`;
}

/**
 * Fetches the system state and camera status from the backend.
 */
async function fetchStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('Failed to fetch status');
    
    const data = await response.json();
    updateStatusUI(data);
  } catch (error) {
    console.error('Error fetching VMS status:', error);
  }
}

/**
 * Fetches the files in the recording library.
 */
async function fetchRecordings() {
  try {
    const response = await fetch('/api/recordings');
    if (!response.ok) throw new Error('Failed to fetch recordings');
    
    const recordings = await response.json();
    renderRecordings(recordings);
  } catch (error) {
    console.error('Error fetching recordings library:', error);
    recordingsTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--danger); padding: 20px 0;">
          Failed to load recordings database.
        </td>
      </tr>
    `;
  }
}

/**
 * Fetches available physical/external drives from the Windows backend.
 */
async function fetchDrives() {
  try {
    const response = await fetch('/api/drives');
    if (!response.ok) throw new Error('Failed to fetch drives');
    
    const drives = await response.json();
    renderDrives(drives);
  } catch (error) {
    console.error('Error fetching drives list:', error);
    driveListContainer.innerHTML = `
      <p style="color: var(--danger); font-size: 13px; text-align: center; padding: 10px 0;">
        Failed to scan logical drives on this PC.
      </p>
    `;
  }
}

/**
 * Fetches the complete configuration settings from the backend.
 */
async function fetchSettings() {
  try {
    const response = await fetch('/api/settings');
    if (!response.ok) throw new Error('Failed to fetch settings');
    
    const data = await response.json();
    
    // Fill settings inputs
    maxStorageInput.value = data.max_storage_gb;
    chunkMinutesInput.value = data.chunk_minutes;
    if (autoOverwriteInput) {
      autoOverwriteInput.checked = data.auto_overwrite !== false;
    }
    
    // Render configured cameras list
    renderConfiguredCameras(data.cameras || []);
  } catch (error) {
    console.error('Error fetching settings:', error);
  }
}

/**
 * Updates the UI elements based on API status payload.
 */
function updateStatusUI(data) {
  const { cameras, storage } = data;

  // 1. Update Camera Statistics
  const totalCameras = cameras.length;
  const onlineCameras = cameras.filter(c => c.status === 'recording' || c.status === 'online').length;
  
  activeCamerasCountEl.textContent = `${onlineCameras} / ${totalCameras}`;
  camerasOnlineLabelEl.textContent = `${onlineCameras} cameras online, ${totalCameras - onlineCameras} offline/retrying`;

  // 2. Update Storage Metrics
  storageLoadValueEl.textContent = `${storage.usedGb} GB`;
  storageFilesLabelEl.textContent = `${storage.fileCount} video segments`;
  storageLimitValueEl.textContent = `${storage.limitGb.toFixed(2)} GB`;
  storagePercentLabelEl.textContent = `${storage.usagePercent}% capacity utilized`;

  // Meta breakdown
  storageUsedMeta.textContent = `${storage.usedGb} GB`;
  storageLimitMeta.textContent = `${storage.limitGb.toFixed(2)} GB`;

  // 3. Update Disk Circular Progress Ring
  setDiskProgressRing(storage.usagePercent);

  // 4. Update Camera Connection Feed List
  renderCameras(cameras);

  // 5. Update local storage path tracker
  const wasEmpty = !activeStoragePath;
  activeStoragePath = storage.path;
  
  // Parse drive letter (e.g., C:) and prefill folder inputs
  if (wasEmpty) {
    const activeDriveMatch = activeStoragePath.match(/^[a-zA-Z]:/);
    if (activeDriveMatch && !selectedDriveLetter) {
      selectedDriveLetter = activeDriveMatch[0].toUpperCase();
      
      const normalizedPath = activeStoragePath.replace(/\\/g, '/');
      const pathParts = normalizedPath.split('/');
      const lastFolder = pathParts[pathParts.length - 1];
      if (lastFolder && lastFolder !== selectedDriveLetter) {
        folderNameInput.value = lastFolder;
      }
    }
  }

  // 6. Sync Master Recording Switch state
  if (masterRecordingToggle) {
    const totalCams = cameras.length;
    const enabledCams = cameras.filter(c => c.enabled !== false).length;
    masterRecordingToggle.checked = totalCams > 0 && enabledCams === totalCams;
  }
}

/**
 * Renders the health list of cameras on the dashboard.
 */
function renderCameras(cameras) {
  if (!cameras || cameras.length === 0) {
    cameraListContainer.innerHTML = `<p style="color: var(--text-dim); text-align: center; padding: 20px 0;">No cameras configured. Go to "Cameras & Settings" to add cameras.</p>`;
    return;
  }

  cameraListContainer.innerHTML = '';
  
  cameras.forEach(cam => {
    let badgeClass = 'badge-retrying';
    let dotColor = 'red';
    let avatarClass = '';
    let avatarIcon = 'video-off';
    
    if (cam.status === 'recording') {
      badgeClass = 'badge-recording';
      dotColor = 'green';
      avatarClass = 'recording';
      avatarIcon = 'video';
    } else if (cam.status === 'online') {
      badgeClass = 'badge-online';
      dotColor = 'green-static';
      avatarClass = '';
      avatarIcon = 'video';
    } else if (cam.status === 'offline') {
      badgeClass = 'badge-offline';
      dotColor = 'grey';
      avatarClass = 'disabled';
      avatarIcon = 'video-off';
    } else if (cam.status === 'retrying') {
      badgeClass = 'badge-retrying';
      dotColor = 'red';
      avatarClass = '';
      avatarIcon = 'video-off';
    }

    const item = document.createElement('div');
    item.className = 'camera-item';
    
    const isEnabled = cam.enabled !== false;
    const canPreview = cam.status === 'recording' || cam.status === 'online';

    item.innerHTML = `
      <div class="camera-info">
        <div class="camera-avatar ${avatarClass}">
          <i data-lucide="${avatarIcon}"></i>
        </div>
        <div class="camera-details">
          <h4>${cam.name}</h4>
          <p>${cam.ip}:${cam.port}</p>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 14px; margin-left: auto;">
        <!-- Quick Quality Profile Dropdown Switcher -->
        <select class="dashboard-compression-select" onchange="changeCameraCompression('${cam.name}', this.value)" style="background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 5px 8px; color: #fff; font-size: 12px; outline: none; cursor: pointer; transition: var(--transition);">
          <option value="copy" ${cam.compression === 'copy' ? 'selected' : ''}>Original Copy</option>
          <option value="high" ${cam.compression === 'high' ? 'selected' : ''}>H.264 High</option>
          <option value="medium" ${cam.compression === 'medium' ? 'selected' : ''}>H.264 Medium</option>
          <option value="low" ${cam.compression === 'low' ? 'selected' : ''}>H.264 Low</option>
          <option value="hevc" ${cam.compression === 'hevc' ? 'selected' : ''}>H.265+ HEVC</option>
        </select>

        <!-- Dynamic Manual Toggle Switch -->
        <label class="switch" title="${isEnabled ? 'Recording Active - Click to Disable' : 'Recording Paused - Click to Enable'}">
          <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleCameraRecording('${cam.name}', this.checked)">
          <span class="slider"></span>
        </label>

        <div class="camera-status-badge ${badgeClass}">
          <span class="pulse-dot ${dotColor}"></span>
          <span>${cam.status}</span>
        </div>

        ${canPreview ? `
          <button class="btn btn-live btn-sm" onclick="openLivePreviewModal('${cam.name}')">
            <i data-lucide="eye" style="width: 12px; height: 12px;"></i> Live View
          </button>
        ` : ''}
      </div>
    `;
    cameraListContainer.appendChild(item);
  });

  lucide.createIcons();
}

/**
 * Handles toggling camera recording enabled status on-the-fly.
 */
window.toggleCameraRecording = async function(name, isChecked) {
  try {
    const response = await fetch(`/api/settings/cameras/${encodeURIComponent(name)}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: isChecked })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to toggle recording');
    }

    console.log(`[App] Camera "${name}" dynamically set to enabled: ${isChecked}`);
    await fetchStatus();
  } catch (error) {
    console.error('[App] Toggle error:', error);
    alert(`Failed to change camera state: ${error.message}`);
    await fetchStatus();
  }
};

/**
 * Handles changing video encoding / compression quality profile from dashboard on-the-fly.
 */
window.changeCameraCompression = async function(name, compression) {
  try {
    const response = await fetch(`/api/settings/cameras/${encodeURIComponent(name)}/compression`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compression })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to update quality profile');
    }

    console.log(`[App] Camera "${name}" quality profile updated to: ${compression}`);
    await fetchStatus();
  } catch (error) {
    console.error('[App] Compression switch error:', error);
    alert(`Failed to change compression: ${error.message}`);
    await fetchStatus();
  }
};

/**
 * Renders the Windows drives list.
 */
function renderDrives(drives) {
  if (!drives || drives.length === 0) {
    driveListContainer.innerHTML = `<p style="color: var(--text-dim); text-align: center; font-size: 13px; padding: 10px 0;">No disk drives detected.</p>`;
    return;
  }

  driveListContainer.innerHTML = '';
  
  const activeDriveLetter = activeStoragePath ? activeStoragePath.substring(0, 2).toUpperCase() : '';

  drives.forEach(drive => {
    const letter = drive.driveLetter.toUpperCase();
    const percentUsed = (drive.usedGb / drive.sizeGb) * 100;
    
    let progressColorClass = '';
    if (percentUsed >= 90) progressColorClass = 'danger';
    else if (percentUsed >= 75) progressColorClass = 'warning';

    const isSelected = selectedDriveLetter 
      ? (selectedDriveLetter === letter) 
      : (activeDriveLetter === letter);

    if (isSelected && !selectedDriveLetter) {
      selectedDriveLetter = letter;
      saveDriveBtn.disabled = false;
    }

    const driveItem = document.createElement('div');
    driveItem.className = `drive-item ${isSelected ? 'selected' : ''}`;
    driveItem.dataset.drive = letter;

    driveItem.innerHTML = `
      <div class="drive-item-header">
        <span class="drive-name">
          <i data-lucide="hard-drive"></i>
          ${drive.volumeName} (${letter})
        </span>
        <span class="drive-cap">${drive.freeGb} GB free of ${drive.sizeGb} GB</span>
      </div>
      <div class="drive-progress-bar">
        <div class="drive-progress-fill ${progressColorClass}" style="width: ${percentUsed}%"></div>
      </div>
      <div class="drive-meta-text">
        <span>${percentUsed.toFixed(1)}% Used</span>
        <span>${drive.usedGb} GB Used</span>
      </div>
    `;

    driveItem.addEventListener('click', () => {
      document.querySelectorAll('.drive-item').forEach(item => {
        item.classList.remove('selected');
      });
      driveItem.classList.add('selected');
      selectedDriveLetter = letter;
      saveDriveBtn.disabled = false;
    });

    driveListContainer.appendChild(driveItem);
  });

  lucide.createIcons();
}

/**
 * Saves the selected drive location to the VMS backend settings.
 */
async function saveStorageLocation() {
  if (!selectedDriveLetter) return;
  
  const folderName = folderNameInput.value.trim() || 'Recordings';
  const targetPath = `${selectedDriveLetter}/${folderName}`;
  
  saveDriveBtn.disabled = true;
  saveDriveBtn.innerHTML = `<span class="spinner" style="width: 14px; height: 14px; border-width: 2px; display: inline-block; margin-right: 6px; vertical-align: middle;"></span> Applying...`;

  try {
    const response = await fetch('/api/settings/storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storage_path: targetPath })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to update storage settings');
    }

    const result = await response.json();
    console.log('[App] Storage directory changed successfully:', result.storage_path);
    
    activeStoragePath = result.storage_path;
    
    await fetchStatus();
    await fetchRecordings();
    await fetchDrives();
    
    alert(`Storage path dynamically reconfigured to: ${result.storage_path}`);
  } catch (error) {
    console.error('[App] Error saving storage drive:', error);
    alert(`Failed to save storage drive: ${error.message}`);
  } finally {
    saveDriveBtn.disabled = false;
    saveDriveBtn.innerHTML = `<i data-lucide="save" style="width: 16px; height: 16px;"></i> Set Storage Drive`;
    lucide.createIcons();
  }
}

/**
 * Renders the table of recording segments.
 */
function renderRecordings(recordings) {
  if (!recordings || recordings.length === 0) {
    recordingsTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-dim); padding: 40px 0;">
          No recordings found yet in the storage directory.
        </td>
      </tr>
    `;
    return;
  }

  recordingsTableBody.innerHTML = '';

  recordings.forEach(rec => {
    const row = document.createElement('tr');
    
    // Check if the segment is still active/incomplete
    const fileLabel = rec.isActive 
      ? `<span style="color: var(--primary); font-size: 11px; margin-left: 8px; background: rgba(0,240,255,0.08); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(0,240,255,0.2);">Recording in progress...</span>` 
      : '';

    row.innerHTML = `
      <td><strong>${rec.cameraName}</strong></td>
      <td>${rec.created}</td>
      <td><i data-lucide="video"></i> ${rec.filename} ${fileLabel}</td>
      <td>${rec.sizeMb} MB</td>
      <td>
        ${rec.isActive ? `
          <button class="btn btn-play" disabled style="opacity: 0.5; cursor: not-allowed;" title="This segment is currently being recorded. It will be playable once finalized.">
            <i data-lucide="play" style="width: 14px; height: 14px; margin-right: 0;"></i> Play
          </button>
        ` : `
          <button class="btn btn-play" onclick="playVideo('${rec.filename}', '${rec.cameraName}', '${rec.created}', '${rec.sizeMb}', '${encodeURIComponent(rec.relativePath || '')}')">
            <i data-lucide="play" style="width: 14px; height: 14px; margin-right: 0;"></i> Play
          </button>
        `}
      </td>
    `;
    recordingsTableBody.appendChild(row);
  });

  lucide.createIcons();
}

/**
 * Opens the video modal and plays the specified file.
 */
function playVideo(filename, cameraName, created, sizeMb, encodedRelativePath = '') {
  modalVideoTitle.textContent = `${cameraName} - Playback`;
  modalVideoMeta.textContent = `Recorded: ${created} | Size: ${sizeMb} MB | File: ${filename}`;
  
  const rawPath = encodedRelativePath ? decodeURIComponent(encodedRelativePath) : filename;
  const safePath = rawPath.split('/').map(encodeURIComponent).join('/');
  playbackVideo.src = `/recordings/${safePath}`;
  videoModal.classList.add('active');
  
  playbackVideo.load();
  playbackVideo.play().catch(err => console.log('Auto-play failed:', err.message));
  lucide.createIcons();
}

/**
 * Closes the playback modal and stops the video stream to save bandwidth/handles.
 */
function closeModal() {
  videoModal.classList.remove('active');
  playbackVideo.pause();
  playbackVideo.src = '';
}

/**
 * Renders the Camera configurations table inside Settings view.
 */
function renderConfiguredCameras(cameras) {
  if (!cameras || cameras.length === 0) {
    configCamerasTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-dim); padding: 30px 0;">
          No cameras configured yet. Add one below or use Auto-Discovery.
        </td>
      </tr>
    `;
    return;
  }

  configCamerasTableBody.innerHTML = '';
  
  cameras.forEach(cam => {
    const row = document.createElement('tr');
    const maskedPassword = cam.password ? '••••••••' : 'None';
    
    const isEnabled = cam.enabled !== false;
    const statusTag = isEnabled
      ? `<span class="camera-status-badge badge-recording" style="padding: 4px 8px; font-size: 11px;"><span class="pulse-dot green" style="width:6px; height:6px; animation: none;"></span> Active</span>`
      : `<span class="camera-status-badge badge-disabled" style="padding: 4px 8px; font-size: 11px;"><span class="pulse-dot grey" style="width:6px; height:6px; animation: none;"></span> Paused</span>`;

    const compLabel = cam.compression === 'high' 
      ? 'H.264 High' 
      : (cam.compression === 'medium' 
        ? 'H.264 Medium' 
        : (cam.compression === 'low' 
          ? 'H.264 Low' 
          : (cam.compression === 'hevc'
            ? 'H.265+ HEVC'
            : 'Original Copy')));

    row.innerHTML = `
      <td>
        <strong>${cam.name}</strong> ${statusTag}
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; font-weight: 500;">
          Encoding: <code style="color: var(--primary);">${compLabel}</code>
        </div>
      </td>
      <td>${cam.ip}:${cam.port}</td>
      <td><code>${cam.username}</code></td>
      <td><span style="color:var(--text-dim);">${maskedPassword}</span></td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="openEditCameraForm('${encodeURIComponent(JSON.stringify(cam))}')">
          <i data-lucide="edit-3" style="width:12px; height:12px;"></i> Edit
        </button>
        <button class="btn btn-danger btn-sm" onclick="deleteCamera('${cam.name}')" style="margin-left: 6px;">
          <i data-lucide="trash-2" style="width:12px; height:12px;"></i> Delete
        </button>
      </td>
    `;
    configCamerasTableBody.appendChild(row);
  });
  
  lucide.createIcons();
}

/**
 * Opens modal to add a new camera manually.
 */
function openAddCameraForm() {
  cameraModalTitle.textContent = 'Add New Camera';
  camNameInput.value = '';
  camNameInput.readOnly = false;
  camIpInput.value = '';
  camPortInput.value = '80';
  camUsernameInput.value = 'admin';
  camPasswordInput.value = '';
  camEnabledInput.checked = false; // Default: Disable (unchecked) as requested
  camCompressionInput.value = 'copy';
  
  cameraModal.classList.add('active');
  lucide.createIcons();
}

/**
 * Opens modal prefilled to edit an existing camera's configurations.
 */
window.openEditCameraForm = function(cameraJsonStr) {
  const cameraObj = JSON.parse(decodeURIComponent(cameraJsonStr));
  
  cameraModalTitle.textContent = `Edit Camera: ${cameraObj.name}`;
  camNameInput.value = cameraObj.name;
  camNameInput.readOnly = true; 
  
  camIpInput.value = cameraObj.ip;
  camPortInput.value = cameraObj.port;
  camUsernameInput.value = cameraObj.username;
  camPasswordInput.value = cameraObj.password || '';
  camEnabledInput.checked = cameraObj.enabled !== false;
  camCompressionInput.value = cameraObj.compression || 'copy';
  
  cameraModal.classList.add('active');
  lucide.createIcons();
};

/**
 * Closes the Camera config modal.
 */
window.closeCameraModal = function() {
  cameraModal.classList.remove('active');
};

/**
 * Sends POST requests to configure or add a camera.
 */
async function handleCameraFormSubmit(e) {
  e.preventDefault();
  
  const cameraObj = {
    name: camNameInput.value.trim(),
    ip: camIpInput.value.trim(),
    port: parseInt(camPortInput.value) || 80,
    username: camUsernameInput.value.trim(),
    password: camPasswordInput.value,
    enabled: camEnabledInput.checked,
    compression: camCompressionInput.value
  };

  try {
    const response = await fetch('/api/settings/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera: cameraObj })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to save camera settings');
    }

    closeCameraModal();
    await fetchSettings();
    await fetchStatus();
    
    alert(`Camera "${cameraObj.name}" successfully configured! Recorders reloaded.`);
  } catch (error) {
    console.error('Error saving camera settings:', error);
    alert(`Failed to save camera: ${error.message}`);
  }
}

/**
 * Triggers a DELETE request to remove a camera from settings.
 */
window.deleteCamera = async function(name) {
  if (!confirm(`Are you sure you want to delete camera "${name}"? This stops its recording sequence.`)) {
    return;
  }

  try {
    const response = await fetch(`/api/settings/cameras/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to delete camera');
    }

    await fetchSettings();
    await fetchStatus();
    
    alert(`Camera "${name}" successfully deleted!`);
  } catch (error) {
    console.error('Error deleting camera:', error);
    alert(`Failed to delete camera: ${error.message}`);
  }
};

/**
 * Sends POST requests to modify segment constraints in settings.
 */
async function handleGeneralSettingsSubmit(e) {
  e.preventDefault();
  
  const payload = {
    max_storage_gb: parseFloat(maxStorageInput.value),
    chunk_minutes: parseInt(chunkMinutesInput.value),
    auto_overwrite: autoOverwriteInput ? autoOverwriteInput.checked : true
  };

  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to update system settings');
    }

    await fetchSettings();
    await fetchStatus();
    
    alert('VMS general configurations successfully saved! Engine reloaded.');
  } catch (error) {
    console.error('Error saving settings:', error);
    alert(`Failed to update settings: ${error.message}`);
  }
}

/**
 * Triggers an ONVIF discovery network probe and renders replies.
 */
async function startNetworkScan() {
  discoverModal.classList.add('active');
  
  discoverResultsContainer.innerHTML = `
    <div class="loading-spinner-container" style="padding: 40px 0;">
      <div class="spinner"></div>
      <p style="font-weight: 500;">Broadcasting WS-Discovery probe scan on UDP 3702...</p>
      <p style="font-size:12px; color:var(--text-dim); margin-top:-8px;">This will take 4 seconds</p>
    </div>
  `;
  
  lucide.createIcons();

  try {
    const response = await fetch('/api/discover', { method: 'POST' });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Network discovery probe failed.');
    }

    const devices = await response.json();
    renderDiscoveredDevices(devices);
  } catch (error) {
    console.error('Discovery scan error:', error);
    discoverResultsContainer.innerHTML = `
      <div style="text-align: center; padding: 20px 0; color: var(--danger);">
        <i data-lucide="alert-triangle" style="width:40px; height:40px; margin-bottom:12px;"></i>
        <h4>Discovery Probe Failed</h4>
        <p style="font-size:13px; margin-top:4px;">${error.message}</p>
      </div>
    `;
    lucide.createIcons();
  }
}

/**
 * Renders discovered devices inside the Discovery Modal.
 */
function renderDiscoveredDevices(devices) {
  if (!devices || devices.length === 0) {
    discoverResultsContainer.innerHTML = `
      <div style="text-align: center; padding: 30px 0; color: var(--text-muted);">
        <i data-lucide="help-circle" style="width:36px; height:36px; margin-bottom:10px; color: var(--text-dim);"></i>
        <h4>No ONVIF Cameras Discovered</h4>
        <p style="font-size: 13px; line-height: 1.4; margin-top: 6px;">
          Make sure your cameras are turned on, connected to the same network, and have ONVIF/WS-Discovery enabled in their settings.
        </p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  discoverResultsContainer.innerHTML = `
    <div class="discovered-device-list">
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 6px;">
        Discovered ${devices.length} ONVIF-compliant camera(s) on your local subnet:
      </p>
      ${devices.map(dev => `
        <div class="discovered-device-item">
          <div class="discovered-info">
            <h4>IP Address: ${dev.ip}</h4>
            <p>ONVIF Port: ${dev.port} | Path: ${dev.path || 'None'}</p>
          </div>
          <button class="btn btn-primary btn-sm" onclick="addDiscoveredCamera('${dev.ip}', '${dev.port}')">
            <i data-lucide="plus" style="width:12px; height:12px;"></i> Add to VMS
          </button>
        </div>
      `).join('')}
    </div>
  `;
  
  lucide.createIcons();
}

/**
 * Pre-fills the Camera Add Form with a discovered camera's IP and port.
 */
window.addDiscoveredCamera = function(ip, port) {
  closeDiscoverModal();
  
  cameraModalTitle.textContent = 'Add Discovered Camera';
  camNameInput.value = '';
  camNameInput.readOnly = false;
  camIpInput.value = ip;
  camPortInput.value = port;
  camUsernameInput.value = 'admin';
  camPasswordInput.value = '';
  camEnabledInput.checked = true;
  camCompressionInput.value = 'copy';
  
  cameraModal.classList.add('active');
  lucide.createIcons();
};

/**
 * Closes the Discovery Modal.
 */
window.closeDiscoverModal = function() {
  discoverModal.classList.remove('active');
};

/**
 * Opens the Live Preview Modal and connects directly to the real-time 30-50 FPS stream.
 */
window.openLivePreviewModal = function(name) {
  livePreviewTitle.textContent = `${name} - Camera Live View`;
  livePreviewLoader.style.display = 'flex';
  livePreviewLoader.innerHTML = `
    <div class="spinner" style="margin-bottom:10px;"></div>
    <h4>Connecting...</h4>
    <p style="font-size: 12px; color:var(--text-dim); margin-top:4px;">Requesting real-time MJPEG stream feed at 30-50 FPS</p>
  `;
  livePreviewImg.style.display = 'none';
  
  // Set source directly to our real-time multipart stream router
  livePreviewImg.src = `/api/cameras/${encodeURIComponent(name)}/stream`;
  
  livePreviewImg.onload = () => {
    livePreviewLoader.style.display = 'none';
    livePreviewImg.style.display = 'block';
  };

  livePreviewImg.onerror = () => {
    livePreviewLoader.style.display = 'flex';
    livePreviewImg.style.display = 'none';
    livePreviewLoader.innerHTML = `
      <i data-lucide="video-off" style="width:40px; height:40px; color:var(--danger); margin-bottom:10px;"></i>
      <h4 style="color:var(--danger);">Live Stream Offline</h4>
      <p style="font-size: 12px; color:var(--text-dim); margin-top:4px;">Verify camera network, credentials, and ONVIF capabilities.</p>
    `;
    lucide.createIcons();
  };
  
  livePreviewModal.classList.add('active');
  lucide.createIcons();
};

/**
 * Closes the Live Preview Modal and terminates the backend streaming connection.
 */
window.closeLivePreviewModal = function() {
  livePreviewModal.classList.remove('active');
  // Setting source to empty string closes the TCP socket and kills the backend FFmpeg process instantly
  livePreviewImg.src = ''; 
};
