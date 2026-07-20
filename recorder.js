import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { getCameraRtspUri } from './onvif.js';
import path from 'path';
import fs from 'fs-extra';

// Tell fluent-ffmpeg to use the precompiled static binary
ffmpeg.setFfmpegPath(ffmpegStatic);

/**
 * CameraRecorder manages the lifecycle of a camera's recording process.
 */
export class CameraRecorder {
  /**
   * @param {Object} camera - The camera configuration object.
   * @param {Object} config - The system-wide configuration object.
   */
  constructor(camera, config) {
    this.camera = camera;
    this.config = config;
    this.ffmpegProcess = null;
    this.isStopping = false;
    this.reconnectTimeout = null;
  }

  /**
   * Starts the recording process.
   */
  async start() {
    this.isStopping = false;
    const { name } = this.camera;
    console.log(`[Recorder] [${name}] Starting recording sequence...`);

    // Fetch the RTSP URI via ONVIF
    const rtspUri = await getCameraRtspUri(this.camera);
    if (!rtspUri) {
      console.warn(`[Recorder] [${name}] Could not retrieve RTSP URI. Will retry in 30 seconds...`);
      this.scheduleReconnect();
      return;
    }

    // Run the FFmpeg recording command
    this.runFfmpeg(rtspUri);
  }

  /**
   * Spawns the FFmpeg process with the appropriate options.
   * @param {string} rtspUri - The authenticated RTSP URL.
   */
  runFfmpeg(rtspUri) {
    const { name, compression } = this.camera;
    const { storage_path, chunk_minutes } = this.config;
    const segmentTimeSec = chunk_minutes * 60;

    // Create a dedicated subfolder for the camera
    const cleanCameraDirName = name.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const cameraFolder = path.join(storage_path, cleanCameraDirName);
    fs.ensureDirSync(cameraFolder);

    // Output path pattern using strftime formatting inside the camera subfolder
    const outputPath = path.join(cameraFolder, `${name}_${compression}_%Y-%m-%d_%I%M%p.mp4`);

    console.log(`[Recorder] [${name}] Spawning FFmpeg process.`);
    console.log(`[Recorder] [${name}] Target output template: ${outputPath}`);

    const inputOptions = [];
    if (rtspUri.startsWith('rtsp://')) {
      inputOptions.push('-rtsp_transport', 'tcp');
      inputOptions.push('-timeout', '10000000'); // Timeout in microseconds (10s)
    }
    inputOptions.push('-analyzeduration', '5000000');
    inputOptions.push('-probesize', '5000000');

    // Define codec configurations based on chosen compression quality profile
    const codecOptions = [];
    if (compression === 'high') {
      console.log(`[Recorder] [${name}] Transcoding to H.264 [High Quality / CRF 20]`);
      codecOptions.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
    } else if (compression === 'medium') {
      console.log(`[Recorder] [${name}] Transcoding to H.264 [Medium Quality / CRF 28]`);
      codecOptions.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
    } else if (compression === 'low') {
      console.log(`[Recorder] [${name}] Transcoding to H.264 [Low Quality / CRF 35]`);
      codecOptions.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
    } else if (compression === 'hevc') {
      console.log(`[Recorder] [${name}] Transcoding to H.265/HEVC [Max Compression / CRF 28]`);
      codecOptions.push('-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
    } else {
      console.log(`[Recorder] [${name}] Using Original Stream Copy [Direct Copy / Low CPU]`);
      codecOptions.push('-c:v', 'copy', '-c:a', 'copy');
    }

    const outputOptionsList = [
      ...codecOptions,
      '-f', 'segment',             // Split the stream into chunks
      '-segment_time', `${segmentTimeSec}`, // Length of each chunk in seconds
      '-reset_timestamps', '1',    // Reset timestamp on every chunk to avoid playback issues
      '-strftime', '1',             // Enable strftime naming in output path
      '-segment_format_options', 'movflags=frag_keyframe+empty_moov+default_base_moof' // Enable crash-resilient fragmented MP4
    ];

    this.ffmpegProcess = ffmpeg(rtspUri)
      .inputOptions(inputOptions)
      .outputOptions(outputOptionsList)
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log(`[Recorder] [${name}] FFmpeg successfully spawned.`);
        // Note: commandLine contains the exact arguments passed to FFmpeg
      })
      .on('error', (err) => {
        if (this.isStopping) return;
        console.error(`[Recorder] [${name}] FFmpeg encountered an error: ${err.message}`);
        // error event is followed by exit, so let's trigger reconnection here or on exit.
        // We'll clean up and trigger reconnection to prevent duplicate triggers.
        this.cleanupProcess();
        this.scheduleReconnect();
      })
      .on('end', () => {
        if (this.isStopping) return;
        console.warn(`[Recorder] [${name}] FFmpeg process ended.`);
        this.cleanupProcess();
        this.scheduleReconnect();
      });

    this.ffmpegProcess.run();
  }

  /**
   * Schedules a reconnection attempt.
   */
  scheduleReconnect() {
    if (this.isStopping) return;
    if (this.reconnectTimeout) return; // Reconnection is already scheduled

    console.log(`[Recorder] [${this.camera.name}] Reconnection scheduled in 30 seconds.`);
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      await this.start();
    }, 30000);
  }

  /**
   * Cleans up the FFmpeg process reference.
   */
  cleanupProcess() {
    this.ffmpegProcess = null;
  }

  /**
   * Stops the recording process.
   */
  stop() {
    console.log(`[Recorder] [${this.camera.name}] Stopping recording...`);
    this.isStopping = true;
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ffmpegProcess) {
      try {
        this.ffmpegProcess.kill('SIGKILL');
      } catch (err) {
        console.error(`[Recorder] [${this.camera.name}] Error stopping FFmpeg process: ${err.message}`);
      }
      this.ffmpegProcess = null;
    }
  }
}
