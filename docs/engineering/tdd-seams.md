# Agreed TDD seams

The product request explicitly requires TDD and names the following observable boundaries. Tests may use public interfaces at these seams; they must not reach into private helpers.

| Seam                  | Observable behavior                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| CLI process           | Arguments/stdin produce stable screens, exit codes, and a usable target directory.                                   |
| Scaffold filesystem   | A destination is created transactionally, existing files are preserved, and the result is a valid Git repository.    |
| Knowledge repository  | Commands create/read/list/transition records and regenerate identical committed projections.                         |
| Raw artifact store    | First writes persist bytes durably; later mutation/deletion is rejected.                                             |
| HTTP/SSE API          | Requests, responses, status codes, and event streams implement the documented contract.                              |
| Provider contract     | A capability reports availability/consent, streams typed events, and can be swapped for its deterministic fake.      |
| Agent runtime         | Definition inputs yield schema-valid outputs and evaluator calls receive only their permitted context.               |
| Audio session         | Ordered chunks are acknowledged durably; finalize verifies/transcodes before raw cleanup and exposes failure states. |
| Web routes            | A user can complete Ask, Queue, Answer, Settings, and conditional Maintenance flows through accessible controls.     |
| Maintenance scheduler | Poll inputs plus durable cursors yield idempotent local review tasks and re-review invalidation.                     |
| Change request        | A documentation proposal exposes an actual diff, checks, approval mode, and local/GitHub backend state.              |
| Desktop launcher      | Tauri starts or connects to the same server contract and opens the bundled UI.                                       |

External APIs, OS keyrings/credential clients, clocks, randomness, microphones, codecs, process execution, and GitHub are system boundaries and may be replaced by explicit fakes. Internal modules are not mocked.

Production consumers import the explicit surfaces in each directory's `index.ts`. Server tests that exercise deterministic implementation seams such as matching, retrieval, scheduling, or agent-output adapters import `code/server/testing.ts`; that module is test-only and must not be imported by production code.
