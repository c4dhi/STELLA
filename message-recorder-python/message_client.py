"""
HTTP client for communicating with the session management server.
Handles polling for active sessions and storing recorded messages.
"""
import aiohttp
import asyncio
from typing import List, Dict, Optional


class MessageClient:
    """HTTP client for session management server API"""

    def __init__(self, base_url: str, internal_key: Optional[str] = None):
        self.base_url = base_url.rstrip('/')
        self.session: Optional[aiohttp.ClientSession] = None
        # Sent to the backend's key-protected internal endpoints (#145).
        self.internal_key = internal_key

    def _internal_headers(self) -> Dict[str, str]:
        """Headers for internal endpoints that need the shared internal key."""
        return {'X-Internal-Key': self.internal_key} if self.internal_key else {}

    async def __aenter__(self):
        """Async context manager entry"""
        self.session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        if self.session:
            await self.session.close()

    async def get_active_sessions(self) -> List[Dict]:
        """
        Poll the API for active sessions.
        Returns list of sessions that need monitoring.
        """
        url = f"{self.base_url}/internal/active-sessions"

        try:
            # Create session if not exists (for non-context-manager usage)
            if not self.session:
                self.session = aiohttp.ClientSession()

            async with self.session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as response:
                if response.status == 200:
                    data = await response.json()
                    return data if isinstance(data, list) else []
                else:
                    print(f"⚠️  Failed to get active sessions: HTTP {response.status}")
                    return []

        except aiohttp.ClientError as e:
            print(f"❌ Network error getting active sessions: {e}")
            return []
        except asyncio.TimeoutError:
            print(f"⏱️  Timeout getting active sessions")
            return []
        except Exception as e:
            print(f"❌ Unexpected error getting active sessions: {e}")
            return []

    async def store_message(
        self,
        session_id: str,
        message_envelope: dict,
        participant_identity: Optional[str] = None,
        participant_name: Optional[str] = None
    ) -> bool:
        """
        Store a recorded message via the API.
        Returns True if successful, False otherwise.
        """
        url = f"{self.base_url}/internal/sessions/{session_id}/messages"

        payload = {
            'message': message_envelope,
            'participantIdentity': participant_identity,
            'participantName': participant_name
        }

        try:
            # Create session if not exists
            if not self.session:
                self.session = aiohttp.ClientSession()

            async with self.session.post(
                url,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as response:
                if response.status in (200, 201):
                    return True
                else:
                    error_text = await response.text()
                    print(f"⚠️  Failed to store message: HTTP {response.status}, {error_text}")
                    return False

        except aiohttp.ClientError as e:
            print(f"❌ Network error storing message: {e}")
            return False
        except asyncio.TimeoutError:
            print(f"⏱️  Timeout storing message")
            return False
        except Exception as e:
            print(f"❌ Unexpected error storing message: {e}")
            return False

    async def post_log(
        self,
        level: str,
        message: str,
        session_id: Optional[str] = None,
        data: Optional[dict] = None
    ) -> bool:
        """
        Post a log entry to the session management server.
        Logs are displayed in the monitoring dashboard.
        """
        url = f"{self.base_url}/internal/monitoring/logs"

        payload = {
            'level': level,
            'message': message,
        }
        if session_id:
            payload['sessionId'] = session_id
        if data:
            payload['data'] = data

        try:
            # Create session if not exists
            if not self.session:
                self.session = aiohttp.ClientSession()

            async with self.session.post(
                url,
                json=payload,
                headers=self._internal_headers(),
                timeout=aiohttp.ClientTimeout(total=5)
            ) as response:
                return response.status in (200, 201)

        except Exception:
            # Silently fail on log posting errors to avoid log spam
            return False

    async def update_monitoring_status(self, connected_session_ids: list) -> bool:
        """
        Update the monitoring status with currently connected sessions.
        This allows the dashboard to show real-time connection state.
        """
        url = f"{self.base_url}/internal/monitoring/status"

        payload = {
            'connectedSessions': connected_session_ids
        }

        try:
            # Create session if not exists
            if not self.session:
                self.session = aiohttp.ClientSession()

            async with self.session.post(
                url,
                json=payload,
                headers=self._internal_headers(),
                timeout=aiohttp.ClientTimeout(total=5)
            ) as response:
                return response.status in (200, 201)

        except Exception:
            # Silently fail to avoid disrupting main loop
            return False

    async def store_participant_event(
        self,
        session_id: str,
        event_type: str,
        participant_identity: str,
        participant_name: Optional[str] = None
    ) -> bool:
        """
        Store a participant join/leave event.
        This creates a message in the conversation timeline.
        """
        url = f"{self.base_url}/internal/sessions/{session_id}/participant-events"

        payload = {
            'eventType': event_type,  # 'joined' or 'left'
            'participantIdentity': participant_identity,
            'participantName': participant_name
        }

        try:
            # Create session if not exists
            if not self.session:
                self.session = aiohttp.ClientSession()

            async with self.session.post(
                url,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as response:
                if response.status in (200, 201):
                    return True
                else:
                    error_text = await response.text()
                    print(f"⚠️  Failed to store participant event: HTTP {response.status}, {error_text}")
                    return False

        except aiohttp.ClientError as e:
            print(f"❌ Network error storing participant event: {e}")
            return False
        except Exception as e:
            print(f"❌ Unexpected error storing participant event: {e}")
            return False

    async def get_rooms_to_join(self) -> List[Dict]:
        """
        Get rooms that the recorder should join (smart sync mode).
        Returns only sessions where recorderShouldJoin = true.

        Response format:
        [
            {
                "sessionId": "uuid",
                "roomName": "session-xxx",
                "hasHumanParticipant": true/false,
                "priority": "high" | "normal"
            }
        ]
        """
        url = f"{self.base_url}/internal/rooms-to-join"

        try:
            # Create session if not exists
            if not self.session:
                self.session = aiohttp.ClientSession()

            async with self.session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as response:
                if response.status == 200:
                    data = await response.json()
                    return data if isinstance(data, list) else []
                else:
                    print(f"⚠️  Failed to get rooms to join: HTTP {response.status}")
                    return []

        except aiohttp.ClientError as e:
            print(f"❌ Network error getting rooms to join: {e}")
            return []
        except asyncio.TimeoutError:
            print(f"⏱️  Timeout getting rooms to join")
            return []
        except Exception as e:
            print(f"❌ Unexpected error getting rooms to join: {e}")
            return []

    async def close(self):
        """Close the HTTP session"""
        if self.session:
            await self.session.close()
            self.session = None
