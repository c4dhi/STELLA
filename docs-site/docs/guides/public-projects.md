---
sidebar_position: 6
title: "Public projects"
---

# Public projects

A public project hands out one link. Everyone who opens it gets their own session with an agent that is already set up, so you don't have to invite participants one by one.

## Setting one up

The public setup wizard asks the same questions as deploying an agent: the agent, its configuration and persona, and how it should run.

- **How it should run.** The wizard asks **How should it run?**, just like the deploy dialog does.
  - In plan mode, every participant's agent follows the plan you pick.
  - In companion mode, you choose which activities the agent may offer. Each participant's agent takes a copy of those activities when it starts. A plan you edit afterwards reaches the next participant, but not one who is already talking (see [Companion mode](../agents/stella-v2/companion-mode.md)).
  - Companion mode is offered only for agents that support it.
- **A welcome message (optional).** You can write up to 500 characters on the Welcome Message step. Every participant who joins through the link sees it on screen as "Message from the Organizer", after the terms and before the session starts. The agent doesn't read it out. To change or remove it later, use the public link dialog; leave the field empty for no message.
- **A maximum session length (optional).** If you set one, it applies to every session started from the link. Without one, link sessions have no time limit.

## Sharing the link

When the project is created, the "Public Project Created!" step shows the link with a **QR code** above it. The public link dialog shows the same QR code, so participants can scan it with a phone instead of typing the link.

## Deleting a public project

If you delete a project, its live sessions are closed first. A participant who is still in a call sees a **Conversation ended** screen within about a second, and their page stops reconnecting. They don't get a connection error, and the page doesn't keep loading.

## Over MCP

`projects_public_update` sets up the same things from an AI client: `mode` and `availablePlanIds` for a companion, and `welcomeMessage`. See the [MCP tool reference](../mcp/tools.md).
