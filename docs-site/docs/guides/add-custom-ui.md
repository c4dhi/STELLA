---
sidebar_position: 3
title: Custom Agent Visualizers
description: Create custom visual representations for your STELLA AI assistant
---

import {Steps, Step} from '@site/src/components/StepGuide';

# Custom Agent Visualizers

STELLA's visual interface is driven by **visualizers** - animated components that represent the AI assistant. Users can select from multiple visualizers in a gallery, and you can contribute your own custom visualizers to the system.

## What are Visualizers?

Visualizers are the animated "face" of the AI assistant. They respond to:
- **Audio levels** - Pulse, glow, or animate based on speech volume
- **Speaking state** - Change appearance when the assistant is speaking vs listening

Built-in visualizers include animated faces, glowing orbs, and themed particle effects (galaxy, weather, etc.). The visualizer gallery lets users switch between them in real-time.

One entry in the gallery is not an animation: the **Text face** (`text`) replaces the whole screen with the written conversation and puts the agent in text mode. `VisualizerRenderer` draws nothing for it; the participant screen shows `TextFace` instead. See [Text sessions](./text-sessions.md).

## Architecture Overview

All visualizer code lives in the frontend:

```text
frontend-ui/src/components/face/
├── types.ts                    # Type definitions and registry
├── VisualizerRenderer.tsx      # Component dispatcher (switch statement)
├── VisualizerGallery.tsx       # Selection UI panel
├── VisualizerPreview.tsx       # Gallery thumbnail previews
├── hooks/                      # Shared animation hooks
│   ├── useFaceAnimation.ts
│   ├── useFaceTracking.ts
│   └── useMouthAnimation.ts
└── visualizers/                # Individual visualizer implementations
    ├── SphereVisualizer.tsx
    ├── WeatherVisualizer.tsx
    ├── AudioReactiveSiriOrb.tsx
    ├── SiriOrb.tsx
    └── useResponsiveSphereSize.ts
```

## Core Interfaces

All visualizers implement the same interface defined in `types.ts`:

```typescript title="types.ts"
// Standard props all visualizers receive
export interface VisualizerProps {
  audioLevel: number;        // 0.0 to 1.0 - current speech volume
  isRemoteSpeaking: boolean; // true when assistant is speaking
  isUserSpeaking?: boolean;  // true when user is speaking
}

// Registered visualizer types
export type VisualizerType =
  | 'face'
  | 'sphere'
  | 'galaxy'
  | 'rainy'
  | 'snowy'
  | 'christmas'
  | 'sunny';

// Configuration for gallery display
export interface VisualizerConfig {
  id: VisualizerType;
  name: string;           // Display name in gallery
  description: string;    // Short description
  previewBg: string;      // Tailwind background class for preview
  checkmarkColor: string; // Selection indicator color
}
```

## Adding a Custom Visualizer

<Steps>

<Step number={1} title="Add the type definition">

In `types.ts`, add your visualizer ID to the `VisualizerType` union:

```typescript title="types.ts"
export type VisualizerType =
  | 'face'
  | 'sphere'
  | 'galaxy'
  | 'rainy'
  | 'snowy'
  | 'christmas'
  | 'sunny'
  | 'pulse'; // Your new visualizer
```

</Step>

<Step number={2} title="Register the configuration">

Add an entry to the `VISUALIZER_CONFIGS` array in `types.ts`:

```typescript title="types.ts"
export const VISUALIZER_CONFIGS: VisualizerConfig[] = [
  // ... existing configs ...
  {
    id: 'pulse',
    name: 'Pulse',
    description: 'Pulsing rings',
    previewBg: 'bg-gradient-to-br from-rose-950 via-pink-900 to-rose-800',
    checkmarkColor: 'bg-rose-400',
  },
];
```

</Step>

<Step number={3} title="Create the visualizer component">

Create your visualizer in `visualizers/PulseVisualizer.tsx`:

```tsx title="visualizers/PulseVisualizer.tsx"
import React, { useEffect, useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { useResponsiveSphereSize } from './useResponsiveSphereSize';

interface PulseVisualizerProps {
  audioLevel?: number;
  isRemoteSpeaking?: boolean;
}

const PulseVisualizer: React.FC<PulseVisualizerProps> = ({
  audioLevel = 0,
  isRemoteSpeaking = false,
}) => {
  const size = useResponsiveSphereSize(150, 300, 0.35);

  // Smooth the audio level for fluid animations
  const [smoothedAudio, setSmoothedAudio] = useState(0);
  const audioRef = useRef(audioLevel);
  audioRef.current = audioLevel;

  useEffect(() => {
    let animationId: number;

    const animate = () => {
      setSmoothedAudio(prev => {
        const target = audioRef.current;
        const factor = target > prev ? 0.3 : 0.1; // Fast attack, slow decay
        return prev + (target - prev) * factor;
      });
      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, []);

  const ringCount = 3;
  const baseScale = 1 + smoothedAudio * 0.3;

  return (
    <div className="relative w-full h-full flex items-center justify-center bg-gradient-to-br from-rose-950 via-pink-900 to-rose-800">
      {/* Concentric rings */}
      {Array.from({ length: ringCount }).map((_, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full border-2 border-rose-400/40"
          style={{ width: size, height: size }}
          animate={{
            scale: baseScale + i * 0.2,
            opacity: isRemoteSpeaking ? 0.8 - i * 0.2 : 0.3 - i * 0.1,
          }}
          transition={{ duration: 0.15 }}
        />
      ))}

      {/* Center dot */}
      <motion.div
        className="rounded-full bg-rose-400"
        style={{ width: size * 0.15, height: size * 0.15 }}
        animate={{
          scale: 1 + smoothedAudio * 0.5,
          boxShadow: isRemoteSpeaking
            ? `0 0 ${30 + smoothedAudio * 40}px rgba(251, 113, 133, 0.6)`
            : '0 0 20px rgba(251, 113, 133, 0.3)',
        }}
        transition={{ duration: 0.1 }}
      />
    </div>
  );
};

export default PulseVisualizer;
```

