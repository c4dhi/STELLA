/**
 * VisualizerRenderer
 * Shared component for rendering visualizers across different views
 * Eliminates duplication between StellaFaceModal and ParticipantSessionView
 */

import React from 'react';
import { motion } from 'framer-motion';
import StellaFace from './StellaFace';
import SphereVisualizer from './visualizers/SphereVisualizer';
import WeatherVisualizer from './visualizers/WeatherVisualizer';
import type { VisualizerType, VisualizerProps } from './types';

interface VisualizerRendererProps extends VisualizerProps {
  type: VisualizerType;
}

const VisualizerRenderer: React.FC<VisualizerRendererProps> = ({
  type,
  audioLevel,
  isRemoteSpeaking,
  isUserSpeaking = false,
}) => {
  switch (type) {
    case 'face':
      return (
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          {/* No emotion props: StellaFace derives them from the live emotion
              cue (#face-emotions), falling back to exactly these resting values
              when there is no cue. Passing them here would pin the face and
              override every cue. */}
          <StellaFace
            isUserSpeaking={isUserSpeaking}
            isRemoteSpeaking={isRemoteSpeaking}
            audioLevel={audioLevel}
          />
        </motion.div>
      );

    case 'sphere':
      return (
        <SphereVisualizer
          audioLevel={audioLevel}
          isRemoteSpeaking={isRemoteSpeaking}
        />
      );

    case 'galaxy':
    case 'rainy':
    case 'snowy':
    case 'christmas':
    case 'sunny':
      return (
        <WeatherVisualizer
          theme={type}
          audioLevel={audioLevel}
          isRemoteSpeaking={isRemoteSpeaking}
        />
      );

    default:
      return null;
  }
};

export default VisualizerRenderer;
