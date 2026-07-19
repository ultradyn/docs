// Graph mutation gateway — production surface only.
// In-memory seam factories are testing-only; import from ./graph-gateway.js.
export {
  GRAPH_GATEWAY_LIMITS,
  GraphGatewayCommandSchema,
  createGraphGateway,
  type GraphCommitStore,
  type GraphGateway,
  type GraphGatewayCommand,
  type GraphGatewayDeps,
  type GraphGatewayError,
  type GraphGatewayHooks,
  type GeneratedQuestionPort,
  type GeneratedWordingStore,
} from "./graph-gateway.js";

// T-23-02 — dependency graph / SCCs (exports resolve once GREEN lands).
export {
  projectDependencyGraph,
  type DependencyGraph,
  type DependencyRelation,
  type StrongComponent,
} from "./dependency-graph.js";

// T-23-03 — invalidation propagation (plan + publishable gate).
export {
  assertPublishable,
  createInvalidationService,
  type ArtifactClass,
  type ClassifiedArtifact,
  type InvalidationError,
  type InvalidationEvent,
  type InvalidationPlan,
  type InvalidationService,
} from "./invalidation-service.js";
