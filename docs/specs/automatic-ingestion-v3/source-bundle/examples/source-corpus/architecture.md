# Architecture

## Components

The ingress API authenticates callers, validates event envelopes, and appends accepted events to the durable queue.

The endpoint registry stores destination URLs, enabled state, and delivery policy for each registered consumer.

Delivery workers lease queued events, resolve endpoint registrations, attempt delivery, and record outcomes.

## Ordering

Ordering is preserved only within a single endpoint registration. No global ordering is guaranteed across registrations.
