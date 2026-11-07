/**
 * VisualizerPreview
 * Shared component for rendering visualizer thumbnails
 * Used by VisualizerGallery and InviteParticipantModal
 */

import React, { useMemo } from 'react';
import type { VisualizerType } from './types';

interface VisualizerPreviewProps {
  type: VisualizerType;
  size?: 'sm' | 'md';  // sm for modal buttons, md for gallery cards
}

// Generate preview particles (memoized per component instance)
const generatePreviewStars = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    top: Math.random() * 100,
    opacity: Math.random() * 0.7 + 0.3,
  }));

const generatePreviewRain = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i,
    left: 10 + Math.random() * 80,
    top: Math.random() * 80,
  }));

const generatePreviewSnow = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    top: Math.random() * 80,
    size: Math.random() * 3 + 2,
  }));

const generatePreviewBokeh = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    top: Math.random() * 100,
    size: Math.random() * 15 + 8,
    color: ['#dc2626', '#fbbf24', '#22c55e'][Math.floor(Math.random() * 3)],
    opacity: Math.random() * 0.5 + 0.3,
  }));

const VisualizerPreview: React.FC<VisualizerPreviewProps> = ({ type, size = 'md' }) => {
  const isSmall = size === 'sm';

  // Memoize particles - fewer for small size
  const previewStars = useMemo(() => generatePreviewStars(isSmall ? 5 : 15), [isSmall]);
  const previewRain = useMemo(() => generatePreviewRain(isSmall ? 4 : 8), [isSmall]);
  const previewSnow = useMemo(() => generatePreviewSnow(isSmall ? 5 : 10), [isSmall]);
  const previewBokeh = useMemo(() => generatePreviewBokeh(isSmall ? 3 : 6), [isSmall]);

  // Size configs
  const faceSize = isSmall ? 'w-8 h-8' : 'w-16 h-16';
  const eyeSize = isSmall ? 'w-2 h-2' : 'w-4 h-4';
  const eyeTop = isSmall ? 'top-2' : 'top-4';
  const eyeLeft = isSmall ? 'left-1' : 'left-2';
  const eyeRight = isSmall ? 'right-1' : 'right-2';
  const mouthWidth = isSmall ? 'w-3' : 'w-6';
  const mouthHeight = isSmall ? 'h-1' : 'h-2';
  const mouthBottom = isSmall ? 'bottom-1' : 'bottom-3';

  const sphereSize = isSmall ? 'w-8 h-8' : 'w-16 h-16';

  switch (type) {
    case 'text':
      return (
        <div className={`absolute inset-x-0 top-0 flex flex-col ${isSmall ? 'gap-1 p-2' : 'gap-1.5 px-4 py-3'}`}>
          <div className={`${isSmall ? 'h-1.5' : 'h-3.5'} w-[62%] rounded-lg rounded-bl-sm bg-primary-300`} />
          <div className={`${isSmall ? 'h-1.5' : 'h-3.5'} w-[46%] self-end rounded-lg rounded-br-sm bg-primary-500`} />
          <div className={`${isSmall ? 'h-1.5' : 'h-3.5'} w-[54%] rounded-lg rounded-bl-sm bg-primary-300`} />
        </div>
      );

    case 'face':
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={`relative ${faceSize}`}>
            {/* Eyes */}
            <div className={`absolute ${eyeTop} ${eyeLeft} ${eyeSize} bg-white rounded-full`} />
            <div className={`absolute ${eyeTop} ${eyeRight} ${eyeSize} bg-white rounded-full`} />
            {/* Mouth */}
            <div className={`absolute ${mouthBottom} left-1/2 -translate-x-1/2 ${mouthWidth} ${mouthHeight} border-b-2 border-white/60 rounded-b-full`} />
          </div>
        </div>
      );

    case 'sphere':
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className={`${sphereSize} rounded-full`}
            style={{
              background: 'radial-gradient(circle at 30% 30%, rgba(124, 58, 237, 0.8) 0%, transparent 50%), radial-gradient(circle at 70% 60%, rgba(6, 182, 212, 0.6) 0%, transparent 40%), radial-gradient(circle at 50% 50%, rgba(20, 20, 40, 1) 0%, rgba(10, 10, 20, 1) 100%)',
              boxShadow: isSmall ? '0 0 10px rgba(124, 58, 237, 0.5)' : '0 0 20px rgba(124, 58, 237, 0.5), 0 0 40px rgba(6, 182, 212, 0.3)',
            }}
          />
        </div>
      );

    case 'galaxy':
      return (
        <>
          {previewStars.map((star) => (
            <div
              key={star.id}
              className="absolute bg-white rounded-full"
              style={{
                width: '2px',
                height: '2px',
                left: `${star.left}%`,
                top: `${star.top}%`,
                opacity: star.opacity,
              }}
            />
          ))}
        </>
      );

    case 'rainy':
      return (
        <>
          {previewRain.map((drop) => (
            <div
              key={drop.id}
              className="absolute w-px h-3 bg-white/40"
              style={{
                left: `${drop.left}%`,
                top: `${drop.top}%`,
              }}
            />
          ))}
        </>
      );

    case 'snowy':
      return (
        <>
          {previewSnow.map((flake) => (
            <div
              key={flake.id}
              className="absolute bg-white rounded-full"
              style={{
                width: `${flake.size}px`,
                height: `${flake.size}px`,
                left: `${flake.left}%`,
                top: `${flake.top}%`,
                opacity: 0.7,
              }}
            />
          ))}
          <div className="absolute bottom-0 left-0 right-0 h-3 bg-gradient-to-t from-white/80 to-transparent" />
        </>
      );

    case 'christmas':
      return (
        <>
          {previewBokeh.map((light) => (
            <div
              key={light.id}
              className="absolute rounded-full blur-sm"
              style={{
                width: `${light.size}px`,
                height: `${light.size}px`,
                left: `${light.left}%`,
                top: `${light.top}%`,
                backgroundColor: light.color,
                opacity: light.opacity,
                boxShadow: `0 0 ${light.size}px ${light.color}`,
              }}
            />
          ))}
        </>
      );

    case 'sunny':
      return (
        <div className={`absolute ${isSmall ? 'top-1/4 left-1/2 -translate-x-1/2' : 'top-1/4 left-1/2 -translate-x-1/2'}`}>
          {/* Sun rays preview */}
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className="absolute w-0.5 bg-gradient-to-b from-yellow-200/60 to-transparent"
              style={{
                height: isSmall ? '15px' : '30px',
                transformOrigin: 'top center',
                transform: `rotate(${i * 45}deg)`,
                left: '0',
                top: '0',
              }}
            />
          ))}
          {/* Sun circle */}
          <div
            className={`absolute ${isSmall ? 'w-3 h-3' : 'w-6 h-6'} rounded-full bg-yellow-300 -translate-x-1/2 -translate-y-1/2 blur-sm opacity-80`}
          />
        </div>
      );

    default:
      return <div className={`${isSmall ? 'w-8 h-8' : 'w-16 h-16'} rounded-full bg-white/20`} />;
  }
};

export default VisualizerPreview;
