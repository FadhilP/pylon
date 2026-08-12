import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLineEditTools } from "../src/line-edit.ts";

export default registerLineEditTools satisfies (pi: ExtensionAPI) => void;
