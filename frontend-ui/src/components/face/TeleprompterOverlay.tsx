/**
 * TeleprompterOverlay Component (#241)
 *
 * Karaoke-style display of the agent's spoken response: the full generated
 * text appears dimmed and each word lights up to full color exactly as it is
 * spoken. Driven by `agent_speech_progress` envelopes from the SDK, which carry
 * a byte-accurate playhead translated into a character offset (`spokenChar`).
 *
 * Word-level granularity: the cursor advances by character but words snap to
 * three states — already spoken (full), currently speaking (full + accent),
 * upcoming (dimmed). On barge-in the SDK freezes `spokenChar` at the exact
 * interruption point, so the highlight stops precisely where the audio did.
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { VisualizerType } from './types';
import { TranscriptThemeConfig } from './TranscriptOverlay';
import SpokenText from './SpokenText';

const THEME_CONFIGS: Record<VisualizerType, TranscriptThemeConfig> = {
  text: { background: 'bg-black/40', border: 'border-white/10', textColor: 'text-white', blur: 'backdrop-blur-md' },
  face: { background: 'bg-black/40', border: 'border-white/10', textColor: 'text-white', blur: 'backdrop-blur-md' },
  sphere: { background: 'bg-slate-900/50', border: 'border-violet-500/20', textColor: 'text-white', blur: 'backdrop-blur-md' },
  galaxy: { background: 'bg-indigo-950/50', border: 'border-purple-500/20', textColor: 'text-white', blur: 'backdrop-blur-md' },
  rainy: { background: 'bg-slate-800/60', border: 'border-slate-500/20', textColor: 'text-slate-100', blur: 'backdrop-blur-md' },
  snowy: { background: 'bg-white/30', border: 'border-slate-300/30', textColor: 'text-slate-900', blur: 'backdrop-blur-md' },
  christmas: { background: 'bg-slate-900/50', border: 'border-yellow-500/20', textColor: 'text-white', blur: 'backdrop-blur-md' },
  sunny: { background: 'bg-sky-900/30', border: 'border-sky-400/20', textColor: 'text-white', blur: 'backdrop-blur-md' },
};

interface TeleprompterOverlayProps {
  /** Full agent response text (the dimmed backdrop). */
  text?: string;
  /** Absolute character offset spoken so far; words up to here are lit. */
  spokenChar?: number;
  /** Theme for styling (matches the visualizer). */
  theme?: VisualizerType;
  /** Position from bottom. */
  bottomOffset?: string;
  /** Visibility toggle (honors the subtitle button). */
  isVisible?: boolean;
}

const TeleprompterOverlay: React.FC<TeleprompterOverlayProps> = ({
  text,
  spokenChar = 0,
  theme = 'face',
  bottomOffset = 'bottom-24',
  isVisible = true,
}) => {
  const themeConfig = THEME_CONFIGS[theme] ?? THEME_CONFIGS.face;
  const hasText = Boolean(text?.trim());
  const shouldShow = isVisible && hasText;

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
          <div
            className={`
              max-w-2xl px-6 py-3 rounded-2xl shadow-2xl
              ${themeConfig.background} ${themeConfig.blur} ${themeConfig.border} border
            `}
          >
            <div className={`text-lg font-light text-center leading-relaxed ${themeConfig.textColor}`}>
              <SpokenText text={text ?? ''} spokenChar={spokenChar} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default TeleprompterOverlay;