</Step>

<Step number={4} title="Register in the renderer">

Add your visualizer to the switch statement in `VisualizerRenderer.tsx`:

```tsx title="VisualizerRenderer.tsx"
import PulseVisualizer from './visualizers/PulseVisualizer';

// Inside the switch statement:
case 'pulse':
  return (
    <PulseVisualizer
      audioLevel={audioLevel}
      isRemoteSpeaking={isRemoteSpeaking}
    />
  );
```

</Step>

<Step number={5} title="Add the gallery preview" isLast>

Add a preview case in `VisualizerPreview.tsx` for the gallery thumbnail:

```tsx title="VisualizerPreview.tsx"
case 'pulse':
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {/* Concentric rings preview */}
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="absolute rounded-full border border-rose-400/50"
          style={{
            width: `${(isSmall ? 20 : 40) + i * (isSmall ? 8 : 16)}px`,
            height: `${(isSmall ? 20 : 40) + i * (isSmall ? 8 : 16)}px`,
          }}
        />
      ))}
      {/* Center dot */}
      <div className={`rounded-full bg-rose-400 ${isSmall ? 'w-2 h-2' : 'w-4 h-4'}`} />
    </div>
  );
```

</Step>

</Steps>

## Best Practices

### Audio Reactivity

Smooth your audio levels to avoid jittery animations:

```typescript
// Fast attack (0.3-0.4), slow decay (0.1-0.2) feels natural
const factor = target > current ? 0.35 : 0.12;
const smoothed = current + (target - current) * factor;
```

For speaking state, add a hold time to prevent flickering:

```typescript
// Hold speaking state for 500-800ms after speech stops
const SPEAKING_HOLD_MS = 600;

useEffect(() => {
  if (isRemoteSpeaking) {
    setIsSpeakingHeld(true);
    clearTimeout(timeoutRef.current);
  } else {
    timeoutRef.current = setTimeout(() => {
      setIsSpeakingHeld(false);
    }, SPEAKING_HOLD_MS);
  }
}, [isRemoteSpeaking]);
```

### Performance

- Use CSS transforms (`scale3d`, `translateZ(0)`) for GPU acceleration
- Set `willChange: 'transform'` for frequently animated properties
- Use `requestAnimationFrame` for smooth continuous animations
- Memoize expensive calculations with `useMemo`

### Responsive Sizing

Use the `useResponsiveSphereSize` hook to maintain proportions across screen sizes:

```typescript
import { useResponsiveSphereSize } from './useResponsiveSphereSize';

// Parameters: minSize, maxSize, ratio (of viewport min dimension)
const size = useResponsiveSphereSize(200, 400, 0.38);
```

### Using AudioReactiveSiriOrb

For orb-style visualizers, extend the `AudioReactiveSiriOrb` component:

```tsx
import AudioReactiveSiriOrb, { SIRI_ORB_THEMES } from './AudioReactiveSiriOrb';

// Add a custom theme
const MY_THEME = {
  bg: "oklch(12% 0.02 280)",
  c1: "oklch(55% 0.25 295)", // Primary color
  c2: "oklch(65% 0.18 230)", // Secondary color
  c3: "oklch(70% 0.15 200)", // Accent color
};

// Use in your visualizer
<AudioReactiveSiriOrb
  theme="sphere"  // or pass custom colors
  size={sphereSize}
  audioLevel={audioLevel}
  isRemoteSpeaking={isRemoteSpeaking}
/>
```

## Existing Visualizers Reference

| Visualizer | Description | Key Features |
|------------|-------------|--------------|
| `StellaFace` | Animated SVG face | Eye tracking, mouth animation, emotions |
| `SphereVisualizer` | Glowing gradient orb | Audio-reactive glow and scale |
| `WeatherVisualizer` | Themed particle effects | Galaxy stars, rain, snow, sun rays |

Review these implementations in `frontend-ui/src/components/face/` for inspiration.

## Next Steps

- [LiveKit Integration](../integration/livekit.md) - How audio data flows to visualizers
- [Architecture Overview](../architecture/overview.md) - System architecture
