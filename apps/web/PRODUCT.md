# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Self-hosted CodeBridge maintainers manage their own local instance. Channel participants use conversations and approve scoped actions through their messaging channel.

## Product Purpose

Connect local agents and explicitly registered tasks to messaging channels, with simple configuration and observable execution and delivery.

## Operating Context

The first management surface stays local to the host. This management version retains this model without adding a Web login system. Existing agent and session workflows remain available.

## Capabilities and Constraints

Two management entries: Channels and Tasks. Combine identities, access and credentials under Channels; combine existing local plans, notification destinations and alerts under Tasks. Reuse current executors and macOS launchd; do not add a general workflow designer or template platform. Preserve existing alert operation and external SKILL.md packages with references and scripts. Secrets, real identities and business definitions stay outside Git.

## Brand Commitments

Preserve the existing CodeBridge name, assets, paper/carbon themes and semantic design tokens. This is an extension of the current workbench.

## Product Principles

- Keep the path from configuration to execution and result short.
- Default to existing behavior and preserve running tasks.
- Separate task execution from message delivery; retrying delivery must not repeat business actions.
- Verify authorization using the actual channel identity and explicit scope.
- Never describe an unverified or source-only feature as a published capability.
