import { IconX } from "@tabler/icons-react";
import { StateQLWorkspace } from "./inspector";
import type { RuntimeStoreSnapshot } from "./runtime/event-store";

export function DatabasePanel({ live, onClose }: { live: RuntimeStoreSnapshot; onClose: () => void }) {
  return (
    <aside id="database-panel" className="inspector database-panel is-open" aria-labelledby="database-panel-title">
      <header className="inspector-header">
        <div><span className="section-kicker" id="database-panel-title">Database</span></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close database"><IconX size={17} /></button>
      </header>
      <p className="inspector-description">Shared StateQL workspace, durable results, and bounded command history.</p>
      <div className="inspector-scroll">
        <StateQLWorkspace live={live} />
      </div>
    </aside>
  );
}
