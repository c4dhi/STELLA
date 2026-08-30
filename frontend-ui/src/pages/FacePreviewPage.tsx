/**
 * Face preview (#face-emotions).
 *
 * A public page for looking at every expression and gesture side by side,
 * without needing a session, an agent, or a working microphone. The face is
 * driven by cues that normally arrive over the wire mid-sentence, which makes
 * it nearly impossible to judge a shape while it is happening — and impossible
 * to compare two of them.
 *
 * Deliberately unauthenticated and read-only: it writes the same store fields a
 * live cue would, and nothing else.
 */

import React, { useEffect, useState } from 'react'
import StellaFace from '../components/face/StellaFace'
import { EXPRESSIONS, GESTURES, STATES } from '../components/face/animations/emotionRegistry'
import { useStore } from '../store'

const EXPRESSION_TAGS = Object.keys(EXPRESSIONS)
const GESTURE_TAGS = Object.keys(GESTURES)

export default function FacePreviewPage() {
  const setFaceExpression = useStore(s => s.setFaceExpression)
  const triggerFaceGesture = useStore(s => s.triggerFaceGesture)
  const triggerFaceState = useStore(s => s.triggerFaceState)
  const active = useStore(s => s.faceExpression)

  const [speaking, setSpeaking] = useState(false)
  const [listening, setListening] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  // Sleep on a 3s fuse instead of 30, ignoring the camera — otherwise judging
  // the animation means sitting out of shot for half a minute and then coming
  // back to tap, which is not a loop anyone can iterate on.
  const [fastSleep, setFastSleep] = useState(false)

  // Fake a voice so the speaking mouths can be judged. The real mouth is driven
  // by RMS off the agent's track; this stands in for it.
  useEffect(() => {
    if (!speaking) {
      setAudioLevel(0)
      return
    }
    let raf = 0
    const tick = () => {
      const t = Date.now() / 1000
      const syllable = Math.abs(Math.sin(t * 6.5)) * (0.6 + 0.4 * Math.sin(t * 2.1))
      setAudioLevel(Math.max(0, syllable))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [speaking])

  useEffect(() => () => setFaceExpression(null), [setFaceExpression])

  const btn = (on: boolean) =>
    `px-3 py-2 rounded-lg text-sm font-light transition-colors border ${
      on
        ? 'bg-violet-500/30 border-violet-400 text-white'
        : 'bg-white/5 border-white/10 text-white/70 hover:border-white/30'
    }`

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <div className="flex-1 flex items-center justify-center">
        <StellaFace
          size={520}
          isUserSpeaking={listening}
          isRemoteSpeaking={speaking}
          audioLevel={audioLevel}
          sleep={fastSleep ? { afterMs: 3000, force: true } : undefined}
        />
      </div>

      <div className="p-6 space-y-4 border-t border-white/10 bg-black/60">
        <div>
          <div className="text-xs uppercase tracking-wider text-white/40 mb-2">
            Expressions — held until the next one
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={btn(active === null)} onClick={() => setFaceExpression(null)}>
              (rest)
            </button>
            {EXPRESSION_TAGS.map(tag => (
              <button key={tag} className={btn(active === tag)} onClick={() => setFaceExpression(tag)}>
                {tag}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wider text-white/40 mb-2">
            Gestures — play once over the expression, then hand it back
          </div>
          <div className="flex flex-wrap gap-2">
            {GESTURE_TAGS.map(tag => (
              <button key={tag} className={btn(false)} onClick={() => triggerFaceGesture(tag)}>
                {tag}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wider text-white/40 mb-2">
            States — the agent commands these and the face stays changed
          </div>
          <div className="flex flex-wrap gap-2">
            {STATES.map(tag => (
              <button key={tag} className={btn(false)} onClick={() => triggerFaceState(tag)}>
                {tag}
              </button>
            ))}
            <span className="text-xs text-white/40 self-center">
              What the LLM writes as [sleep]. Waits for her to stop speaking, then she goes under
              — tap the face to bring her back.
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button className={btn(speaking)} onClick={() => setSpeaking(s => !s)}>
            {speaking ? '◼ stop speaking' : '▶ agent speaking'}
          </button>
          <button className={btn(listening)} onClick={() => setListening(l => !l)}>
            {listening ? '◼ stop listening' : '▶ user speaking'}
          </button>
          <span className="text-xs text-white/40">
            Expressions must stay legible while the mouth is moving. "User speaking" adds the
            backchannel nods, which arrive every few seconds and are deliberately irregular.
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button className={btn(fastSleep)} onClick={() => setFastSleep(s => !s)}>
            {fastSleep ? '◼ stop sleep test' : '💤 sleep after 3s'}
          </button>
          <span className="text-xs text-white/40">
            In production she nods off after 30s with nobody in front of the camera, and releases
            the camera when she does. Click or tap the face to wake her — the wake animation runs
            long because it is covering the camera restarting.
          </span>
        </div>
      </div>
    </div>
  )
}
