"""
Multi-room connection manager for LiveKit message recording.
Manages connections to multiple LiveKit rooms simultaneously.

Supports two sync modes:
- sync_rooms(): Legacy polling mode - joins all active sessions
- sync_rooms_smart(): Smart mode - only joins rooms where recorderShouldJoin=true
"""
import asyncio
import json
import os
from typing import Dict, List, Optional, Set
from livekit import rtc
from livekit.api import AccessToken, VideoGrants
from datetime import datetime


class RoomManager:
    """Manages connections to multiple LiveKit rooms"""

    def __init__(self, livekit_url: str, message_client):
        self.livekit_url = livekit_url
        self.message_client = message_client
        self.rooms: Dict[str, rtc.Room] = {}  # session_id -> Room instance
        self.api_key = os.getenv('LIVEKIT_API_KEY')
        self.api_secret = os.getenv('LIVEKIT_API_SECRET')

        if not self.api_key or not self.api_secret:
            raise ValueError("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set")

    async def sync_rooms(self, active_sessions: list):
        """
        Synchronize room connections with active sessions (legacy polling mode).
        Joins new rooms, leaves inactive ones.
        """
        active_session_ids = {s['id'] for s in active_sessions}
        current_session_ids = set(self.rooms.keys())

        # Join new rooms
        to_join = active_session_ids - current_session_ids
        for session_id in to_join:
            session = next(s for s in active_sessions if s['id'] == session_id)
            try:
                await self.join_room(session)
            except Exception as e:
                print(f"❌ Error joining room for session {session_id}: {e}")

        # Leave inactive rooms
        to_leave = current_session_ids - active_session_ids
        for session_id in to_leave:
            try:
                await self.leave_room(session_id)
            except Exception as e:
                print(f"❌ Error leaving room for session {session_id}: {e}")

        # Log current state
        print(f"📊 Managing {len(self.rooms)} rooms: {list(self.rooms.keys())}")

    async def sync_rooms_smart(self, rooms_to_join: list):
        """
        Smart sync: Only join rooms where recorderShouldJoin = true.
        Uses staggered joining to avoid CPU spikes on LiveKit server.

        Args:
            rooms_to_join: List of {sessionId, roomName, hasHumanParticipant, priority}
        """
        # Build set of session IDs that should have recorder
        target_session_ids = {r['sessionId'] for r in rooms_to_join}
        current_session_ids = set(self.rooms.keys())

        # Determine rooms to join and leave
        to_join_ids = target_session_ids - current_session_ids
        to_leave_ids = current_session_ids - target_session_ids

        # Leave rooms that no longer need recorder
        for session_id in to_leave_ids:
            try:
                await self.leave_room(session_id)
            except Exception as e:
                print(f"❌ Error leaving room for session {session_id}: {e}")

        # Get rooms to join with their data
        rooms_to_join_list = [r for r in rooms_to_join if r['sessionId'] in to_join_ids]

        # Sort by priority (high priority first)
        rooms_to_join_list.sort(key=lambda r: 0 if r.get('priority') == 'high' else 1)

        # Staggered joining
        if rooms_to_join_list:
            await self._staggered_join(rooms_to_join_list)

        # Log current state
        print(f"📊 Smart sync: {len(self.rooms)} rooms active, {len(to_join_ids)} joined, {len(to_leave_ids)} left")

    async def _staggered_join(self, rooms_to_join: list, max_per_second: int = 5):
        """
        Join rooms with rate limiting to avoid CPU spikes.
        Joins max_per_second rooms per second.
        """
        for i, room_info in enumerate(rooms_to_join):
            # Rate limit: pause every max_per_second rooms
            if i > 0 and i % max_per_second == 0:
                print(f"⏳ Staggered join: pausing after {i} rooms...")
                await asyncio.sleep(1)

            # Convert smart sync format to session format for join_room
            session_data = {
                'id': room_info['sessionId'],
                'room': {
                    'livekitRoomName': room_info['roomName']
                }
            }

            try:
                await self.join_room(session_data)
            except Exception as e:
                print(f"❌ Error joining room {room_info['roomName']}: {e}")

    async def join_room(self, session: dict):
        """Connect to a LiveKit room for the given session"""
        session_id = session['id']
        room_name = session['room']['livekitRoomName']

        print(f"🔌 Connecting to room: {room_name} (session: {session_id})")

        # Create new room instance
        room = rtc.Room()

        # Set up event handlers for this room
        self._setup_event_handlers(room, session_id, room_name)

        # Generate access token
        token = await self._generate_token(room_name)

        # Connect to the room
        await room.connect(self.livekit_url, token)

        # Store room reference
        self.rooms[session_id] = room

        print(f"✅ Connected to room: {room_name} (session: {session_id})")

        # Log to dashboard
        await self.message_client.post_log(
            'log',
            f'Connected to room {room_name}',
            session_id=session_id
        )

    async def leave_room(self, session_id: str):
        """Disconnect from a room"""
        room = self.rooms.pop(session_id, None)
        if room:
            try:
                await room.disconnect()
                print(f"👋 Disconnected from session: {session_id}")
            except Exception as e:
                print(f"⚠️  Error disconnecting from session {session_id}: {e}")

    def _setup_event_handlers(self, room: rtc.Room, session_id: str, room_name: str):
        """Set up event handlers for a room"""

        @room.on("connected")
        def on_connected():
            print(f"🟢 Room connected: {room_name}")

        @room.on("disconnected")
        def on_disconnected(reason):
            print(f"🔴 Room disconnected: {room_name}, reason: {reason}")

        @room.on("participant_connected")
        def on_participant_connected(participant: rtc.RemoteParticipant):
            # Skip logging for the monitor itself
            if participant.identity == "message-recorder":
                return
            print(f"👤 Participant joined {room_name}: {participant.identity} ({participant.name})")

            # Store join event to conversation timeline
            asyncio.create_task(
                self.message_client.store_participant_event(
                    session_id,
                    'joined',
                    participant.identity,
                    participant.name
                )
            )

        @room.on("participant_disconnected")
        def on_participant_disconnected(participant: rtc.RemoteParticipant):
            if participant.identity == "message-recorder":
                return
            print(f"👋 Participant left {room_name}: {participant.identity}")

            # Store leave event to conversation timeline
            asyncio.create_task(
                self.message_client.store_participant_event(
                    session_id,
                    'left',
                    participant.identity,
                    participant.name
                )
            )

        @room.on("data_received")
        def on_data_received(data_packet: rtc.DataPacket):
            """Handle incoming data messages - THIS IS THE CORE RECORDING LOGIC"""
            # Process in background task to not block event handler
            asyncio.create_task(
                self._handle_data_message(session_id, room_name, data_packet)
            )

    async def _handle_data_message(self, session_id: str, room_name: str, data_packet: rtc.DataPacket):
        """
        Process and selectively store data messages.

        FILTERING LOGIC:
        - Only store final messages (is_final=true), not partial/streaming ones
        - For user_text: Only store the ORIGINAL from the human user, not echoes from agents
        - For transcripts (user_speech): Only store final transcripts, not partials
        - For agent_text: Only store final responses, not streaming chunks
        - For debug messages: Store all (for transparency)
        - Skip audio streaming, TTS control, and other control messages
        """
        try:
            # Decode the message
            message_text = data_packet.data.decode('utf-8')
            envelope = json.loads(message_text)

            # Get packet participant info (who actually sent the LiveKit packet)
            packet_participant_identity = None
            packet_participant_name = None
            if data_packet.participant:
                packet_participant_identity = data_packet.participant.identity
                packet_participant_name = data_packet.participant.name

            # Extract message details
            message_type = envelope.get('type', 'unknown')
            message_data = envelope.get('data', {})

            # Handle both flat and nested data structures
            if isinstance(message_data, str):
                # For user_text, data is just the text string
                is_final = True  # user_text from frontend is always final
            else:
                is_final = message_data.get('is_final', True)

            # Get envelope's participant_id (logical sender for attribution)
            envelope_participant_id = envelope.get('participant_id')
            data_source = message_data.get('source') if isinstance(message_data, dict) else None

            # SKIP: Audio streaming messages (too noisy, not needed for replay)
            if message_type in ('audio_stream_start', 'audio_stream_chunk', 'audio_stream_stop', 'audio_stream_mute'):
                return

            # SKIP: TTS control messages (not needed for replay)
            if message_type in ('tts_start', 'tts_stop', 'tts_end', 'tts_pause', 'tts_resume', 'tts_paused', 'tts_resumed'):
                return

            # SKIP: Barge-in and control messages
            if message_type in ('barge_in', 'voice_narration_control', 'heartbeat'):
                return

            # Log message for debugging (skip audio chunks)
            print(f"📨 Message in {room_name}: type={message_type}, from={packet_participant_identity}, is_final={is_final}")

            # === FILTERING LOGIC ===
            should_store = False

            # Extract speaker info from nested data (for transcripts sent by agent)
            nested_speaker_id = message_data.get('speaker_id') if isinstance(message_data, dict) else None
            nested_speaker_name = message_data.get('speaker_name') if isinstance(message_data, dict) else None
            nested_participant_id = message_data.get('participant_id') if isinstance(message_data, dict) else None

            # Determine participant identity for storage
            # Priority: envelope.participant_id > nested speaker_id > packet identity
            participant_identity = envelope_participant_id or nested_speaker_id or nested_participant_id or packet_participant_identity

            # Determine participant display name for storage
            # Priority: nested speaker_name > envelope.participant_id > packet name
            participant_name = nested_speaker_name or envelope_participant_id or packet_participant_name

            # Debug logging for attribution
            if message_type in ('transcript', 'transcript_chunk', 'user_text'):
                print(f"   📋 Attribution: identity={participant_identity}, name={participant_name}, nested_speaker={nested_speaker_name}")

            if message_type == 'user_text':
                # STORE: User text from any non-agent identity
                # Original user_text comes from 'human' (organizer) OR 'participant-xxx' identities
                # Echoed versions come from agent identities (starting with 'agent-')
                is_agent_identity = packet_participant_identity and packet_participant_identity.startswith('agent-')
                if not is_agent_identity:
                    should_store = True
                    print(f"   ✅ Storing original user_text from {packet_participant_identity}")
                else:
                    print(f"   ⏭️ Skipping echoed user_text from agent {packet_participant_identity}")

            elif message_type in ('transcript', 'transcript_chunk'):
                # STORE: Only final transcripts, skip partial ones
                # BUT: Skip agent echoes of user_text messages (sent by agents with source='user_text')
                if is_final:
                    # Check if this is an agent echoing a user_text message
                    # Agents have identities starting with 'agent-' or other non-human prefixes
                    is_agent_sender = packet_participant_identity and packet_participant_identity != 'human'
                    is_user_text_echo = data_source == 'user_text' and is_agent_sender

                    if is_user_text_echo:
                        print(f"   ⏭️ Skipping agent echo of user_text from {packet_participant_identity}")
                    else:
                        should_store = True
                        print(f"   ✅ Storing final transcript (source={data_source}, from={packet_participant_identity})")
                else:
                    print(f"   ⏭️ Skipping partial transcript")

            elif message_type == 'agent_text':
                # STORE: Only final agent responses, skip streaming chunks
                if is_final:
                    should_store = True
                    print(f"   ✅ Storing final agent_text")
                else:
                    print(f"   ⏭️ Skipping partial agent_text chunk")

            elif message_type == 'debug':
                # STORE: All debug messages for transparency
                should_store = True
                print(f"   ✅ Storing debug message")

            elif message_type in ('decision_stream', 'expert_status', 'prompt_execution', 'safety_check'):
                # STORE: Processing/decision messages (for replay of debug view)
                should_store = True
                print(f"   ✅ Storing processing message: {message_type}")

            elif message_type == 'analytics':
                # STORE: Analytics timing measurements (for per-stage latency aggregation)
                should_store = True
                print(f"   ✅ Storing analytics message")

            elif message_type in ('complete_todo_list', 'plan_progress_update', 'plan_deliverable_update', 'state_change_notification', 'progress_update'):
                # STORE: Task and plan updates (for task panel replay)
                # Includes both stella-v1 (complete_todo_list, plan_progress_update) and
                # stella-v2 SDK format (progress_update) for historical replay and time machine
                should_store = True
                print(f"   ✅ Storing task/plan message: {message_type}")

            elif message_type == 'turn_language':
                # STORE: a user turn's language signal (#91). The backend merges
                # it into that turn's transcript message rather than adding a row.
                should_store = True
                print(f"   ✅ Forwarding turn_language")

            elif message_type == 'llm_config':
                # STORE: LLM configuration for session context
                should_store = True
                print(f"   ✅ Storing llm_config")

            else:
                # SKIP: Unknown message types by default
                print(f"   ⏭️ Skipping unknown message type: {message_type}")

            # Store the message if it passes the filter
            if should_store:
                await self.message_client.store_message(
                    session_id=session_id,
                    message_envelope=envelope,
                    participant_identity=participant_identity,
                    participant_name=participant_name
                )

                # Log to dashboard for monitoring
                if message_type in ('transcript', 'transcript_chunk') and is_final:
                    await self.message_client.post_log(
                        'debug',
                        f'Recorded final transcript from {participant_identity or "unknown"}',
                        session_id=session_id,
                        data={'type': message_type, 'source': data_source}
                    )

        except json.JSONDecodeError as e:
            print(f"⚠️  Invalid JSON in message from {room_name}: {e}")
            await self.message_client.post_log(
                'warn',
                f'Invalid JSON in data message: {str(e)}',
                session_id=session_id
            )
        except Exception as e:
            print(f"❌ Error handling message from {room_name}: {e}")
            await self.message_client.post_log(
                'error',
                f'Error handling message: {str(e)}',
                session_id=session_id
            )

    async def _generate_token(self, room_name: str) -> str:
        """Generate a JWT token for joining a room"""
        token = (
            AccessToken(self.api_key, self.api_secret)
            .with_identity("message-recorder")
            .with_name("Message Recorder")
            .with_grants(VideoGrants(room_join=True, room=room_name))
        )
        return token.to_jwt()

    async def disconnect_all(self):
        """Disconnect from all rooms (cleanup on shutdown)"""
        print("🔌 Disconnecting from all rooms...")
        disconnect_tasks = [self.leave_room(sid) for sid in list(self.rooms.keys())]
        await asyncio.gather(*disconnect_tasks, return_exceptions=True)
        print("✅ All rooms disconnected")
