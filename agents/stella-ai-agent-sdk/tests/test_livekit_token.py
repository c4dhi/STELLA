"""An uploaded agent joins with a token the backend signed, not the secret (issue 856)."""

import jwt
import pytest

from stella_agent_sdk.livekit.room import RoomManager, livekit_credentials_from_env


def test_a_given_token_is_used_as_is_without_any_secret():
    room = RoomManager("ws://localhost:7880", token="backend.signed.token")
    assert room.token_for("room-a", "agent-x", "Agent") == "backend.signed.token"


def test_without_a_token_it_signs_its_own_for_the_room_as_before():
    room = RoomManager("ws://localhost:7880", "key", "secret-0123456789abcdef0123456789")
    token = room.token_for("room-a", "agent-x", "Agent")
    claims = jwt.decode(token, "secret-0123456789abcdef0123456789", algorithms=["HS256"])
    assert claims["iss"] == "key"
    assert claims["sub"] == "agent-x"
    assert claims["name"] == "Agent"
    assert claims["video"]["room"] == "room-a"


def test_it_refuses_to_start_with_neither_token_nor_key_and_secret():
    with pytest.raises(ValueError, match="LIVEKIT_TOKEN"):
        RoomManager("ws://localhost:7880")


def test_env_with_a_token_needs_no_key_or_secret():
    creds = livekit_credentials_from_env({"LIVEKIT_TOKEN": "t"})
    assert creds == {"api_key": None, "api_secret": None, "token": "t"}


def test_env_with_a_token_ignores_a_key_and_secret_that_are_also_set():
    creds = livekit_credentials_from_env(
        {"LIVEKIT_TOKEN": "t", "LIVEKIT_API_KEY": "k", "LIVEKIT_API_SECRET": "s"}
    )
    assert creds == {"api_key": None, "api_secret": None, "token": "t"}


def test_env_without_a_token_uses_key_and_secret():
    creds = livekit_credentials_from_env({"LIVEKIT_API_KEY": "k", "LIVEKIT_API_SECRET": "s"})
    assert creds == {"api_key": "k", "api_secret": "s", "token": None}
