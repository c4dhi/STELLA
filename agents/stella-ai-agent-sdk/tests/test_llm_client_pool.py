"""LangChain clients are pooled per config shape.

LangChain gives every ChatOpenAI its own httpx pool, so building one per call
threw away the warm TLS connection to the API each time. Measured from the prod
host, 5 paired runs against gpt-4o-mini: a fresh client per call had a median
time-to-first-token of 481ms against 417ms for a pooled one — 64ms. Small per
call, but a turn makes roughly eight of them (six experts, arbitration, bridge,
response), all on the critical path.
"""

import pytest

from stella_agent_sdk.llm.service import LLMConfig, OpenAILangChainProvider


class FakeChatOpenAI:
    instances = 0

    def __init__(self, **kwargs):
        FakeChatOpenAI.instances += 1
        self.kwargs = kwargs
        self.streaming = kwargs.get("streaming")


@pytest.fixture
def provider():
    FakeChatOpenAI.instances = 0
    p = OpenAILangChainProvider()
    p.available = True
    p.ChatOpenAI = FakeChatOpenAI
    p._clients = {}
    return p


def _cfg(**kw):
    return LLMConfig(**{"model": "gpt-4o-mini", "temperature": 0.4, **kw})


def test_the_same_shape_reuses_one_client(provider):
    a = provider._get_client(_cfg(), streaming=True)
    b = provider._get_client(_cfg(), streaming=True)
    assert a is b
    assert FakeChatOpenAI.instances == 1


def test_streaming_is_part_of_the_key(provider):
    """The two call paths used to flip `client.streaming` on the object they had
    just built. Harmless while each call owned its client; a race the moment
    they share one, since six experts run concurrently on the same turn."""
    streamed = provider._get_client(_cfg(), streaming=True)
    plain = provider._get_client(_cfg(), streaming=False)
    assert streamed is not plain
    assert streamed.kwargs["streaming"] is True
    assert plain.kwargs["streaming"] is False


def test_a_different_config_gets_its_own_client(provider):
    a = provider._get_client(_cfg(temperature=0.4), streaming=True)
    b = provider._get_client(_cfg(temperature=0.9), streaming=True)
    assert a is not b
    assert FakeChatOpenAI.instances == 2


def test_the_pool_cannot_grow_without_bound(provider):
    for i in range(provider._MAX_POOLED_CLIENTS + 5):
        provider._get_client(_cfg(temperature=i / 100), streaming=True)
    assert len(provider._clients) <= provider._MAX_POOLED_CLIENTS


def test_an_unavailable_provider_still_refuses(provider):
    provider.available = False
    with pytest.raises(RuntimeError):
        provider._get_client(_cfg(), streaming=True)
