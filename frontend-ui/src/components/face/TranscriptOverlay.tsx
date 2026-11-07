/**
 * TranscriptOverlay Component
 * Decoupled transcript display that works with all visualizer themes.
 * Shows real-time partial transcription of user speech only.
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { VisualizerType } from './types';

// Theme-specific styling configurations
export interface TranscriptThemeConfig {
  background: string;
  border: string;
  textColor: string;
  blur: string;
}

// Pre-defined theme configurations
const THEME_CONFIGS: Record<VisualizerType, TranscriptThemeConfig> = {
  text: {
    background: 'bg-black/40',
    border: 'border-white/10',
    textColor: 'text-white/90',
    blur: 'backdrop-blur-md',
  },
  face: {
    background: 'bg-black/40',
    border: 'border-white/10',
    textColor: 'text-white/90',
    blur: 'backdrop-blur-md',
  },
  sphere: {
    background: 'bg-slate-900/50',
    border: 'border-violet-500/20',
    textColor: 'text-white/90',
    blur: 'backdrop-blur-md',
  },
  galaxy: {
    background: 'bg-indigo-950/50',
    border: 'border-purple-500/20',
    textColor: 'text-white/90',
    blur: 'backdrop-blur-md',
  },
  rainy: {
    background: 'bg-slate-800/60',
    border: 'border-slate-500/20',
    textColor: 'text-slate-100/90',
    blur: 'backdrop-blur-md',
  },
  snowy: {
    background: 'bg-white/30',
    border: 'border-slate-300/30',
    textColor: 'text-slate-800/90',
    blur: 'backdrop-blur-md',
  },
  christmas: {
    background: 'bg-slate-900/50',
    border: 'border-yellow-500/20',
    textColor: 'text-white/90',
    blur: 'backdrop-blur-md',
  },
  sunny: {
    background: 'bg-sky-900/30',
    border: 'border-sky-400/20',
    textColor: 'text-white/95',
    blur: 'backdrop-blur-md',
  },
};

interface TranscriptOverlayProps {
  // User transcript content (partial speech)
  transcript?: string;
  // Theme for styling
  theme?: VisualizerType;
  // Custom theme config (overrides preset)
  customTheme?: Partial<TranscriptThemeConfig>;
  // Position from bottom (default: bottom-24)
  bottomOffset?: string;
  // Visibility toggle
  isVisible?: boolean;
}

const TranscriptOverlay: React.FC<TranscriptOverlayProps> = ({
  transcript,
  theme = 'face',
  customTheme,
  bottomOffset = 'bottom-24',
  isVisible = true,
}) => {
  // Get theme config with optional overrides
  const themeConfig: TranscriptThemeConfig = {
    ...THEME_CONFIGS[theme],
    ...customTheme,
  };

  const hasTranscript = Boolean(transcript?.trim());
  const shouldShow = isVisible && hasTranscript;

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          className={`absolute ${bottomOffset} left-0 right-0 z-30 flex justify-center px-4`}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <motion.div
            className={`
              max-w-2xl px-6 py-3 rounded-2xl shadow-2xl
              ${themeConfig.background} ${themeConfig.blur} ${themeConfig.border} border
            `}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <div className={`text-lg font-light text-center ${themeConfig.textColor}`}>
              {transcript}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default TranscriptOverlay;
