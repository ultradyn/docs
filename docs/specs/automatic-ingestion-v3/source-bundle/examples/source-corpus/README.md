# Acorn Relay

Acorn Relay is an internal webhook relay for services that need durable, controlled delivery to registered HTTP endpoints.

The service accepts events through an ingress API, stores them in a durable queue, and uses delivery workers to send them to endpoint registrations.

Acorn Relay is intended for internal service-to-service event delivery. It is not a general public message broker.
