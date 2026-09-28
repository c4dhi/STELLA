/**
 * useFaceTracking Hook
 * Webcam face detection via @vladmandic/face-api.
 *
 * There is deliberately NO mouse fallback. A cursor is not a face: treating it
 * as one meant every desktop without webcam permission reported a permanent
 * detection, so the eyes tracked the pointer and the idle behavior could never
 * run. With no face detected the gaze re-centers and looks straight ahead, and
 * `useFaceBehavior` takes over with the idle look-around.
 *
 * `enableWebcam` is a live switch, not just a startup option (#face-sleep):
 * dropping it releases the camera outright — tracks stopped, indicator light
 * off — and raising it acquires a fresh stream. That is the whole point of the
 * sleep state, so the teardown has to be real rather than merely pausing
 * detection on a stream that is still open.
 */

import { useState, useEffect, useRef } from 'react';
import * as faceapi from '@vladmandic/face-api';
import type { UseFaceTrackingOptions, FaceTrackingData, FacePosition } from '../types';

const LERP_FACTOR = 0.25; // Smoothing factor (0 = no smoothing, 1 = instant)
const DETECTION_INTERVAL_MS = 100; // 10 FPS for face detection

export const useFaceTracking = ({
  enableWebcam = true,
  smoothingFactor = LERP_FACTOR
}: UseFaceTrackingOptions = {}) => {
  const [trackingData, setTrackingData] = useState<FaceTrackingData>({
    position: { x: 0.5, y: 0.5 }, // Normalized 0-1
    hasDetection: false,
    method: 'none'
  });

  const [isWebcamReady, setIsWebcamReady] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectionIntervalRef = useRef<number | null>(null);
  const smoothPositionRef = useRef<FacePosition>({ x: 0.5, y: 0.5 });

  // Load face-api models
  useEffect(() => {
    const loadModels = async () => {
      try {
        // Try to load from CDN first (faster), fallback to local if needed
        const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL)
        ]);

        console.log('[FaceTracking] ✅ Face detection models loaded');
        setModelsLoaded(true);
      } catch (error) {
        console.error('[FaceTracking] ❌ Failed to load models:', error);
        // Continue without webcam — the face just looks straight ahead and idles
        setModelsLoaded(false);
      }
    };

    loadModels();
  }, []);

  // Initialize webcam
  useEffect(() => {
    if (!enableWebcam || !modelsLoaded) return;

    const initWebcam = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: 'user'
          }
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
          streamRef.current = stream;
          setIsWebcamReady(true);
          console.log('[FaceTracking] ✅ Webcam initialized');
        }
      } catch (error) {
        console.warn('[FaceTracking] ⚠️ Webcam unavailable — face will look straight ahead and idle');
        setIsWebcamReady(false);
      }
    };

    initWebcam();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
        detectionIntervalRef.current = null;
      }
      // Without this the detection loop below — which is keyed on readiness,
      // not on the switch — keeps polling a video element whose stream has been
      // stopped, and every consumer goes on believing the camera is live.
      setIsWebcamReady(false);
    };
  }, [enableWebcam, modelsLoaded]);

  // Releasing the camera must also retract the last detection. Otherwise the
  // final frame before shutdown stands as the answer to "is anyone there" for
  // as long as the camera stays off, and the face would decide someone is
  // present the entire time it is asleep.
  useEffect(() => {
    if (enableWebcam) return;
    smoothPositionRef.current = { x: 0.5, y: 0.5 };
    setTrackingData({ position: { x: 0.5, y: 0.5 }, hasDetection: false, method: 'none' });
  }, [enableWebcam]);

  // Face detection loop
  useEffect(() => {
    if (!isWebcamReady || !videoRef.current) return;

    const detectFace = async () => {
      if (!videoRef.current) return;

      try {
        const detection = await faceapi
          .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions())
          .withFaceLandmarks(true);

        if (detection) {
          const video = videoRef.current;
          const box = detection.detection.box;

          // Calculate face center position (normalized 0-1)
          const centerX = (box.x + box.width / 2) / video.videoWidth;
          const centerY = (box.y + box.height / 2) / video.videoHeight;

          // Apply smoothing with LERP
          smoothPositionRef.current.x +=
            (centerX - smoothPositionRef.current.x) * smoothingFactor;
          smoothPositionRef.current.y +=
            (centerY - smoothPositionRef.current.y) * smoothingFactor;

          setTrackingData({
            position: { ...smoothPositionRef.current },
            hasDetection: true,
            method: 'webcam'
          });
        } else {
          // No face detected, gradually return to center
          smoothPositionRef.current.x += (0.5 - smoothPositionRef.current.x) * smoothingFactor;
          smoothPositionRef.current.y += (0.5 - smoothPositionRef.current.y) * smoothingFactor;

          setTrackingData({
            position: { ...smoothPositionRef.current },
            hasDetection: false,
            method: 'webcam'
          });
        }
      } catch (error) {
        console.error('[FaceTracking] Detection error:', error);
      }
    };

    detectionIntervalRef.current = window.setInterval(detectFace, DETECTION_INTERVAL_MS);

    return () => {
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
      }
    };
  }, [isWebcamReady, smoothingFactor]);

  // Create the hidden video element ONCE, for the lifetime of the hook.
  //
  // It deliberately does not depend on `enableWebcam`. React runs effects in
  // declaration order, so tearing the element down and rebuilding it on the
  // switch would have `initWebcam` above run first and attach the new stream to
  // the element that was just removed from the document.
  useEffect(() => {
    const video = document.createElement('video');
    video.width = 640;
    video.height = 480;
    video.autoplay = true;
    video.playsInline = true;
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';

    document.body.appendChild(video);
    videoRef.current = video;

    return () => {
      videoRef.current = null;
      document.body.removeChild(video);
    };
  }, []);

  return {
    trackingData,
    isWebcamActive: isWebcamReady && trackingData.method === 'webcam'
  };
};
