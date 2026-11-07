---
sidebar_position: 5
title: Streaming
description: Real-time audio streaming in STELLA agents
---

# Streaming

STELLA agents work with real-time audio streams for both input (STT) and output (TTS). This guide covers audio handling, streaming patterns, and optimization.

## Audio Pipeline

```
User Microphone ──▶ WebRTC ──▶ Agent ──▶ STT ──▶ Text
                                                    │
                                                    ▼
User Speakers ◀── WebRTC ◀── Agent ◀── TTS ◀── LLM Response
```

## Input Streaming (STT)

### Continuous Recognition

The AudioPipeline processes incoming audio continuously:

```python
from stella_agent_sdk import BaseAgent, AudioPipeline


class MyAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.pipeline = AudioPipeline(
            stt_provider="sherpa",
            stt_model="sherpa-onnx-streaming-zipformer"
        )

    async def on_transcript(self, text: str, is_final: bool):
        # Interim results (while user is speaking)
        if not is_final:
            await self.send_transcript(text, speaker="user", is_final=False)
            return

        # Final result (user finished speaking)
        await self.send_transcript(text, speaker="user", is_final=True)
        await self.process_input(text)
```

### Voice Activity Detection (VAD)

VAD determines when the user starts and stops speaking:

```python
self.pipeline = AudioPipeline(
    stt_provider="sherpa",
    vad_enabled=True,
    vad_threshold=0.5,         # Sensitivity (0-1)
    vad_min_silence_ms=500,    # Silence to end utterance
    vad_min_speech_ms=250      # Minimum speech duration
)
```

### Audio Frame Processing

For advanced use cases, access raw audio frames:

```python
async def on_audio_frame(self, frame: AudioFrame):
    """Process raw audio frames."""
    # frame.data: bytes (PCM audio)
    # frame.sample_rate: int (usually 48000)
    # frame.num_channels: int (usually 1)
    # frame.samples_per_channel: int

    # Custom processing
    processed = self.custom_processor(frame.data)

    # Or pass to custom STT
    self.stt_buffer.append(frame.data)
```

## Output Streaming (TTS)

### Streaming TTS

Generate and play audio as it's produced:

```python
async def speak(self, text: str):
    """Stream TTS output."""
    # Notify frontend
    await self.send_status("speaking")
    await self.send_transcript(text, speaker="assistant")

    # Stream audio chunks as they're generated
    async for chunk in self.pipeline.text_to_speech_stream(text):
        await self.publish_audio(chunk)

    # Done speaking
    await self.send_status("listening")
```

### Sentence-by-Sentence Streaming

For long responses, stream sentence by sentence:

```python
async def speak_sentences(self, text: str):
    """Stream TTS by sentence for lower latency."""
    sentences = self.split_sentences(text)

    for i, sentence in enumerate(sentences):
        # Start TTS for this sentence
        async for chunk in self.pipeline.text_to_speech_stream(sentence):
            await self.publish_audio(chunk)

        # Small pause between sentences
        if i < len(sentences) - 1:
            await asyncio.sleep(0.1)

def split_sentences(self, text: str) -> list[str]:
    """Split text into sentences."""
    import re
    return re.split(r'(?<=[.!?])\s+', text)
```

### LLM Streaming with TTS

Stream LLM output directly to TTS:

```python
async def stream_response(self, user_input: str):
    """Stream LLM response with real-time TTS."""
    await self.send_status("thinking")

    # Buffer for collecting text
    text_buffer = ""
    full_response = ""

    # Stream from LLM
    stream = await self.openai.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": user_input}
        ],
        stream=True
    )

    await self.send_status("speaking")

    async for chunk in stream:
        if chunk.choices[0].delta.content:
            text = chunk.choices[0].delta.content
            text_buffer += text
            full_response += text

            # Check for sentence boundary
            if self.has_sentence_end(text_buffer):
                sentence, text_buffer = self.extract_sentence(text_buffer)

                # Stream TTS for the sentence
                async for audio in self.pipeline.text_to_speech_stream(sentence):
                    await self.publish_audio(audio)

    # Handle remaining text
    if text_buffer.strip():
        async for audio in self.pipeline.text_to_speech_stream(text_buffer):
            await self.publish_audio(audio)

    # Send final transcript
    await self.send_transcript(full_response, speaker="assistant")
    await self.send_status("listening")
```

