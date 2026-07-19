// Graph mutation gateway — production surface only.
// createInMemoryGraphGatewayStores is testing-only; import from module path.
export {
  GRAPH_GATEWAY_LIMITS,
  GraphGatewayCommandSchema,
  createGraphGateway,
  type GraphGateway,
  type GraphGatewayCommand,
  type GraphGatewayError,
  type GraphGatewayHooks,
  type GraphGatewayOptions,
  type GraphGatewayStores,
} from "./graph-gateway.js";
