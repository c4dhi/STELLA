import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import HardwareFitPanel, { rangeText } from './HardwareFitPanel'
import type { HardwareFit, TtsPlaybackMode } from '../../lib/api-types'

const dev: HardwareFit = {
  colour: 'yellow',
  usualSessions: 2,
  ttsModel: 'qwen3',
  gpu: 'Tesla T4',
  windowDays: 14,
  greenUpTo: 1,
  yellowUpTo: 3,
  redFrom: 4,
  buckets: [
    { sessions: 1, sentences: 120, rtfP90: 0.7, switchedShare: 0, colour: 'green', source: 'live' },
    { sessions: 2, sentences: 300, rtfP90: 1.2, switchedShare: 0.4, colour: 'yellow', source: 'live' },
    { sessions: 3, sentences: 0, rtfP90: null, switchedShare: null, colour: 'yellow', source: 'load test' },
    { sessions: 4, sentences: 0, rtfP90: null, switchedShare: null, colour: 'red', source: 'load test' },
  ],
  sentencesSeen: 420,
  sentencesNeeded: 200,
}

const render = (fit: HardwareFit, mode: TtsPlaybackMode = 'auto') =>
  renderToStaticMarkup(<HardwareFitPanel fit={fit} mode={mode} isDark={false} />)

describe('HardwareFitPanel', () => {
  it('reads the headline at the usual load, naming the model and GPU', () => {
    const html = render(dev)
    expect(html).toContain('Sentence by sentence only')
    expect(html).toContain('at the usual 2 sessions at once')
    expect(html).toContain('qwen3 on Tesla T4')
  })

  it('says how many sessions at once each colour holds for', () => {
    expect(rangeText(dev)).toEqual([
      'Smooth streaming up to 1 session at once',
      'Sentence by sentence from 2 to 3 sessions',
      'Too slow from 4 sessions',
    ])
  })

  it('claims no red it has neither seen nor estimated', () => {
    expect(rangeText({ ...dev, yellowUpTo: 2, redFrom: null })).toEqual([
      'Smooth streaming up to 1 session at once',
      'Sentence by sentence at 2 sessions',
    ])
  })

  it('warns when Streaming is chosen on a server that cannot stream at its usual load', () => {
    expect(render(dev, 'stream')).toContain('can’t stream smoothly')
    expect(render(dev, 'auto')).not.toContain('can’t stream smoothly')
    expect(render({ ...dev, colour: 'green' }, 'stream')).not.toContain('can’t stream smoothly')
  })

  it('judges nothing below the minimum, and says how far along it is', () => {
    const html = render({ ...dev, colour: null, usualSessions: null, sentencesSeen: 37 })
    expect(html).toContain('Not enough data yet')
    expect(html).toContain('It needs 200 spoken sentences from real sessions; it has 37 so far.')
    expect(html).not.toContain('Too slow from')
  })

  it('leaves out the model and GPU when no load test recorded them', () => {
    const html = render({ ...dev, ttsModel: null, gpu: null })
    expect(html).toContain('How well the voice fits this server</p>')
    expect(html).not.toContain('qwen3')
  })

  it('always explains why yellow can linger after a busy spell', () => {
    expect(render(dev)).toContain('stays there until it ends')
  })
})
