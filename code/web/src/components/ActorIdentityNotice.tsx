import { Link } from "react-router-dom";

import { useActorIdentity } from "../api-context.js";
import { InlineNotice } from "./ui.js";

export function ActorIdentityNotice({ waitingFor }: { waitingFor?: string }) {
  const identity = useActorIdentity();
  const mismatch = identity.status === "configured" && waitingFor;
  const title = mismatch
    ? `This answer is waiting for ${waitingFor}`
    : identity.status === "loading"
      ? "Loading actor identity"
      : identity.status === "error"
        ? "Actor identity unavailable"
        : "Set your actor handle";
  const explanation = mismatch
    ? `Your configured handle is ${identity.handle}. Only a matching pending asker can accept or reject this answer.`
    : identity.status === "loading"
      ? "Attributed actions remain unavailable until your personal settings load."
      : identity.status === "error"
        ? `${identity.message} Attributed actions remain unavailable.`
        : "Claims, priority overrides, and approvals need a stable personal handle. The handle records attribution; it does not authenticate you.";

  return (
    <InlineNotice tone="warning" title={title}>
      <p>{explanation}</p>
      <Link className="button button-secondary" to="/settings">
        Open Settings
      </Link>
    </InlineNotice>
  );
}
