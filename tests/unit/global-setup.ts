import fs from "node:fs";
import type { TestProject } from "vitest/node";
import { runDataDir } from "./helpers/data-dir.js";

/** Creates the per-run DATA_DIR before any worker starts and removes it afterwards. */
export default function setup(project: TestProject): () => void {
  const configured = project.config.env?.DATA_DIR;
  const dir = typeof configured === "string" && configured.trim() !== "" ? configured : runDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
