/**
 * Visualizer Gallery
 * Slide-out panel for selecting different visualizer themes
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check } from 'lucide-react';
import { VisualizerType, VISUALIZER_CONFIGS } from './types';
import VisualizerPreview from './VisualizerPreview';

interface VisualizerGalleryProps {
  isOpen: boolean;
  onClose: () => void;
  currentVisualizer: VisualizerType;
  onSelect: (visualizer: VisualizerType) => void;
  /** Faces this view cannot show (the organizer's preview has no Text face). */
  exclude?: VisualizerType[];
}

const VisualizerGallery: React.FC<VisualizerGalleryProps> = ({
  isOpen,
  onClose,
  currentVisualizer,
  onSelect,
  exclude = [],
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/30 z-30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            className="absolute top-0 right-0 h-full w-80 bg-black/80 backdrop-blur-md border-l border-white/10 z-40 overflow-y-auto"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          >
            <div className="p-6 flex flex-col gap-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <h3 className="text-white text-xl font-light">Visualizers</h3>
                <button
                  onClick={onClose}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-white" />
                </button>
              </div>

              {/* Visualizer Cards */}
              <div className="flex flex-col gap-3">
                {VISUALIZER_CONFIGS.filter((config) => !exclude.includes(config.id)).map((config) => (
                  <button
                    key={config.id}
                    onClick={() => {
                      onSelect(config.id);
                      onClose();
                    }}
                    className={`relative w-full h-28 rounded-lg overflow-hidden border-2 transition-all duration-300 ${
                      currentVisualizer === config.id
                        ? `border-white/60 scale-[1.02]`
                        : 'border-white/20 hover:border-white/40'
                    }`}
                  >
                    {/* Background */}
                    <div className={`absolute inset-0 ${config.previewBg}`}>
                      <VisualizerPreview type={config.id} size="md" />
                    </div>

                    {/* Label */}
                    <div className={`absolute bottom-2 left-3 text-sm font-light ${
                      config.id === 'snowy' || config.id === 'sunny' ? 'text-slate-700' : 'text-white'
                    }`}>
                      {config.name}
                    </div>

                    {/* Selected indicator */}
                    {currentVisualizer === config.id && (
                      <div className={`absolute top-2 right-2 w-6 h-6 ${config.checkmarkColor} rounded-full flex items-center justify-center`}>
                        <Check className="w-4 h-4 text-white" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default VisualizerGallery;
