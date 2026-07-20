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
      return { rtspUri: null, substreamRtspUri: null, snapshotUri: null };
    }

    console.log(`[ONVIF] Camera "${name}" Mainstream profile token: ${profileToken}`);

    // 1. Fetch Mainstream RTSP URI
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
      console.warn(`[ONVIF] Camera "${name}" failed to return Mainstream RTSP URI:`, rtspErr.message);
    }

    // 2. Fetch Substream RTSP URI (Profile 2 or pattern fallback)
    let substreamRtspUri = null;
    let subProfile = profiles.length > 1 ? profiles[1] : null;
    if (subProfile) {
      let subToken = subProfile.token || (subProfile.$ && subProfile.$.token);
      if (subToken) {
        try {
          const subResult = await device.media.getStreamUri({
            protocol: 'RTSP',
            profileToken: subToken
          });
          if (subResult && subResult.uri) {
            substreamRtspUri = injectCredentials(subResult.uri, username, password);
            console.log(`[ONVIF] Camera "${name}" Substream profile token: ${subToken}`);
          }
        } catch (subErr) {
          console.warn(`[ONVIF] Camera "${name}" sub-profile query notice:`, subErr.message);
        }
      }
    }

    // Pattern fallback for Substream if camera uses standard Hikvision / Dahua / CP PLUS URL formats
    if (!substreamRtspUri && rtspUri) {
      if (rtspUri.includes('subtype=0')) {
        substreamRtspUri = rtspUri.replace('subtype=0', 'subtype=1');
      } else if (rtspUri.includes('/101')) {
        substreamRtspUri = rtspUri.replace('/101', '/102');
      } else if (rtspUri.includes('/main')) {
        substreamRtspUri = rtspUri.replace('/main', '/sub');
      } else if (rtspUri.includes('stream=0')) {
        substreamRtspUri = rtspUri.replace('stream=0', 'stream=1');
      } else {
        substreamRtspUri = rtspUri;
      }
    }

    // 3. Fetch HTTP snapshot URI
    let snapshotUri = null;
    try {
      const snapshotResult = await device.media.getSnapshotUri({ profileToken });
      if (snapshotResult && snapshotResult.uri) {
        snapshotUri = injectCredentials(snapshotResult.uri, username, password);
      }
    } catch (snapErr) {
      console.warn(`[ONVIF] Camera "${name}" does not support HTTP snapshot query natively:`, snapErr.message);
    }

    const uris = { rtspUri, substreamRtspUri, snapshotUri };
    cameraCache.set(cacheKey, uris);
    console.log(`[ONVIF] Resolved URIs cached for camera "${name}" (${ip}). Main RTSP: ${!!rtspUri}, Sub RTSP: ${!!substreamRtspUri}, Snap: ${!!snapshotUri}`);
    return uris;
  } catch (error) {
    console.error(`[ONVIF] [Error] Failed to connect or query URIs for "${name}" (${ip}):`, error.message);
    return { rtspUri: null, substreamRtspUri: null, snapshotUri: null };
  }
}

/**
 * Backward compatibility helper for legacy code.
 */
export async function getCameraRtspUri(camera) {
  const uris = await getCameraUris(camera);
  return uris.rtspUri;
}
