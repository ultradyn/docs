# Ingress API

## Authentication

Callers authenticate with a service token. The token must include the `relay.publish` scope for the target project.

Requests with a missing token receive HTTP 401. Requests with an invalid scope receive HTTP 403.
