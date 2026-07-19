import { Onvif } from '@2bad/onvif';

// Global cache to store resolved camera stream and snapshot URIs
const cameraCache = new Map();

/**
 * Injects credentials into a URI if they are not already present.
 * @param {string} uri - The original URI.
 * @param {string} username - The username.
 * @param {string} password - The password.
 * @returns {string} The authenticated URI.
 */
function injectCredentials(uri, username, password) {
  if (!username || !password) return uri;
  
  if (uri.startsWith('rtsp://')) {
    const pathIndex = uri.indexOf('/', 7);
    const hostPortion = pathIndex === -1 ? uri.substring(7) : uri.substring(7, pathIndex);
    if (!hostPortion.includes('@')) {
      const authString = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
      return `rtsp://${authString}${uri.substring(7)}`;
    }
  } else if (uri.startsWith('http://')) {
    const pathIndex = uri.indexOf('/', 7);
    const hostPortion = pathIndex === -1 ? uri.substring(7) : uri.substring(7, pathIndex);
    if (!hostPortion.includes('@')) {
      const authString = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
      return `http://${authString}${uri.substring(7)}`;
    }
  }
  return uri;
}

/**
 * Clears the in-memory resolved camera URIs cache.
 */
export function clearRtspCache() {
  cameraCache.clear();
  console.log('[ONVIF] In-memory camera URI cache cleared.');
}

/**
 * Fetches and caches both RTSP and HTTP snapshot URIs using ONVIF.
 * @param {Object} camera - The camera configuration object.
 * @returns {Promise<{rtspUri: string|null, snapshotUri: string|null}>} Resolved URIs.
 */
export async function getCameraUris(camera) {
  const { name, ip, port, username, password } = camera;
  const cacheKey = `${ip}:${port || 80}:${username}:${password}`;

  if (cameraCache.has(cacheKey)) {
    return cameraCache.get(cacheKey);
  }

  console.log(`[ONVIF] Connecting to camera "${name}" (${ip}:${port || 80})...`);

  try {
    const device = new Onvif({
      hostname: ip,
      port: port || 80,
      username: username,
      password: password
    });

    await device.connect();

    const profiles = await device.media.getProfiles();
    if (!profiles || profiles.length === 0) {
      console.warn(`[ONVIF] [Warning] Camera "${name}" (${ip}) returned no media profiles.`);
      return { rtspUri: null, snapshotUri: null };
    }

    const firstProfile = profiles[0];
    let profileToken = firstProfile.token || (firstProfile.$ && firstProfile.$.token);
    
    if (!profileToken) {
      console.warn(`[ONVIF] [Warning] Camera "${name}" (${ip}) profile token is empty.`);
      return { rtspUri: null, snapshotUri: null };
    }

    console.log(`[ONVIF] Camera "${name}" using profile token: ${profileToken}`);

    // 1. Fetch RTSP stream URI
    let rtspUri = null;
    try {
      const streamUriResult = await device.media.getStreamUri({
        protocol: 'RTSP',
        profileToken: profileToken
      });
      if (streamUriResult && streamUriResult.uri) {
        rtspUri = injectCredentials(streamUriResult.uri, username, password);
      }
    } catch (rtspErr) {
      console.warn(`[ONVIF] Camera "${name}" failed to return RTSP Stream URI:`, rtspErr.message);
    }

    // 2. Fetch HTTP snapshot URI
    let snapshotUri = null;
    try {
      const snapshotResult = await device.media.getSnapshotUri({ profileToken });
      if (snapshotResult && snapshotResult.uri) {
        snapshotUri = injectCredentials(snapshotResult.uri, username, password);
      }
    } catch (snapErr) {
      console.warn(`[ONVIF] Camera "${name}" does not support HTTP snapshot query natively:`, snapErr.message);
    }

    const uris = { rtspUri, snapshotUri };
    cameraCache.set(cacheKey, uris);
    console.log(`[ONVIF] Resolved URIs cached for camera "${name}" (${ip}). RTSP: ${!!rtspUri}, Snap: ${!!snapshotUri}`);
    return uris;
  } catch (error) {
    console.error(`[ONVIF] [Error] Failed to connect or query URIs for "${name}" (${ip}):`, error.message);
    return { rtspUri: null, snapshotUri: null };
  }
}

/**
 * Backward compatibility helper for legacy code.
 */
export async function getCameraRtspUri(camera) {
  const uris = await getCameraUris(camera);
  return uris.rtspUri;
}
