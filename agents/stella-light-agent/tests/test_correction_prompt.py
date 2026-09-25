"""The light agent must tell the model how to correct a collected answer (#406).

The state machine now rejects a change to a collected required deliverable
unless the write carries correction=true. If the default agent's prompt still
says "just update it", every genuine correction is silently refused.
"""

from stella_light_agent.prompts.light_prompt import LightPromptBuilder
from stella_agent_sdk.tools.state_machine.guidance import STATE_MACHINE_TOOL_GUIDANCE


def test_collected_section_explains_the_correction_flag():
    section = LightPromptBuilder()._build_collected_section({"user_name": "Felix"})
    assert "correction=true" in section
    assert "reasoning" in section
    assert "overwrite" not in section.lower()


def test_shared_guidance_explains_the_correction_flag():
    assert "correction" in STATE_MACHINE_TOOL_GUIDANCE
    assert "REJECTS" in STATE_MACHINE_TOOL_GUIDANCE
    assert "{key, value, reasoning, correction?}" in STATE_MACHINE_TOOL_GUIDANCE
