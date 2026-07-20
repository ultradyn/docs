import {
  BookOpenText,
  ChevronRight,
  FileStack,
  GitBranch,
  Library,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router-dom";

import { useApi } from "../api-context.js";
import {
  Card,
  InlineNotice,
  PageHeader,
  StatusPill,
} from "../components/ui.js";
import { useDocumentTitle } from "../hooks.js";

export function IngestPage() {
  useDocumentTitle("Sources");
  const { runtime } = useApi();
  const maintenanceEnabled = runtime.maintenanceEnabled;

  return (
    <div className="ingest-page">
      <PageHeader
        eyebrow="Knowledge intake"
        title="Sources & ingest"
        description="Where Ultradyn Docs reads documentation today, and how automatic ingestion work surfaces when it exists."
      />

      <InlineNotice tone="info" title="No separate upload pipeline yet">
        <p>
          There is no browser form that imports an external corpus. The product
          answers from the documentation repository bound to this server, and
          maintenance tools watch operational source cursors when enabled.
        </p>
      </InlineNotice>

      <div className="ingest-grid">
        <Card className="ingest-card">
          <span className="guide-icon">
            <Library aria-hidden="true" size={22} />
          </span>
          <StatusPill tone="positive">Active today</StatusPill>
          <h2>Bound documentation repository</h2>
          <p>
            The Librarian indexes Markdown and related docs under the repository
            this server opened. Adding or editing files in that tree is how new
            material becomes answerable after the index refreshes.
          </p>
          <div className="ingest-repo">
            <GitBranch aria-hidden="true" size={15} />
            <code title={runtime.repoRoot}>{runtime.repoRoot}</code>
          </div>
          <p className="ingest-footnote">
            Automatic ingestion (source snapshots, units, evidence) is designed
            in-repo; it is not a complete first-class browser workflow yet.
          </p>
        </Card>

        <Card className="ingest-card">
          <span className="guide-icon">
            <FileStack aria-hidden="true" size={22} />
          </span>
          <StatusPill tone={maintenanceEnabled ? "info" : "warning"}>
            {maintenanceEnabled ? "Maintenance on" : "Maintenance off"}
          </StatusPill>
          <h2>Source cursors & maintainer tools</h2>
          <p>
            When maintenance mode is enabled, the Maintenance page shows durable
            source-cursor health, claimable review work, and agent definitions.
            That is the current operational surface for intake health—not a full
            import wizard.
          </p>
          {maintenanceEnabled ? (
            <Link
              className="button button-secondary"
              to="/maintenance"
              aria-label="Open Maintenance source tools"
            >
              <ShieldCheck aria-hidden="true" size={16} /> Open Maintenance{" "}
              <ChevronRight aria-hidden="true" size={15} />
            </Link>
          ) : (
            <Link
              className="button button-secondary"
              to="/settings"
              aria-label="Open Settings to enable maintenance"
            >
              <Settings aria-hidden="true" size={16} /> Enable in Settings{" "}
              <ChevronRight aria-hidden="true" size={15} />
            </Link>
          )}
          {!maintenanceEnabled ? (
            <p className="ingest-footnote">
              Search Settings for <strong>server.maintenance</strong> (or
              “maintenance”), turn it on, then restart Ultradyn Docs when the UI
              asks. The Maintenance nav item and source cursors appear after
              that.
            </p>
          ) : (
            <p className="ingest-footnote">
              On Maintenance → Operations, the Source cursors panel lists poll
              positions and health for configured backends.
            </p>
          )}
        </Card>

        <Card className="ingest-card">
          <span className="guide-icon">
            <BookOpenText aria-hidden="true" size={22} />
          </span>
          <StatusPill tone="neutral">Also useful</StatusPill>
          <h2>Ask after sources change</h2>
          <p>
            Once documentation is in the bound repo, return to Ask and pose a
            goal-bound question. Gaps become queue work for an answerer instead
            of inventing unsupported claims.
          </p>
          <div className="ingest-actions">
            <Link className="button button-primary" to="/ask">
              Ask the docs <ChevronRight aria-hidden="true" size={15} />
            </Link>
            <Link className="button button-quiet" to="/settings">
              Server & preferences
            </Link>
          </div>
        </Card>
      </div>

      <Card className="ingest-howto">
        <h2>How to get material into answers</h2>
        <ol>
          <li>
            Put or update documentation in the bound repository (
            <code>{runtime.repoRoot}</code>).
          </li>
          <li>
            Keep the Ultradyn Docs server pointed at that repository (Settings →
            Server URL / connection if you need another origin).
          </li>
          <li>
            Optionally enable <strong>server.maintenance</strong> to monitor
            source cursors and claimable maintainer work.
          </li>
          <li>
            Use <strong>Ask</strong> to verify the new material is discoverable;
            log gaps when it is not.
          </li>
        </ol>
        <div className="ingest-actions">
          {maintenanceEnabled ? (
            <Link className="button button-secondary" to="/maintenance">
              View source cursors
            </Link>
          ) : (
            <Link className="button button-secondary" to="/settings">
              Open Settings
            </Link>
          )}
        </div>
      </Card>
    </div>
  );
}
