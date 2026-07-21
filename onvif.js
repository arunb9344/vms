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

    // Support explicit user-configured Custom Substream RTSP URL if defined
    let customSubstream = camera.custom_substream_url || camera.substream_rtsp_uri;
    if (customSubstream && customSubstream.trim()) {
      let injectedSub = injectCredentials(customSubstream.trim(), username, password);
      console.log(`[ONVIF] Camera "${name}" using custom Substream RTSP URI.`);
      const firstProfile = profiles[0];
      let profileToken = firstProfile.token || (firstProfile.$ && firstProfile.$.token);
      let rtspUri = null;
      try {
        const res = await device.media.getStreamUri({ protocol: 'RTSP', profileToken });
        if (res && res.uri) rtspUri = injectCredentials(res.uri, username, password);
      } catch(e) {}
      let snapshotUri = null;
      try {
        const snapRes = await device.media.getSnapshotUri({ profileToken });
        if (snapRes && snapRes.uri) snapshotUri = injectCredentials(snapRes.uri, username, password);
      } catch(e) {}

      const uris = { rtspUri, substreamRtspUri: injectedSub, snapshotUri };
      cameraCache.set(cacheKey, uris);
      return uris;
    }

    // Sort ONVIF profiles: highest resolution = Mainstream, lower resolution = Substream
    let mainProfile = profiles[0];
    let subProfile = profiles.length > 1 ? profiles[1] : null;

    if (profiles.length > 1) {
      profiles.sort((a, b) => {
        const getRes = p => {
          if (p.videoEncoderConfiguration && p.videoEncoderConfiguration.resolution) {
            const r = p.videoEncoderConfiguration.resolution;
            return (parseInt(r.width) || 0) * (parseInt(r.height) || 0);
          }
          return 0;
        };
        return getRes(b) - getRes(a);
      });
      mainProfile = profiles[0];
      subProfile = profiles[1];
    }

    let mainToken = mainProfile.token || (mainProfile.$ && mainProfile.$.token);
    let subToken = subProfile ? (subProfile.token || (subProfile.$ && subProfile.$.token)) : null;

    if (!mainToken) {
      console.warn(`[ONVIF] [Warning] Camera "${name}" (${ip}) profile token is empty.`);
      return { rtspUri: null, substreamRtspUri: null, snapshotUri: null };
    }

    console.log(`[ONVIF] Camera "${name}" Mainstream profile: ${mainToken}, Substream profile: ${subToken || 'None'}`);

    // 1. Fetch Mainstream RTSP URI
    let rtspUri = null;
    try {
      const streamUriResult = await device.media.getStreamUri({
        protocol: 'RTSP',
        profileToken: mainToken
      });
      if (streamUriResult && streamUriResult.uri) {
        rtspUri = injectCredentials(streamUriResult.uri, username, password);
      }
    } catch (rtspErr) {
      console.warn(`[ONVIF] Camera "${name}" failed to return Mainstream RTSP URI:`, rtspErr.message);
    }

    // 2. Fetch Substream RTSP URI
    let substreamRtspUri = null;
    if (subToken) {
      try {
        const subResult = await device.media.getStreamUri({
          protocol: 'RTSP',
          profileToken: subToken
        });
        if (subResult && subResult.uri) {
          substreamRtspUri = injectCredentials(subResult.uri, username, password);
        }
      } catch (subErr) {
        console.warn(`[ONVIF] Camera "${name}" sub-profile query notice:`, subErr.message);
      }
    }

    // Ensure rtspUri is TRUE Mainstream and substreamRtspUri is TRUE Substream
    const authString = (username && password) ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    const dahuaMainCandidate = `rtsp://${authString}${ip}:554/cam/realmonitor?channel=1&subtype=0`;
    const dahuaSubCandidate  = `rtsp://${authString}${ip}:554/cam/realmonitor?channel=1&subtype=1`;

    if (rtspUri) {
      if (rtspUri.includes('subtype=1')) {
        let mainRtsp = rtspUri.replace('subtype=1', 'subtype=0');
        if (!substreamRtspUri) substreamRtspUri = rtspUri;
        rtspUri = mainRtsp;
      } else if (rtspUri.includes('/102')) {
        let mainRtsp = rtspUri.replace('/102', '/101');
        if (!substreamRtspUri) substreamRtspUri = rtspUri;
        rtspUri = mainRtsp;
      } else if (rtspUri.includes('/sub')) {
        let mainRtsp = rtspUri.replace('/sub', '/main');
        if (!substreamRtspUri) substreamRtspUri = rtspUri;
        rtspUri = mainRtsp;
      } else if (rtspUri.includes('stream=1')) {
        let mainRtsp = rtspUri.replace('stream=1', 'stream=0');
        if (!substreamRtspUri) substreamRtspUri = rtspUri;
        rtspUri = mainRtsp;
      }
    } else {
      rtspUri = dahuaMainCandidate;
      substreamRtspUri = dahuaSubCandidate;
    }

    // Ensure substreamRtspUri is correctly constructed if missing or identical to rtspUri
    if (rtspUri && (!substreamRtspUri || substreamRtspUri === rtspUri)) {
      if (rtspUri.includes('subtype=0')) {
        substreamRtspUri = rtspUri.replace('subtype=0', 'subtype=1');
      } else if (rtspUri.includes('/101')) {
        substreamRtspUri = rtspUri.replace('/101', '/102');
      } else if (rtspUri.includes('/main')) {
        substreamRtspUri = rtspUri.replace('/main', '/sub');
      } else if (rtspUri.includes('stream=0')) {
        substreamRtspUri = rtspUri.replace('stream=0', 'stream=1');
      } else {
        substreamRtspUri = dahuaSubCandidate;
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