## Audio Formats

### Input Audio

| Property | Value |
|----------|-------|
| Codec | Opus |
| Sample Rate | 48000 Hz |
| Channels | Mono (1) |
| Bit Depth | 16-bit |

### Output Audio

```python
# Configure TTS output format
self.pipeline = AudioPipeline(
    tts_provider="kokoro",
    tts_sample_rate=24000,   # Sample rate
    tts_format="pcm_s16le",  # 16-bit PCM
)
```

## Interruption Handling

Handle user interruption (barge-in):

```python
class MyAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.is_speaking = False
        self.tts_task = None

    async def speak(self, text: str):
        self.is_speaking = True
        self.tts_task = asyncio.current_task()

        try:
            async for chunk in self.pipeline.text_to_speech_stream(text):
                await self.publish_audio(chunk)
        except asyncio.CancelledError:
            # Interrupted
            pass
        finally:
            self.is_speaking = False
            self.tts_task = None

    async def on_data_message(self, message: dict):
        if message.get("type") == "control":
            if message["data"]["action"] == "interrupt":
                await self.handle_interrupt()

    async def handle_interrupt(self):
        """Handle user interruption."""
        if self.is_speaking and self.tts_task:
            self.tts_task.cancel()
            await self.pipeline.cancel_tts()
            await self.send_status("listening")

    async def on_transcript(self, text: str, is_final: bool):
        # Auto-interrupt when user starts speaking
        if self.is_speaking and is_final:
            await self.handle_interrupt()

        # Process input
        if is_final:
            await self.process_input(text)
```

## Latency Optimization

### Reduce STT Latency

```python
# Use streaming STT model
self.pipeline = AudioPipeline(
    stt_provider="sherpa",
    stt_model="sherpa-onnx-streaming-zipformer",  # Streaming model
    stt_chunk_size=160,  # Smaller chunks = lower latency
)
```

### Reduce TTS Latency

```python
# Start speaking before LLM completes
async def low_latency_response(self, user_input: str):
    # Start with acknowledgment
    await self.speak_quick("Let me check that for you.")

    # Then generate full response
    response = await self.generate_response(user_input)
    await self.speak(response)

async def speak_quick(self, text: str):
    """Quick acknowledgment with minimal latency."""
    # Use faster TTS settings
    async for chunk in self.pipeline.text_to_speech_stream(
        text,
        speed=1.1  # Slightly faster
    ):
        await self.publish_audio(chunk)
```

### Prefetch Common Responses

```python
class MyAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.audio_cache = {}

    async def prefetch_audio(self):
        """Pre-generate common responses."""
        common_phrases = [
            "I understand. Let me help you with that.",
            "Could you please clarify?",
            "One moment please.",
        ]

        for phrase in common_phrases:
            audio_data = await self.pipeline.text_to_speech(phrase)
            self.audio_cache[phrase] = audio_data

    async def speak_cached(self, text: str):
        """Use cached audio if available."""
        if text in self.audio_cache:
            await self.publish_audio(self.audio_cache[text])
        else:
            await self.speak(text)
```

## Metrics and Monitoring

```python
import time

class MyAgent(BaseAgent):
    async def on_transcript(self, text: str, is_final: bool):
        if is_final:
            start_time = time.time()

            # Generate response
            response = await self.generate_response(text)

            llm_latency = time.time() - start_time

            # Speak response
            tts_start = time.time()
            await self.speak(response)
            tts_latency = time.time() - tts_start

            # Log metrics
            self.logger.info(
                "Response metrics",
                llm_latency_ms=llm_latency * 1000,
                tts_latency_ms=tts_latency * 1000,
                response_length=len(response)
            )
```

## Next Steps

- [Base Agent](./base-agent.md) - Full API reference
- [Tools](./tools.md) - Building custom tools
- [Data Flow](../architecture/data-flow.md) - System data flow
