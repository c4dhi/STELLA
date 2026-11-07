import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  ChevronDown,
  AlertCircle,
  ArrowRight,
  Settings,
} from 'lucide-react';
import { useAudioLevel } from '../../hooks/useAudioLevel';
import {
  requestMicrophoneAccess,
  requestCameraAccess,
  getAudioInputDevices,
  getAudioOutputDevices,
  getVideoInputDevices,
  stopStream,
} from '../../lib/mediaDevices';
import {
  OnboardingLayout,
  OnboardingCard,
  StellaBranding,
  GradientButton,
} from '../onboarding';

interface PermissionsModalProps {
  isOpen: boolean;
  participantName: string;
  onComplete: () => void;
  /** The line under the title. Defaults to the join wording. */
  subtitle?: string;
  /** The main button. Defaults to "Join Session". */
  actionLabel?: string;
  /** Shows a quiet second button, e.g. to stay on the Text face. */
  cancelLabel?: string;
  onCancel?: () => void;
}

type PermissionStatus = 'pending' | 'granted' | 'denied';

export default function PermissionsModal({
  isOpen,
  participantName,
  onComplete,
  subtitle = 'Check your camera and microphone before joining',
  actionLabel = 'Join Session',
  cancelLabel,
  onCancel,
}: PermissionsModalProps) {
  // Permission states
  const [micStatus, setMicStatus] = useState<PermissionStatus>('pending');
  const [cameraStatus, setCameraStatus] = useState<PermissionStatus>('pending');

  // Media streams
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  // Toggle states (user preference)
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(false);

  // Device lists
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);

  // Selected devices
  const [selectedAudioInput, setSelectedAudioInput] = useState<string>('');
  const [selectedAudioOutput, setSelectedAudioOutput] = useState<string>('');
  const [selectedVideoInput, setSelectedVideoInput] = useState<string>('');

  // Video ref
  const videoRef = useRef<HTMLVideoElement>(null);

  // Audio level
  const audioLevel = useAudioLevel(micStream);

  // Load device lists
  const loadDevices = useCallback(async () => {
    const [inputs, outputs, videos] = await Promise.all([
      getAudioInputDevices(),
      getAudioOutputDevices(),
      getVideoInputDevices(),
    ]);
    setAudioInputs(inputs);
    setAudioOutputs(outputs);
    setVideoInputs(videos);

    // Set default selections
    if (inputs.length > 0 && !selectedAudioInput) {
      setSelectedAudioInput(inputs[0].deviceId);
    }
    if (outputs.length > 0 && !selectedAudioOutput) {
      setSelectedAudioOutput(outputs[0].deviceId);
    }
    if (videos.length > 0 && !selectedVideoInput) {
      setSelectedVideoInput(videos[0].deviceId);
    }
  }, [selectedAudioInput, selectedAudioOutput, selectedVideoInput]);

  // Request microphone
  const requestMic = useCallback(
    async (deviceId?: string) => {
      // Stop existing stream
      if (micStream) {
        stopStream(micStream);
        setMicStream(null);
      }

      const stream = await requestMicrophoneAccess(deviceId);
      if (stream) {
        setMicStream(stream);
        setMicStatus('granted');
        setMicEnabled(true);
        // Reload devices now that we have permission
        await loadDevices();
      } else {
        setMicStatus('denied');
        setMicEnabled(false);
      }
    },
    [micStream, loadDevices],
  );

  // Request camera
  const requestCamera = useCallback(
    async (deviceId?: string) => {
      // Stop existing stream
      if (cameraStream) {
        stopStream(cameraStream);
        setCameraStream(null);
      }

      const stream = await requestCameraAccess(deviceId);
      if (stream) {
        setCameraStream(stream);
        setCameraStatus('granted');
        setCameraEnabled(true);
        // Reload devices now that we have permission
        await loadDevices();
      } else {
        setCameraStatus('denied');
        setCameraEnabled(false);
      }
    },
    [cameraStream, loadDevices],
  );

  // Toggle mic
  const toggleMic = useCallback(async () => {
    if (micStatus === 'pending' || (micStatus === 'denied' && !micStream)) {
      await requestMic(selectedAudioInput || undefined);
    } else if (micStream) {
      if (micEnabled) {
        // Disable mic (mute but keep stream)
        micStream.getAudioTracks().forEach((track) => (track.enabled = false));
        setMicEnabled(false);
      } else {
        // Enable mic
        micStream.getAudioTracks().forEach((track) => (track.enabled = true));
        setMicEnabled(true);
      }
    }
  }, [micStatus, micStream, micEnabled, requestMic, selectedAudioInput]);

  // Toggle camera
  const toggleCamera = useCallback(async () => {
    if (
      cameraStatus === 'pending' ||
      (cameraStatus === 'denied' && !cameraStream)
    ) {
      await requestCamera(selectedVideoInput || undefined);
    } else if (cameraStream) {
      if (cameraEnabled) {
        // Stop camera completely
        stopStream(cameraStream);
        setCameraStream(null);
        setCameraEnabled(false);
      } else {
        // Re-enable camera
        await requestCamera(selectedVideoInput || undefined);
      }
    } else {
      // No stream but granted - request new stream
      await requestCamera(selectedVideoInput || undefined);
    }
  }, [
    cameraStatus,
    cameraStream,
    cameraEnabled,
    requestCamera,
    selectedVideoInput,
  ]);

  // Handle device selection changes
  const handleAudioInputChange = useCallback(
    async (deviceId: string) => {
      setSelectedAudioInput(deviceId);
      if (micStatus === 'granted') {
        await requestMic(deviceId);
      }
    },
    [micStatus, requestMic],
  );

  const handleVideoInputChange = useCallback(
    async (deviceId: string) => {
      setSelectedVideoInput(deviceId);
      if (cameraStatus === 'granted' && cameraEnabled) {
        await requestCamera(deviceId);
      }
    },
    [cameraStatus, cameraEnabled, requestCamera],
  );

  // Attach camera to video element
  useEffect(() => {
    if (videoRef.current && cameraStream) {
      videoRef.current.srcObject = cameraStream;
    }
  }, [cameraStream]);

  // Initial mic request and device loading
  useEffect(() => {
    if (isOpen) {
      // Request mic immediately when modal opens
      requestMic();
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for device changes
  useEffect(() => {
    if (!isOpen) return;

    const handleDeviceChange = () => {
      loadDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener(
        'devicechange',
        handleDeviceChange,
      );
    };
  }, [isOpen, loadDevices]);

  // Cleanup streams on unmount
  useEffect(() => {
    return () => {
      stopStream(micStream);
      stopStream(cameraStream);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle join
  const handleJoin = useCallback(() => {
    // Stop preview streams before joining
    stopStream(micStream);
    stopStream(cameraStream);
    onComplete();
  }, [micStream, cameraStream, onComplete]);

  const canJoin = micStatus === 'granted';

  if (!isOpen) return null;

  return (
    <OnboardingLayout>
      <div className="max-w-lg w-full">
        {/* STELLA Branding */}
        <StellaBranding />

        {/* Permissions Card */}
        <OnboardingCard
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          contentClassName="p-6"
        >
          {/* Header */}
          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-full bg-primary-100 dark:bg-primary-500/10 flex items-center justify-center mx-auto mb-4">
              <Settings className="w-6 h-6 text-primary-600 dark:text-primary-400" />
            </div>
            <h2 className="text-xl font-medium text-content dark:text-content-inverse mb-2">
              Set Up Your Devices
            </h2>
            <p className="text-content-secondary dark:text-content-inverse-secondary text-sm">
              {subtitle}
            </p>
          </div>

          {/* Video Preview Area */}
          <div className="relative bg-neutral-100 dark:bg-neutral-900 rounded-xl overflow-hidden aspect-video mb-6">
            {/* Participant name badge */}
            <div className="absolute top-3 left-3 z-10">
              <span className="px-3 py-1.5 bg-black/60 backdrop-blur-sm rounded-full text-white text-xs font-medium">
                {participantName}
              </span>
            </div>

            {/* Video feed or placeholder */}
            {cameraStream && cameraEnabled ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover transform scale-x-[-1]"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <div className="text-center">
                  <VideoOff className="w-12 h-12 text-neutral-400 dark:text-neutral-600 mx-auto mb-2" />
                  <p className="text-neutral-500 dark:text-neutral-500 text-sm">
                    Camera is off
                  </p>
                </div>
              </div>
            )}

            {/* Control buttons at bottom */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3">
              {/* Mic button */}
              <button
                onClick={toggleMic}
                className={`
                  relative w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200
                  ${
                    micEnabled && micStatus === 'granted'
                      ? 'bg-neutral-800/80 hover:bg-neutral-700/80 text-white'
                      : 'bg-red-500 hover:bg-red-600 text-white'
                  }
                `}
              >
                {micEnabled && micStatus === 'granted' ? (
                  <Mic className="w-5 h-5" />
                ) : (
                  <MicOff className="w-5 h-5" />
                )}
                {/* Audio level ring */}
                {micEnabled && micStatus === 'granted' && audioLevel > 5 && (
                  <div
                    className="absolute inset-0 rounded-full border-2 border-green-400 animate-pulse"
                    style={{
                      transform: `scale(${1 + audioLevel / 200})`,
                      opacity: Math.min(0.8, audioLevel / 50),
                    }}
                  />
                )}
              </button>

              {/* Camera button */}
              <button
                onClick={toggleCamera}
                className={`
                  w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200
                  ${
                    cameraEnabled && cameraStatus === 'granted'
                      ? 'bg-neutral-800/80 hover:bg-neutral-700/80 text-white'
                      : 'bg-red-500 hover:bg-red-600 text-white'
                  }
                `}
              >
                {cameraEnabled && cameraStatus === 'granted' ? (
                  <Video className="w-5 h-5" />
                ) : (
                  <VideoOff className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>

          {/* Audio Level Bar */}
          {micEnabled && micStatus === 'granted' && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-2">
                <Mic className="w-4 h-4 text-content-tertiary dark:text-content-inverse-tertiary" />
                <span className="text-content-tertiary dark:text-content-inverse-tertiary text-xs">
                  Audio Level
                </span>
              </div>
              <div className="h-2 bg-surface-tertiary dark:bg-surface-dark-tertiary rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 rounded-full"
                  style={{ width: `${audioLevel}%` }}
                  transition={{ duration: 0.05 }}
                />
              </div>
            </div>
          )}

          {/* Device Selectors */}
          <div className="space-y-3 mb-6">
            {/* Microphone selector */}
            <DeviceSelector
              icon={<Mic className="w-4 h-4" />}
              label="Microphone"
              devices={audioInputs}
              selectedDevice={selectedAudioInput}
              onChange={handleAudioInputChange}
              disabled={micStatus !== 'granted'}
            />

            {/* Speaker selector */}
            <DeviceSelector
              icon={<span className="text-sm">🔊</span>}
              label="Speaker"
              devices={audioOutputs}
              selectedDevice={selectedAudioOutput}
              onChange={setSelectedAudioOutput}
              disabled={audioOutputs.length === 0}
            />

            {/* Camera selector */}
            <DeviceSelector
              icon={<Video className="w-4 h-4" />}
              label="Camera"
              devices={videoInputs}
              selectedDevice={selectedVideoInput}
              onChange={handleVideoInputChange}
              disabled={cameraStatus !== 'granted'}
            />
          </div>

          {/* Warning if mic not granted */}
          {micStatus !== 'granted' && (
            <div className="flex items-start gap-3 p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg mb-6">
              <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-amber-800 dark:text-amber-200 text-sm font-medium">
                  Microphone access required
                </p>
                <p className="text-amber-700 dark:text-amber-200/70 text-xs mt-0.5">
                  {micStatus === 'denied'
                    ? 'Please allow microphone access in your browser settings and refresh the page.'
                    : 'Click the microphone button above to enable your microphone.'}
                </p>
              </div>
            </div>
          )}

          {/* Join Button */}
          <GradientButton onClick={handleJoin} disabled={!canJoin}>
            <span>{actionLabel}</span>
            <ArrowRight
              className={`w-4 h-4 transition-transform ${canJoin ? 'group-hover:translate-x-1' : ''}`}
            />
          </GradientButton>
          {onCancel && (
            <button
              type="button"
              onClick={() => {
                stopStream(micStream);
                stopStream(cameraStream);
                onCancel();
              }}
              className="mt-3 w-full py-2 text-sm text-content-secondary dark:text-content-inverse-secondary hover:text-content dark:hover:text-content-inverse transition-colors"
            >
              {cancelLabel ?? 'Cancel'}
            </button>
          )}
        </OnboardingCard>
      </div>
    </OnboardingLayout>
  );
}

// Device Selector Component
interface DeviceSelectorProps {
  icon: React.ReactNode;
  label: string;
  devices: MediaDeviceInfo[];
  selectedDevice: string;
  onChange: (deviceId: string) => void;
  disabled?: boolean;
}

function DeviceSelector({
  icon,
  label,
  devices,
  selectedDevice,
  onChange,
  disabled,
}: DeviceSelectorProps) {
  return (
    <div className={`flex items-center gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <div className="w-8 h-8 rounded-lg bg-surface-secondary dark:bg-surface-dark-tertiary flex items-center justify-center text-content-tertiary dark:text-content-inverse-tertiary">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <label className="text-content-tertiary dark:text-content-inverse-tertiary text-xs block mb-1">
          {label}
        </label>
        <div className="relative">
          <select
            value={selectedDevice}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled || devices.length === 0}
            className="
              w-full appearance-none
              bg-white dark:bg-surface-dark-secondary
              border border-border dark:border-border-dark
              rounded-lg
              px-3 py-2 pr-8
              text-sm text-content dark:text-content-inverse
              focus:outline-none focus:border-neutral-900 dark:focus:border-primary-400
              disabled:cursor-not-allowed disabled:opacity-50
            "
          >
            {devices.length === 0 ? (
              <option value="">No devices found</option>
            ) : (
              devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Device ${device.deviceId.slice(0, 8)}`}
                </option>
              ))
            )}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-content-tertiary dark:text-content-inverse-tertiary pointer-events-none" />
        </div>
      </div>
    </div>
  );
}
