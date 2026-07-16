import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { EmptyState } from "../components/ui.js";
import { useDocumentTitle } from "../hooks.js";

export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <div className="narrow-page">
      <EmptyState
        title="That page isn’t here"
        description="The link may point to a question that moved, or a maintenance page that is disabled."
        action={
          <Link className="button button-primary" to="/ask">
            <ArrowLeft aria-hidden="true" size={16} /> Return to Ask
          </Link>
        }
      />
    </div>
  );
}
