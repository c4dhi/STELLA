/**
 * useFaceTracking Hook
 * Webcam face detection via @vladmandic/face-api.
 *
 * There is deliberately NO mouse fallback. A cursor is not a face: treating it
 * as one meant every desktop without webcam permission reported a permanent
 * detection, so the eyes tracked the pointer and the idle behavior could never
 * run. With no face detected the gaze re-centers and looks straight ahead, and
 * `useFaceBehavior` takes over with the idle look-around.
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
      // Cleanup webcam stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
      }
    };
  }, [enableWebcam, modelsLoaded]);

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

  // Create hidden video element for webcam
  useEffect(() => {
    if (!enableWebcam) return;

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
      document.body.removeChild(video);
    };
  }, [enableWebcam]);

  return {
    trackingData,
    isWebcamActive: isWebcamReady && trackingData.method === 'webcam'
  };
};
