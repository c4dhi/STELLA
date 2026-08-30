/**
 * STELLA Face Modal
 * Full-screen overlay with multiple visualizer options
 */

import React, { useEffect, useCallback, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, LayoutGrid, Maximize2, Minimize2, Subtitles } from 'lucide-react';
import TranscriptOverlay from './TranscriptOverlay';
import VisualizerGallery from './VisualizerGallery';
import VisualizerRenderer from './VisualizerRenderer';
import { useSleepMicrophone } from './hooks/useSleepMicrophone';
import { VisualizerType } from './types';
import { useStore } from '../../store';
import { startMicWithVu } from '../../services/audio/capture';

interface StellaFaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  isUserSpeaking?: boolean;
}

const StellaFaceModal: React.FC<StellaFaceModalProps> = ({
  isOpen,
  onClose,
  isUserSpeaking = false
}) => {
  // Audio level + remote-speaking are subscribed here (the only consumer) rather than in
  // the parent SessionView, so high-frequency audio updates re-render just this modal and
  // not the whole page. They only tick while the modal is open (see the gate effect below).
  // See ticket #305.
  const audioLevel = useStore(s => s.audioLevel);
  const isRemoteSpeaking = useStore(s => s.isRemoteSpeaking);

  // Store state for mute button
  const status = useStore(s => s.status);
  const transport = useStore(s => s.transport);
  const isMuted = useStore(s => s.isMuted);
  const isRecording = useStore(s => s.isRecording);
  const setIsMuted = useStore(s => s.setIsMuted);
  const setIsRecording = useStore(s => s.setIsRecording);

  // Store state for user transcript (partial only - for real-time display)
  const userPartialTranscript = useStore(s =>
    s.turns.find(t => t.role === 'user' && t.status === 'partial')?.text || ''
  );

  // Visualizer state
  const [currentVisualizer, setCurrentVisualizer] = useState<VisualizerType>('face');
  const [isGalleryOpen, setIsGalleryOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);

  // Control visibility state (fade after inactivity)
  const [showControls, setShowControls] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for audio management and modal container
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  // Handle mouse movement to show/hide controls
  useEffect(() => {
    if (!isOpen) return;

    const handleMouseMove = () => {
      setShowControls(true);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
      // Don't auto-hide controls if muted or gallery is open
      if (!isMuted && !isGalleryOpen) {
        hideTimerRef.current = setTimeout(() => {
          setShowControls(false);
        }, 3000);
      }
    };

    // Initial setup
    handleMouseMove();

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mousedown', handleMouseMove);
    window.addEventListener('touchstart', handleMouseMove);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleMouseMove);
      window.removeEventListener('touchstart', handleMouseMove);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [isOpen, isGalleryOpen, isMuted]);

  // Keep controls visible when gallery is open or muted
  useEffect(() => {
    if (isGalleryOpen || isMuted) {
      setShowControls(true);
      // Clear any pending hide timer
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    }
  }, [isGalleryOpen, isMuted]);

  // Drive the audio-level analysis loop only while the modal is open. Nothing else
  // consumes the level, so when closed the loop is fully stopped (no 30/60 fps RMS work,
  // no store writes). Opening the modal is also a user interaction, so the transport can
  // resume the AudioContext at the same time. See ticket #305.
  useEffect(() => {
    if (!transport) return;
    transport.setAudioAnalysisActive(isOpen);
    return () => {
      transport.setAudioAnalysisActive(false);
    };
  }, [isOpen, transport]);

  // Fullscreen toggle function
  const toggleFullscreen = useCallback(async () => {
    if (!modalRef.current) return;

    try {
      if (!document.fullscreenElement) {
        await modalRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (error) {
      console.error('Fullscreen error:', error);
    }
  }, []);

  // Listen for fullscreen changes (user pressing ESC in fullscreen, etc.)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        if (isGalleryOpen) {
          setIsGalleryOpen(false);
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, isGalleryOpen, onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Toggle mute function (synced with Composer)
  const toggleMute = useCallback(async () => {
    if (!transport || status !== 'connected') return;

    if (isMuted) {
      // Unmute - start streaming audio
      try {
        // Clean up any existing stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }

        let audioContext = audioContextRef.current;
        if (!audioContext) {
          audioContext = new AudioContext();
          audioContextRef.current = audioContext;
        }

        // Get microphone stream with VU meter
        const stream = await startMicWithVu(audioContext, transport as any);
        streamRef.current = stream;

        // Publish audio track to LiveKit
        await transport.publishAudioTrack(stream);

        setIsMuted(false);
        setIsRecording(true);
      } catch (error) {
        console.error('Error starting audio streaming:', error);
        setIsMuted(true);
        setIsRecording(false);
      }
    } else {
      // Mute - stop streaming audio
      await transport.unpublishAudioTrack();

      // Stop and clean up stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }

      setIsMuted(true);
      setIsRecording(false);
      useStore.getState().setVu(0); // Reset VU meter
    }
  }, [isMuted, transport, status, setIsMuted, setIsRecording]);

  // Sleeping mutes the mic; waking gives it back if sleep is what took it.
  useSleepMicrophone({ isMuted, toggleMute, enabled: status === 'connected' });

  // Handle spacebar to toggle mute
  useEffect(() => {
    const handleSpacebar = (event: KeyboardEvent) => {
      if (!isOpen) return;

      // Space key - toggle mute (prevent default to avoid scrolling)
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        toggleMute();
      }
    };

    document.addEventListener('keydown', handleSpacebar);

    return () => {
      document.removeEventListener('keydown', handleSpacebar);
    };
  }, [isOpen, toggleMute]);

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      const cleanup = async () => {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }

        if (transport) {
          await transport.unpublishAudioTrack();
        }

        if (audioContextRef.current) {
          audioContextRef.current.close();
          audioContextRef.current = null;
        }
        useStore.getState().setVu(0);
      };

      cleanup();
    };
  }, [transport]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={modalRef}
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: currentVisualizer === 'face' ? '#000000' : undefined }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* Visualizer */}
          <div className="absolute inset-0 flex items-center justify-center">
            <VisualizerRenderer
              type={currentVisualizer}
              audioLevel={audioLevel}
              isRemoteSpeaking={isRemoteSpeaking}
              isUserSpeaking={isUserSpeaking}
            />
          </div>

          {/* Top-right control buttons (fade on inactivity, hidden when gallery is open) */}
          <motion.div
            className={`absolute top-6 right-6 flex gap-3 z-50 transition-opacity duration-300 ${
              showControls && !isGalleryOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            {/* Mute Button */}
            <motion.button
              onClick={toggleMute}
              disabled={status !== 'connected'}
              className={`p-3 rounded-full backdrop-blur-sm border transition-all duration-300 hover:scale-110 ${
                status !== 'connected'
                  ? 'bg-white/10 border-white/20 text-white/40 cursor-not-allowed'
                  : isMuted
                    ? 'bg-red-500/20 border-red-400/40 text-red-400'
                    : 'bg-green-500/20 border-green-400/40 text-green-400'
              }`}
              title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
            >
              <motion.div
                animate={isRecording ? { scale: [1, 1.1, 1] } : { scale: 1 }}
                transition={{ duration: 1, repeat: isRecording ? Infinity : 0 }}
              >
                {isMuted ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28C16.28 17.23 19 14.41 19 11h-1.7z" />
                  </svg>
                )}
              </motion.div>
            </motion.button>

            {/* Subtitles Toggle Button */}
            <motion.button
              className={`p-3 rounded-full backdrop-blur-sm border transition-all duration-300 hover:scale-110 ${
                showSubtitles
                  ? 'bg-white/20 border-white/30 text-white'
                  : 'bg-white/10 border-white/20 text-white/40'
              }`}
              onClick={() => setShowSubtitles(!showSubtitles)}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              title={showSubtitles ? 'Hide Subtitles' : 'Show Subtitles'}
            >
              <Subtitles className={`w-5 h-5 ${!showSubtitles ? 'opacity-50' : ''}`} />
            </motion.button>

            {/* Gallery Button */}
            <motion.button
              className="p-3 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white transition-all duration-300 hover:bg-white/20 hover:scale-110"
              onClick={() => setIsGalleryOpen(true)}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              title="Visualizer Gallery"
            >
              <LayoutGrid className="w-5 h-5" />
            </motion.button>

            {/* Fullscreen Button */}
            <motion.button
              className="p-3 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white transition-all duration-300 hover:bg-white/20 hover:scale-110"
              onClick={toggleFullscreen}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <Minimize2 className="w-5 h-5" />
              ) : (
                <Maximize2 className="w-5 h-5" />
              )}
            </motion.button>

            {/* Close Button */}
            <motion.button
              className="p-3 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white transition-all duration-300 hover:bg-white/20 hover:scale-110"
              onClick={onClose}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              title="Close"
            >
              <X className="w-5 h-5" />
            </motion.button>
          </motion.div>

          {/* Visualizer Gallery Panel */}
          <VisualizerGallery
            isOpen={isGalleryOpen}
            onClose={() => setIsGalleryOpen(false)}
            currentVisualizer={currentVisualizer}
            onSelect={setCurrentVisualizer}
          />

          {/* Transcript Overlay (works with all themes) */}
          <TranscriptOverlay
            transcript={userPartialTranscript}
            theme={currentVisualizer}
            isVisible={showSubtitles}
          />

          {/* Bottom-right ESC hint (also fade on inactivity, hidden when gallery is open) */}
          <motion.div
            className={`absolute bottom-4 right-6 z-40 transition-opacity duration-300 ${
              showControls && !isGalleryOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            <div className="text-white/40 text-sm">
              Press ESC to close
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default StellaFaceModal;
