import { StateQLWorkspace } from "./inspector";
import type { RuntimeStoreSnapshot } from "./runtime/event-store";

export function DatabasePanel({
  live,
  onClose,
}: {
  live: RuntimeStoreSnapshot;
  onClose: () => void;
}) {
  return (
    <aside
      id="database-panel"
      className="inspector database-panel is-open"
      aria-labelledby="database-panel-title"
    >
      <StateQLWorkspace live={live} onClose={onClose} />
    </aside>
  );
}
